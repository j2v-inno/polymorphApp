import { Router } from 'express';
import { flowBackFileTask, getAllTasks, resolveActiveFile, updateFileMetaData, updateFileStatus } from '../uwbe-client/endpoints.js';

export const qualificationRouter = Router();

/**
 * §6.2 step 1 — resolveActiveFile handles both "file already claimed by
 * uw-fe's Assign action" and "file just advanced here via the DAG, never
 * claimed" (see its own doc comment). Needs task_uid, which TaskContext
 * doesn't carry directly, so it's resolved via get-all-tasks + matching on
 * taskId (same pattern as batch-split.ts/download.ts).
 */
qualificationRouter.get('/context', async (req, res) => {
  const projectId = Number(req.query.projectId);
  const projectCode = String(req.query.projectCode ?? '');
  const workflowCode = String(req.query.workflowCode ?? '');
  const taskId = Number(req.query.taskId);
  const fileId = Number(req.query.fileId);
  const jobId = req.query.jobId ? Number(req.query.jobId) : undefined;

  if (!projectId || !projectCode || !workflowCode || !taskId || !fileId) {
    res.status(400).json({ ok: false, error: 'projectId, projectCode, workflowCode, taskId, and fileId are required' });
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

  const result = await resolveActiveFile({ projectId, projectCode, taskId, taskUid: currentTask.task_uid, fileId, jobId });
  if (!result.ok || !result.data) {
    res.status(404).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, data: { ...result.data, task_uid: currentTask.task_uid } });
});

/**
 * Server-side fetch of a file's own (already-authenticated, presigned)
 * input_download_url — avoids the browser hitting CORS on the S3/MinIO
 * signed URL directly, same technique batch-split.ts already uses to fetch a
 * parent file's bytes. Used by the qualification screen's structured-content
 * viewer (content_format: 'xml'|'json' in meta_data) to display transformed
 * output as text instead of a PDF iframe.
 */
qualificationRouter.get('/content-proxy', async (req, res) => {
  const url = String(req.query.url ?? '');
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ ok: false, error: 'url must be an http(s) URL' });
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    res.status(502).json({ ok: false, error: `failed to fetch content: HTTP ${response.status}` });
    return;
  }
  const content = await response.text();
  res.json({ ok: true, data: { content } });
});

interface PagesViewedBody {
  projectCode: string;
  /** Plumbing only — uw-be calls use taskUid + workflowCode elsewhere. Kept so payloads mirror the launch URL. */
  workflowId?: number;
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

interface MetadataBody {
  projectCode: string;
  /** Plumbing only — kept so payloads mirror the launch URL. */
  workflowId?: number;
  taskUid: string;
  fileId: number;
  jobId: number;
  metaData: Record<string, unknown>;
}

/**
 * Operator-editable metadata (title, notes, chapter labels, etc.) — same
 * update-file-meta-data endpoint as pages-viewed above, just exposed for
 * arbitrary caller-supplied keys instead of the hardcoded pages_viewed shape.
 */
qualificationRouter.post('/metadata', async (req, res) => {
  const body = req.body as MetadataBody;

  if (!body.projectCode || !body.taskUid || !body.fileId || !body.jobId || !body.metaData) {
    res.status(400).json({ ok: false, error: 'projectCode, taskUid, fileId, jobId, and metaData are required' });
    return;
  }

  const result = await updateFileMetaData({
    projectCode: body.projectCode,
    taskUid: body.taskUid,
    fileId: body.fileId,
    jobId: body.jobId,
    metaData: body.metaData,
  });
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

interface CompleteBody {
  projectCode: string;
  /** Plumbing only — kept so payloads mirror the launch URL. */
  workflowId?: number;
  taskUid: string;
  fileId: number;
  pagesWithErrors: number[];
  outcome: 'clean' | 'rework' | 'archive';
  flowbackReason?: string;
  nextTask?: string;
  userId?: number;
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
      userId: body.userId,
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
    userId: body.userId,
  });
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, data: { outcome: 'clean' } });
});
