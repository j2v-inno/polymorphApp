import { Router } from 'express';
import { config } from '../config.js';
import { splitPdf, type SplitMethod } from '../pdf/split.js';
import { getAllTasks, registerFile, resolveActiveFile, updateFileStatus, type TaskGraphNode } from '../uwbe-client/endpoints.js';
import { putRawBytes } from '../uwbe-client/http.js';

export const batchSplitRouter = Router();

interface SplitBody {
  projectId: number;
  projectCode: string;
  workflowCode: string;
  taskId: number;
  jobId: number;
  batchId: number;
  fileId: number;
  fileName: string;
  userId?: number;
  /** Defaults to 'equal-pages' (the original §6.3 behavior) when omitted. */
  splitMethod?: SplitMethod;
}

function findTaskUid(tasks: TaskGraphNode[], taskCode: string): string | undefined {
  return tasks.find((t) => t.code === taskCode)?.task_uid;
}

/**
 * §6.3 — no native split primitive in uw-be. Orchestrated here as: resolve this
 * task's own task_uid, claim/fetch the parent file, complete it, split its
 * bytes, resolve target tasks from the workflow graph, register N children
 * routed per §6.3.1 (chunks touching pages_with_errors go to the manual-fix
 * task; clean chunks go to the download-ready task).
 *
 * resolveActiveFile handles both "file already claimed by uw-fe's Assign
 * action" (the real launch-URL case) and "file just advanced here via the
 * DAG, never claimed" (the original assumption) — see its own doc comment.
 */
batchSplitRouter.post('/split', async (req, res) => {
  const body = req.body as SplitBody;

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

  const parentContext = await resolveActiveFile({
    projectId: body.projectId,
    projectCode: body.projectCode,
    taskId: body.taskId,
    taskUid: currentTask.task_uid,
    fileId: body.fileId,
    jobId: body.jobId,
  });
  if (!parentContext.ok || !parentContext.data) {
    res.status(404).json({ ok: false, error: parentContext.error ?? 'could not resolve parent file context' });
    return;
  }

  const downloadUrl = parentContext.data.input_download_url;
  if (!downloadUrl) {
    res.status(502).json({
      ok: false,
      error: 'could not resolve an input_download_url for the parent file',
    });
    return;
  }

  const pagesWithErrors = new Set<number>(
    (parentContext.data.meta_data as { pages_with_errors?: number[] } | undefined)?.pages_with_errors ?? [],
  );

  // Complete parent (§6.3 step 1)
  const parentCompletion = await updateFileStatus({
    projectCode: body.projectCode,
    taskUid: currentTask.task_uid,
    fileId: body.fileId,
    previousFileStatus: 'I',
    fileStatus: 'C',
    userId: body.userId,
  });
  if (!parentCompletion.ok) {
    res.status(502).json({ ok: false, error: parentCompletion.error ?? 'update-file-status failed for parent' });
    return;
  }

  // Fetch parent bytes
  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    res.status(502).json({ ok: false, error: `failed to download parent file: HTTP ${fileResponse.status}` });
    return;
  }
  const parentBytes = Buffer.from(await fileResponse.arrayBuffer());

  const splitMethod: SplitMethod = body.splitMethod ?? 'equal-pages';

  // Resolve target tasks dynamically (§6.3.1) — never hardcode a task_uid.
  const downloadReadyTaskUid = findTaskUid(taskGraph.data, config.batchSplit.downloadReadyTaskCode);
  const manualFixTaskUid = findTaskUid(taskGraph.data, config.batchSplit.manualFixTaskCode);
  const qualificationTaskUid = findTaskUid(taskGraph.data, config.batchSplit.qualificationTaskCode);

  // by-chapter has no pages_with_errors yet (qualification hasn't run on these
  // chapters — that happens AFTER this split, per-chapter), so every chunk
  // routes to qualification instead of the equal-pages download/manual-fix split.
  if (splitMethod === 'by-chapter' && !qualificationTaskUid) {
    res.status(502).json({
      ok: false,
      error: `no task with code "${config.batchSplit.qualificationTaskCode}" found in the workflow graph`,
    });
    return;
  }
  if (splitMethod === 'equal-pages' && !downloadReadyTaskUid) {
    res.status(502).json({
      ok: false,
      error: `no task with code "${config.batchSplit.downloadReadyTaskCode}" found in the workflow graph`,
    });
    return;
  }

  const { chunks, usedFallback, detectionMethod } = await splitPdf(parentBytes, splitMethod);

  const children = [];
  for (const chunk of chunks) {
    let targetTaskUid: string;
    let routedTo: string;
    if (splitMethod === 'by-chapter' && !usedFallback) {
      targetTaskUid = qualificationTaskUid!;
      routedTo = 'qualification';
    } else {
      const hasErrors = chunk.pageNumbers.some((p) => pagesWithErrors.has(p));
      // Intentional deviation from DAG-only routing — flagged to Vibhor per §6.3.1.
      targetTaskUid = hasErrors && manualFixTaskUid ? manualFixTaskUid : downloadReadyTaskUid!;
      routedTo = hasErrors ? 'manual-fix' : 'download-ready';
    }

    const fileName = chunk.label
      ? `${chunk.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}.pdf`
      : `${body.fileName.replace(/\.pdf$/i, '')}-part-${chunk.index + 1}.pdf`;

    const registered = await registerFile({
      projectCode: body.projectCode,
      jobId: body.jobId,
      batchId: body.batchId,
      firstTaskUid: targetTaskUid,
      fileName,
      metaData: {
        parent_file_id: body.fileId,
        split_index: chunk.index,
        ...(chunk.label ? { chapter_title: chunk.label } : {}),
      },
    });
    if (!registered.ok || !registered.data) {
      res.status(502).json({ ok: false, error: registered.error ?? `register-file failed for chunk ${chunk.index}` });
      return;
    }
    if (!registered.data.file_output_upload_url) {
      res.status(502).json({
        ok: false,
        error: `register-file for chunk ${chunk.index} returned no upload URL — check the target task's upload_to_storage flag`,
      });
      return;
    }
    await putRawBytes(registered.data.file_output_upload_url, chunk.bytes);
    children.push({
      fileId: registered.data.file_id,
      // register-file's response has no task_uid — the file now sits at
      // whichever task we just registered it against.
      taskUid: targetTaskUid,
      splitIndex: chunk.index,
      pageNumbers: chunk.pageNumbers,
      routedTo,
      label: chunk.label,
    });
  }

  res.json({ ok: true, data: { children, splitMethod, usedFallback, detectionMethod } });
});
