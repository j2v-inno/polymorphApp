import { Router, type Request, type Response } from 'express';
import {
  flowBackFileTask,
  getAllTasks,
  resolveActiveFile,
  updateFileMetaData,
  updateFileStatus,
  type ActiveFileContext,
} from '../uwbe-client/endpoints.js';

export const qualificationRouter = Router();

interface QualificationFile {
  file: ActiveFileContext;
  taskUid: string;
}

/**
 * §6.2 step 1 — resolveActiveFile handles both "file already claimed by
 * uw-fe's Assign action" and "file just advanced here via the DAG, never
 * claimed" (see its own doc comment). Needs task_uid, which TaskContext
 * doesn't carry directly, so it's resolved via get-all-tasks + matching on
 * taskId (same pattern as batch-split.ts/download.ts).
 *
 * Shared by /context and /content, so both resolve the file the same way from
 * the same task-context query — writes the error response itself and returns
 * null when resolution fails.
 */
async function resolveQualificationFile(req: Request, res: Response): Promise<QualificationFile | null> {
  const projectId = Number(req.query.projectId);
  const projectCode = String(req.query.projectCode ?? '');
  const workflowCode = String(req.query.workflowCode ?? '');
  const taskId = Number(req.query.taskId);
  const fileId = Number(req.query.fileId);
  const jobId = req.query.jobId ? Number(req.query.jobId) : undefined;

  if (!projectId || !projectCode || !workflowCode || !taskId || !fileId) {
    res.status(400).json({ ok: false, error: 'projectId, projectCode, workflowCode, taskId, and fileId are required' });
    return null;
  }

  const taskGraph = await getAllTasks({ projectCode, workflowCode });
  if (!taskGraph.ok || !taskGraph.data) {
    res.status(502).json({ ok: false, error: taskGraph.error ?? 'get-all-tasks failed' });
    return null;
  }
  const currentTask = taskGraph.data.find((t) => t.id === taskId);
  if (!currentTask) {
    res.status(502).json({ ok: false, error: `no task with id ${taskId} found in the workflow graph` });
    return null;
  }

  const result = await resolveActiveFile({ projectId, projectCode, taskId, taskUid: currentTask.task_uid, fileId, jobId });
  if (!result.ok || !result.data) {
    res.status(404).json({ ok: false, error: result.error });
    return null;
  }
  return { file: result.data, taskUid: currentTask.task_uid };
}

qualificationRouter.get('/context', async (req, res) => {
  const resolved = await resolveQualificationFile(req, res);
  if (!resolved) return;
  res.json({ ok: true, data: { ...resolved.file, task_uid: resolved.taskUid } });
});

/**
 * The raw text of the file's own input_download_url, fetched server-side —
 * avoids the browser hitting CORS on the S3/MinIO presigned URL directly, same
 * technique batch-split.ts already uses to fetch a parent file's bytes. Used by
 * the qualification screen's structured-content viewer (content_format:
 * 'xml'|'json' in meta_data) to display transformed output as text instead of
 * a PDF iframe.
 *
 * Takes the same task-context query as /context and resolves the URL itself,
 * rather than accepting one from the caller: this used to be
 * /content-proxy?url=, which fetched any URL it was given and returned the
 * body — a server-side request forgery hole reaching anything this backend can
 * reach, including the box's own services when EXTRA_HOST_ENTRY is set.
 */
qualificationRouter.get('/content', async (req, res) => {
  const resolved = await resolveQualificationFile(req, res);
  if (!resolved) return;

  const url = resolved.file.input_download_url;
  if (!url) {
    res.status(404).json({ ok: false, error: 'this file has no input_download_url to fetch content from' });
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
  /** Only needed if the task requires the reviewed file as its output. */
  projectId?: number;
  projectCode: string;
  /** Plumbing only — kept so payloads mirror the launch URL. */
  workflowId?: number;
  /** Only needed if the task requires the reviewed file as its output. */
  taskId?: number;
  taskUid: string;
  fileId: number;
  jobId?: number;
  pagesWithErrors: number[];
  outcome: 'clean' | 'rework' | 'archive';
  flowbackReason?: string;
  nextTask?: string;
  userId?: number;
}

/** uw-be's refusal when a task with user_should_upload_output = 1 is completed without file_data. */
const FILE_DATA_REQUIRED = 'File data is required';

type ReviewedFile =
  | { ok: true; fileData: { bytes: Buffer; fileName: string; contentType?: string } }
  | { ok: false; error: string };

/**
 * The bytes of the file under review, fetched server-side from its own
 * download URL. Needs projectId and taskId to resolve the file — callers from
 * before this fallback existed don't send them, and only reach here on a task
 * that never completed for them anyway.
 */
async function fetchReviewedFile(body: CompleteBody): Promise<ReviewedFile> {
  if (!body.projectId || !body.taskId) {
    return { ok: false, error: 'Sending the reviewed file needs projectId and taskId.' };
  }
  const active = await resolveActiveFile({
    projectId: body.projectId,
    projectCode: body.projectCode,
    taskId: body.taskId,
    taskUid: body.taskUid,
    fileId: body.fileId,
    jobId: body.jobId,
  });
  const downloadUrl = active.data?.input_download_url;
  if (!active.ok || !downloadUrl) {
    return { ok: false, error: active.error ?? 'uw-be returned no download URL for this file.' };
  }
  try {
    const download = await fetch(downloadUrl);
    if (!download.ok) {
      return { ok: false, error: `Fetching the reviewed file failed: HTTP ${download.status}.` };
    }
    return {
      ok: true,
      fileData: {
        bytes: Buffer.from(await download.arrayBuffer()),
        fileName: String(active.data?.file_name ?? `file-${body.fileId}`),
        contentType: download.headers.get('content-type') ?? undefined,
      },
    };
  } catch (err) {
    return { ok: false, error: `Fetching the reviewed file failed: ${err instanceof Error ? err.message : String(err)}.` };
  }
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
  const completion = {
    projectCode: body.projectCode,
    taskUid: body.taskUid,
    fileId: body.fileId,
    previousFileStatus: 'I',
    fileStatus: 'C',
    metaData: body.pagesWithErrors.length ? { pages_with_errors: body.pagesWithErrors } : undefined,
    nextTask: body.nextTask,
    userId: body.userId,
  };
  let result = await updateFileStatus(completion);

  // Tried without a file first, exactly as before, so every task that completed
  // that way still does. Only a task with user_should_upload_output = 1 refuses
  // — uw-be checks that before changing anything — and for those the reviewed
  // file goes back as the task's output: a review doesn't change the file, and
  // the next task only looks for its input in THIS task's output.
  if (!result.ok && result.error?.includes(FILE_DATA_REQUIRED)) {
    const reviewed = await fetchReviewedFile(body);
    if (!reviewed.ok) {
      res.status(502).json({ ok: false, error: `${result.error} ${reviewed.error}` });
      return;
    }
    result = await updateFileStatus({ ...completion, fileData: reviewed.fileData });
  }

  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, data: { outcome: 'clean' } });
});
