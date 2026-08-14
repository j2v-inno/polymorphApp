import { Router } from 'express';
import { config } from '../config.js';
import { splitPdf } from '../pdf/split.js';
import {
  getAllTasks,
  getTaskNextFileWithStart,
  registerFile,
  updateFileStatus,
  type TaskGraphNode,
} from '../uwbe-client/endpoints.js';
import { putRawBytes } from '../uwbe-client/http.js';

export const batchSplitRouter = Router();

interface SplitBody {
  projectCode: string;
  workflowCode: string;
  taskId: number;
  jobId: number;
  batchId: number;
  fileId: number;
  fileName: string;
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
 * get-task-ongoing-file only reads an ALREADY-STARTED file_task_users session
 * — it 400s the first time this screen opens for a file that just advanced
 * here via the DAG. get-task-next-file-with-start is what actually claims/
 * starts that session and returns the file's data in the same call (verified
 * live against uw-be) — used here instead, same as qualification.ts.
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

  const parentContext = await getTaskNextFileWithStart({
    projectCode: body.projectCode,
    taskUid: currentTask.task_uid,
    fileId: body.fileId,
  });
  if (!parentContext.ok || !parentContext.data) {
    res.status(404).json({ ok: false, error: parentContext.error ?? 'could not resolve parent file context' });
    return;
  }

  const downloadUrl = parentContext.data.input_download_url;
  if (!downloadUrl) {
    res.status(502).json({
      ok: false,
      error: 'get-task-next-file-with-start did not return an input_download_url for the parent file',
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

  // Resolve target tasks dynamically (§6.3.1) — never hardcode a task_uid.
  const downloadReadyTaskUid = findTaskUid(taskGraph.data, config.batchSplit.downloadReadyTaskCode);
  const manualFixTaskUid = findTaskUid(taskGraph.data, config.batchSplit.manualFixTaskCode);
  if (!downloadReadyTaskUid) {
    res.status(502).json({
      ok: false,
      error: `no task with code "${config.batchSplit.downloadReadyTaskCode}" found in the workflow graph`,
    });
    return;
  }

  const chunks = await splitPdf(parentBytes);

  const children = [];
  for (const chunk of chunks) {
    const hasErrors = chunk.pageNumbers.some((p) => pagesWithErrors.has(p));
    // Intentional deviation from DAG-only routing — flagged to Vibhor per §6.3.1.
    const targetTaskUid = hasErrors && manualFixTaskUid ? manualFixTaskUid : downloadReadyTaskUid;

    const registered = await registerFile({
      projectCode: body.projectCode,
      jobId: body.jobId,
      batchId: body.batchId,
      firstTaskUid: targetTaskUid,
      fileName: `${body.fileName.replace(/\.pdf$/i, '')}-part-${chunk.index + 1}.pdf`,
      metaData: { parent_file_id: body.fileId, split_index: chunk.index },
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
      routedTo: hasErrors ? 'manual-fix' : 'download-ready',
    });
  }

  res.json({ ok: true, data: { children } });
});
