import { Router } from 'express';
import { getTaskOngoingFile } from '../uwbe-client/endpoints.js';

export const downloadRouter = Router();

/**
 * §6.4 — terminal screen, no compute. Resolves a download link per split child
 * registered in §6.3. No async worker, no status polling: the frontend calls this
 * once per screen load and renders whatever comes back.
 *
 * Was built on get-file-task-output, which requires the file to be
 * `file_status = Completed` at the *queried* task (TaskProcessController.php:4655)
 * — but DOWNLOAD is a passive terminal task with no "complete" action anywhere in
 * this app, so a file that just arrived there (from qualification completing, or
 * self-registered directly by an equal-pages split) never satisfies that and the
 * endpoint always 400s with the confusingly-worded "Invalid request of file
 * status already completed." Switched to get-task-ongoing-file
 * (get_task_current_file) instead — it resolves the real download_url for a file
 * in any status by walking its previous-task output path, which is exactly what a
 * terminal "give me the finished artifact" screen needs, and it's the same
 * endpoint qualification's screen already relies on successfully.
 */
downloadRouter.get('/', async (req, res) => {
  const projectId = Number(req.query.projectId);
  const projectCode = String(req.query.projectCode ?? '');
  const taskId = Number(req.query.taskId);
  const fileIdsParam = String(req.query.fileIds ?? '');
  const fileIds = fileIdsParam
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  if (!projectId || !projectCode || !taskId || fileIds.length === 0) {
    res.status(400).json({
      ok: false,
      error: 'projectId, projectCode, taskId, and a non-empty fileIds (comma-separated) are required',
    });
    return;
  }

  const results = await Promise.all(fileIds.map((fileId) => getTaskOngoingFile({ projectId, taskId, fileId })));

  const links = results.map((result, i) => ({
    fileId: fileIds[i],
    ok: result.ok,
    downloadUrl: (result.data?.download_url as string | undefined) ?? null,
    fileName: result.data?.file_name ?? null,
    status: (result.data?.file_task_status as string | undefined) ?? null,
    error: result.error,
  }));

  res.json({ ok: true, data: { links } });
});
