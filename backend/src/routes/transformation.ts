import { Router } from 'express';
import { config } from '../config.js';
import { extractPerPageText } from '../pdf/split.js';
import { buildTransformDocument, serializeTransformDocument, type TransformFormat } from '../pdf/transform.js';
import { getAllTasks, registerFile, resolveActiveFile, updateFileStatus, type TaskGraphNode } from '../uwbe-client/endpoints.js';
import { putRawBytes } from '../uwbe-client/http.js';
import { withUniqueSuffix } from '../lib/unique-filename.js';

export const transformationRouter = Router();

interface TransformBody {
  projectId: number;
  projectCode: string;
  workflowCode: string;
  taskId: number;
  jobId: number;
  batchId: number;
  fileId: number;
  fileName: string;
  format: TransformFormat;
  userId?: number;
}

function findTaskUid(tasks: TaskGraphNode[], taskCode: string): string | undefined {
  return tasks.find((t) => t.code === taskCode)?.task_uid;
}

/**
 * New task, brought in-house per direct user decision (2026-08-15) — see
 * README.md's "Transformation" section for the deliberate deviation from
 * FLUID_APP_DEV_CONTEXT.md §1/§6.4/§9.2/§13#5, which state RAG transformation
 * is owned by a separate app. Converts one already-split chapter file's PDF
 * text into structured XML or JSON (one chunk per page — see pdf/transform.ts
 * for why not paragraph-level), then routes the result to the qualification
 * task (config.batchSplit.qualificationTaskCode, resolved dynamically like
 * every other cross-task hop in this app) for a second review pass.
 */
transformationRouter.post('/transform', async (req, res) => {
  const body = req.body as TransformBody;

  const taskGraph = await getAllTasks({ projectCode: body.projectCode, workflowCode: body.workflowCode });
  if (!taskGraph.ok || !taskGraph.data) {
    res.status(502).json({ ok: false, error: taskGraph.error ?? 'get-all-tasks failed' });
    return;
  }
  const currentTask = taskGraph.data.find((t) => t.id === body.taskId);
  if (!currentTask) {
    res.status(502).json({ ok: false, error: `no task with id ${body.taskId} found in the workflow graph` });
    return;
  }

  const fileContext = await resolveActiveFile({
    projectId: body.projectId,
    projectCode: body.projectCode,
    taskId: body.taskId,
    taskUid: currentTask.task_uid,
    fileId: body.fileId,
    jobId: body.jobId,
  });
  if (!fileContext.ok || !fileContext.data) {
    res.status(404).json({ ok: false, error: fileContext.error ?? 'could not resolve the chapter file context' });
    return;
  }

  const downloadUrl = fileContext.data.input_download_url;
  if (!downloadUrl) {
    res.status(502).json({ ok: false, error: 'could not resolve an input_download_url for this chapter file' });
    return;
  }

  const meta = (fileContext.data.meta_data ?? {}) as {
    parent_file_id?: number;
    split_index?: number;
    chapter_title?: string;
  };

  const qualificationTaskUid = findTaskUid(taskGraph.data, config.batchSplit.qualificationTaskCode);
  if (!qualificationTaskUid) {
    res.status(502).json({
      ok: false,
      error: `no task with code "${config.batchSplit.qualificationTaskCode}" found in the workflow graph`,
    });
    return;
  }

  // Complete this (Transformation) task — mirrors batch-split.ts's "complete parent" step.
  const completion = await updateFileStatus({
    projectCode: body.projectCode,
    taskUid: currentTask.task_uid,
    fileId: body.fileId,
    previousFileStatus: 'I',
    fileStatus: 'C',
    userId: body.userId,
  });
  if (!completion.ok) {
    res.status(502).json({ ok: false, error: completion.error ?? 'update-file-status failed for the chapter file' });
    return;
  }

  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    res.status(502).json({ ok: false, error: `failed to download chapter file: HTTP ${fileResponse.status}` });
    return;
  }
  const pdfBytes = Buffer.from(await fileResponse.arrayBuffer());

  const pages = await extractPerPageText(pdfBytes);
  const doc = buildTransformDocument(pages, {
    sourceFileId: body.fileId,
    parentFileId: meta.parent_file_id ?? null,
    splitIndex: meta.split_index ?? null,
    chapterTitle: meta.chapter_title ?? null,
  });
  const serialized = serializeTransformDocument(doc, body.format);
  const contentType = body.format === 'xml' ? 'application/xml' : 'application/json';

  const outputFileName = withUniqueSuffix(`${body.fileName.replace(/\.pdf$/i, '')}.${body.format}`);

  const registered = await registerFile({
    projectCode: body.projectCode,
    jobId: body.jobId,
    batchId: body.batchId,
    firstTaskUid: qualificationTaskUid,
    fileName: outputFileName,
    metaData: {
      parent_file_id: body.fileId,
      ...(meta.split_index !== undefined ? { split_index: meta.split_index } : {}),
      ...(meta.chapter_title ? { chapter_title: meta.chapter_title } : {}),
      content_format: body.format,
    },
    userId: body.userId,
  });
  if (!registered.ok || !registered.data) {
    res.status(502).json({ ok: false, error: registered.error ?? 'register-file failed for the transformed output' });
    return;
  }
  if (!registered.data.file_output_upload_url) {
    res.status(502).json({
      ok: false,
      error: 'register-file for the transformed output returned no upload URL — check the qualification task\'s upload_to_storage flag',
    });
    return;
  }
  try {
    await putRawBytes(registered.data.file_output_upload_url, Buffer.from(serialized, 'utf-8'), contentType);
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'upload failed' });
    return;
  }

  // Same two-hop release as batch-split.ts's children — don't pre-own this file
  // for whoever works qualification next; surface it through that task's own
  // unclaimed-files queue instead.
  const releaseToHold = await updateFileStatus({
    projectCode: body.projectCode,
    taskUid: qualificationTaskUid,
    fileId: registered.data.file_id,
    previousFileStatus: 'I',
    fileStatus: 'O',
    onholdReason: 'Released from auto-claim after transformation — queued for assignment.',
    userId: body.userId,
  });
  if (!releaseToHold.ok) {
    res.status(502).json({ ok: false, error: releaseToHold.error ?? 'failed to release the transformed output to on-hold' });
    return;
  }
  const releaseToQueue = await updateFileStatus({
    projectCode: body.projectCode,
    taskUid: qualificationTaskUid,
    fileId: registered.data.file_id,
    previousFileStatus: 'O',
    fileStatus: 'Y',
    userId: body.userId,
  });
  if (!releaseToQueue.ok) {
    res.status(502).json({ ok: false, error: releaseToQueue.error ?? 'failed to release the transformed output to the unclaimed queue' });
    return;
  }

  res.json({
    ok: true,
    data: {
      fileId: registered.data.file_id,
      taskUid: qualificationTaskUid,
      format: body.format,
      pageCount: doc.page_count,
    },
  });
});
