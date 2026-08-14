import { Router } from 'express';
import {
  flowBackFileTask,
  getAllTasks,
  getTaskNextFileWithStart,
  updateFileMetaData,
  updateFileStatus,
} from '../uwbe-client/endpoints.js';

export const qualificationRouter = Router();

/**
 * §6.2 step 1 — get-task-ongoing-file (the doc's original choice) only reads an
 * ALREADY-STARTED file_task_users session; it 400s the first time a screen opens
 * for a file that just advanced here via the DAG. get-task-next-file-with-start
 * is what actually claims/starts that session (verified live against uw-be) —
 * needs task_uid, which TaskContext doesn't carry directly, so it's resolved via
 * get-all-tasks + matching on taskId (same pattern as batch-split.ts/download.ts).
 */
qualificationRouter.get('/context', async (req, res) => {
  const projectCode = String(req.query.projectCode ?? '');
  const workflowCode = String(req.query.workflowCode ?? '');
  const taskId = Number(req.query.taskId);
  const fileId = Number(req.query.fileId);

  if (!projectCode || !workflowCode || !taskId || !fileId) {
    res.status(400).json({ ok: false, error: 'projectCode, workflowCode, taskId, and fileId are required' });
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

  const result = await getTaskNextFileWithStart({ projectCode, taskUid: currentTask.task_uid, fileId });
  if (!result.ok || !result.data) {
    res.status(404).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, data: { ...result.data, task_uid: currentTask.task_uid } });
});

interface PagesViewedBody {
  projectCode: string;
  taskUid: string;
  fileId: number;
  jobId: number;
  pagesViewed: number[];
}

/** §6.2 step 2 — non-audited telemetry. Deliberately NOT routed through update-file-status. */
qualificationRouter.post('/pages-viewed', async (req, res) => {
  const body = req.body as PagesViewedBody;

  const result = await updateFileMetaData({
    projectCode: body.projectCode,
    taskUid: body.taskUid,
    fileId: body.fileId,
    jobId: body.jobId,
    metaData: { pages_viewed: body.pagesViewed },
  });
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

interface CompleteBody {
  projectCode: string;
  taskUid: string;
  fileId: number;
  pagesWithErrors: number[];
  outcome: 'clean' | 'rework' | 'archive';
  flowbackReason?: string;
  nextTask?: string;
}

/** §6.2 step 3 — 3-way routing outcome, chosen by the operator on the qualification screen. */
qualificationRouter.post('/complete', async (req, res) => {
  const body = req.body as CompleteBody;

  if (body.outcome === 'archive') {
    // §6.2 — "No archive endpoint found in routes/api.php." Blocker #2 (owner: Rifky).
    res.status(501).json({
      ok: false,
      error:
        'Archive is not implemented pending confirmation of which endpoint/route surface owns it ' +
        '(FLUID_APP_DEV_CONTEXT.md §13, open question #2).',
    });
    return;
  }

  if (body.outcome === 'rework') {
    if (!body.flowbackReason) {
      res.status(400).json({ ok: false, error: 'flowbackReason is required for rework' });
      return;
    }
    const result = await flowBackFileTask({
      projectCode: body.projectCode,
      taskUid: body.taskUid,
      fileId: body.fileId,
      flowbackReason: body.flowbackReason,
    });
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, data: { outcome: 'rework' } });
    return;
  }

  // Clean. pages_with_errors travels through meta_data, merged *with* the audit
  // trail only if projects.track_metadata_change=true on this project — unconfirmed
  // (§13 #3). If it's false, this write still succeeds but silently isn't audited.
  const result = await updateFileStatus({
    projectCode: body.projectCode,
    taskUid: body.taskUid,
    fileId: body.fileId,
    previousFileStatus: 'I',
    fileStatus: 'C',
    metaData: body.pagesWithErrors.length ? { pages_with_errors: body.pagesWithErrors } : undefined,
    nextTask: body.nextTask,
  });
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, data: { outcome: 'clean' } });
});
