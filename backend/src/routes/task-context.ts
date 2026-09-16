import { Router } from 'express';
import { getAllTasks, getTaskOngoingFile } from '../uwbe-client/endpoints.js';
import type { TaskContextPointer } from '../types.js';

export const taskContextRouter = Router();

/**
 * §3.3 — neither customProps (Parcel mode) nor URL params (standalone mode) are
 * trusted for authorization. Re-fetch and re-validate via get-task-ongoing-file
 * using the IDs supplied before the frontend renders any mode screen.
 *
 * Also resolves taskCode server-side when the launch context doesn't supply it
 * directly — verified against uw-fe's real "Register New File" external-app URL
 * (user-modules.tsx's constructExternalUrl), which sends project/workflow ids
 * and codes, task_id, task_uid, and user_id, but never task_code. Needs
 * workflowCode to do this (get-all-tasks requires it) — same dependency
 * qualification/batch/download already have.
 */
taskContextRouter.post('/resolve', async (req, res) => {
  const pointer = req.body as Partial<TaskContextPointer>;

  if (!pointer.projectId || !pointer.projectCode || !pointer.taskId) {
    res.status(400).json({ ok: false, error: 'projectId, projectCode, and taskId are required' });
    return;
  }

  let taskCode = pointer.taskCode;
  let taskUid = pointer.taskUid;

  if (!taskCode) {
    if (!pointer.workflowCode) {
      res.status(400).json({
        ok: false,
        error: 'taskCode is missing from the launch context and workflowCode was not supplied to resolve it',
      });
      return;
    }
    const taskGraph = await getAllTasks({ projectCode: pointer.projectCode, workflowCode: pointer.workflowCode });
    if (!taskGraph.ok || !taskGraph.data) {
      res.status(502).json({ ok: false, error: taskGraph.error ?? 'get-all-tasks failed while resolving taskCode' });
      return;
    }
    const match = taskGraph.data.find((t) => t.id === pointer.taskId || t.task_uid === pointer.taskUid);
    if (!match) {
      res.status(502).json({ ok: false, error: `no task with id ${pointer.taskId} found in the workflow graph` });
      return;
    }
    taskCode = match.code;
    taskUid = match.task_uid;
  }

  // ACQUISITION's and BULK_REGISTRATION's "register new file(s)" launches
  // genuinely have no file yet — nothing further to re-validate, no file
  // exists until registration creates one (BULK_REGISTRATION creates many,
  // per row). Every other task's launch SHOULD have a file already claimed
  // (uw-fe's own "Assign" action claims it before redirecting here), but none
  // of uw-fe's external-app launch URL schemes actually include a file_id —
  // so when it's missing and this isn't one of the no-file-yet entry tasks,
  // ask uw-be "what file does this user currently have active here" instead.
  if (!pointer.fileId && (taskCode === 'ACQUISITION' || taskCode === 'BULK_REGISTRATION')) {
    res.json({ ok: true, data: { ...pointer, taskCode, taskUid } });
    return;
  }

  if (!pointer.fileId) {
    if (!pointer.userId) {
      res.status(400).json({ ok: false, error: 'userId is required to resolve the active file when fileId is absent' });
      return;
    }
    const active = await getTaskOngoingFile({
      projectId: pointer.projectId,
      taskId: pointer.taskId,
      userId: pointer.userId,
    });
    if (!active.ok || !active.data) {
      res.status(404).json({ ok: false, error: active.error ?? 'no active file found for this user at this task' });
      return;
    }
    // uw-be's response is snake_case (file_id, job_id, ...) — unlike the
    // fileId-already-known branch below, pointer has no camelCase fileId of
    // its own yet for this to fall back to, so it must be mapped explicitly
    // rather than relying on the raw ...active.data spread (which only adds
    // file_id as a new, differently-named key, leaving fileId undefined).
    res.json({
      ok: true,
      data: {
        ...pointer,
        taskCode,
        taskUid,
        fileId: active.data.file_id as number | undefined,
        jobId: active.data.job_id as number | undefined,
        batchId: active.data.batch_id as number | undefined,
        jobName: active.data.job_name as string | undefined,
        batchName: active.data.batch_name as string | undefined,
        fileName: active.data.file_name as string | undefined,
        ...active.data,
      },
    });
    return;
  }

  if (!pointer.jobId) {
    res.status(400).json({ ok: false, error: 'jobId is required when fileId is present' });
    return;
  }

  const result = await getTaskOngoingFile({
    projectId: pointer.projectId,
    taskId: pointer.taskId,
    fileId: pointer.fileId,
    jobId: pointer.jobId,
  });

  if (!result.ok) {
    res.status(404).json({ ok: false, error: result.error ?? 'task/file not found for the supplied context' });
    return;
  }

  res.json({ ok: true, data: { ...pointer, taskCode, taskUid, ...result.data } });
});
