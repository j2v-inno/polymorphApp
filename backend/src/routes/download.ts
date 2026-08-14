import { Router } from 'express';
import { getAllTasks, getFileTaskOutput } from '../uwbe-client/endpoints.js';

export const downloadRouter = Router();

/**
 * §6.4 — terminal screen, no compute. Resolves a download link per split child
 * registered in §6.3. No async worker, no status polling: the frontend calls this
 * once per screen load and renders whatever comes back.
 *
 * get-file-task-output actually requires task_uid/job_name/batch_name alongside
 * project_code/file_id (verified against TaskProcessController.php:4511-4521) —
 * task_uid isn't something the frontend has directly (TaskContext only carries
 * the internal numeric taskId), so it's resolved here via get-all-tasks, matched
 * against taskId, exactly like batch-split.ts already does for its target tasks.
 */
downloadRouter.get('/', async (req, res) => {
  const projectCode = String(req.query.projectCode ?? '');
  const workflowCode = String(req.query.workflowCode ?? '');
  const taskId = Number(req.query.taskId);
  const jobName = String(req.query.jobName ?? '');
  const batchName = String(req.query.batchName ?? '');
  const fileIdsParam = String(req.query.fileIds ?? '');
  const fileIds = fileIdsParam
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  if (!projectCode || !workflowCode || !taskId || !jobName || !batchName || fileIds.length === 0) {
    res.status(400).json({
      ok: false,
      error: 'projectCode, workflowCode, taskId, jobName, batchName, and a non-empty fileIds (comma-separated) are required',
    });
    return;
  }

  const taskGraph = await getAllTasks({ projectCode, workflowCode });
  if (!taskGraph.ok || !taskGraph.data) {
    res.status(502).json({ ok: false, error: taskGraph.error ?? 'get-all-tasks failed' });
    return;
  }
  const currentTask = taskGraph.data.find((t) => t.id === taskId);
  if (!currentTask) {
    res.status(502).json({ ok: false, error: `no task with id ${taskId} found in the workflow graph` });
    return;
  }

  const results = await Promise.all(
    fileIds.map((fileId) =>
      getFileTaskOutput({ projectCode, taskUid: currentTask.task_uid, fileId, jobName, batchName }),
    ),
  );

  const links = results.map((result, i) => ({
    fileId: fileIds[i],
    ok: result.ok,
    downloadUrl: result.data?.download_url ?? null,
    fileName: result.data?.file_name ?? null,
    status: result.data?.file_status ?? null,
    error: result.error,
  }));

  res.json({ ok: true, data: { links } });
});
