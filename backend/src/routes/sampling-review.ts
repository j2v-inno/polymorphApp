import { Router, type Request, type Response } from 'express';
import { callUwbe } from '../uwbe-client/http.js';
import { flowBackFileTask, getAllTasks, updateFileStatus } from '../uwbe-client/endpoints.js';
import { downloadFileTaskInput } from '../worker/uwbe.js';

/**
 * Sample review for Orion's sampling batches. Opened from a register-type launcher task, so the app token
 * carries no file: the project and workflow come from the token, and the batches are the ones cut at the
 * workflow's sampling task (SAMPLING_TASK_CODE). The reviewer is always the operator Orion confirmed.
 *
 * Orion hands the reviewer one sampled file at a time (sampling-batches/next-file): the first call assigns them a
 * whole batch. Approving completes the file at the sampling task; rejecting flows it back to the rework task.
 */
export const samplingReviewRouter = Router();

const SAMPLING_TASK_CODE = process.env.SAMPLING_TASK_CODE ?? 'QA_BATCH';

interface BatchSummary {
  uid: string;
  status: string;
  reviewer: string | null;
  assigned_at: string | null;
  file_count: number;
  sample_count: number;
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  ready_for_release: boolean;
  release_error: string | null;
  created_at: string;
  released_at: string | null;
}

interface BatchFile {
  file_id: number;
  file_name: string;
  file_status: string | null;
  is_sampled: boolean;
  review_status: 'pending' | 'approved' | 'rejected' | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  reject_count: number;
  removed: boolean;
}

/** What next-file answers: the sample to review now, and the ids a reject needs. */
interface NextSample {
  batch_uid: string;
  file_id: number;
  file_name: string;
  job_id: number;
  batch_id: number | null;
  task_id: number;
  rework_task_id: number;
  file_task_id: number;
  file_status: string;
  sampled_position: number;
  sample_count: number;
  reject_count: number;
  review_comment: string | null;
  reviewer: string;
}

type Scope = { projectCode: string; workflowCode: string; taskUid: string; userId: number };

/** The sampling task this token's workflow reviews, or a reply already sent. */
async function scopeFor(req: Request, res: Response): Promise<Scope | null> {
  const context = req.orion?.context;
  const projectCode = context?.project.code;
  const workflowCode = context?.workflow?.code;
  if (!context || !projectCode || !workflowCode) {
    res.status(400).json({ ok: false, error: 'Orion did not say which project and workflow this review is for.' });
    return null;
  }
  const tasks = await getAllTasks({ projectCode, workflowCode });
  const task = tasks.data?.find((t) => t.code === SAMPLING_TASK_CODE);
  if (!tasks.ok || !task) {
    res.status(404).json({ ok: false, error: `This workflow has no ${SAMPLING_TASK_CODE} task to review.` });
    return null;
  }
  return { projectCode, workflowCode, taskUid: task.task_uid, userId: req.orion!.actor.user_id };
}

/** The reviewer's current sample, or null when they have none and no batch is waiting. */
async function nextSample(scope: Scope): Promise<{ sample: NextSample | null; error?: string; httpStatus?: number }> {
  const result = await callUwbe<NextSample>('sampling-batches/next-file', {
    method: 'POST',
    styleKey: 'sampling-batches/run',
    body: { project_code: scope.projectCode, workflow_code: scope.workflowCode, task_uid: scope.taskUid, user_id: scope.userId },
  });
  if (result.ok && result.data) return { sample: result.data };
  if (result.httpStatus === 404) return { sample: null };
  return { sample: null, error: result.error ?? 'Orion did not hand out a sample.', httpStatus: result.httpStatus };
}

/** The sample a decision is about, if it is the one Orion currently has this reviewer on. */
async function currentSample(scope: Scope, fileId: number, res: Response): Promise<NextSample | null> {
  const next = await nextSample(scope);
  if (next.error) {
    res.status(next.httpStatus === 403 ? 403 : 502).json({ ok: false, error: next.error });
    return null;
  }
  if (!next.sample || next.sample.file_id !== fileId) {
    res.status(409).json({ ok: false, error: 'That file is not the sample Orion has you on. Refresh to get your current sample.' });
    return null;
  }
  return next.sample;
}

/** Starts the sample at the sampling task for the reviewer, unless it is already in progress. */
async function startSample(scope: Scope, sample: NextSample): Promise<string | null> {
  if (sample.file_status === 'I') return null;
  const started = await updateFileStatus({
    projectCode: scope.projectCode,
    taskUid: scope.taskUid,
    fileId: sample.file_id,
    previousFileStatus: 'Y',
    fileStatus: 'I',
    userId: scope.userId,
  });
  return started.ok ? null : (started.error ?? 'Orion did not start the file.');
}

samplingReviewRouter.get('/batches', async (req, res) => {
  const scope = await scopeFor(req, res);
  if (!scope) return;
  const result = await callUwbe<{ batches: BatchSummary[] }>('sampling-batches', {
    method: 'GET',
    query: { project_code: scope.projectCode, workflow_code: scope.workflowCode, task_uid: scope.taskUid, per_page: 50 },
    styleKey: 'sampling-batches/run',
  });
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error ?? 'Could not list sampling batches.' });
    return;
  }
  res.json({ ok: true, data: { batches: result.data?.batches ?? [], taskCode: SAMPLING_TASK_CODE } });
});

samplingReviewRouter.get('/batches/:uid', async (req, res) => {
  const scope = await scopeFor(req, res);
  if (!scope) return;
  const result = await callUwbe<BatchSummary & { files: BatchFile[] }>(`sampling-batches/${encodeURIComponent(req.params.uid)}`, {
    method: 'GET',
    query: { project_code: scope.projectCode },
    styleKey: 'sampling-batches/run',
  });
  if (!result.ok || !result.data) {
    res.status(result.httpStatus === 404 ? 404 : 502).json({ ok: false, error: result.error ?? 'Could not load the batch.' });
    return;
  }
  res.json({ ok: true, data: result.data });
});

/** Cuts batches from the files waiting now, rather than at the next scheduler run. */
function createBatches(scope: Scope) {
  return callUwbe('sampling-batches/run', {
    method: 'POST',
    body: { project_code: scope.projectCode, workflow_code: scope.workflowCode, task_uid: scope.taskUid, step: 'create' },
  });
}

/**
 * The reviewer's current sample with its content. The first call assigns them the oldest waiting batch; with none
 * waiting, it cuts batches once and asks again.
 */
samplingReviewRouter.post('/next', async (req, res) => {
  const scope = await scopeFor(req, res);
  if (!scope) return;
  let next = await nextSample(scope);
  if (!next.error && !next.sample) {
    const created = await createBatches(scope);
    if (created.ok) next = await nextSample(scope);
  }
  if (next.error) {
    res.status(next.httpStatus === 403 ? 403 : 502).json({ ok: false, error: next.error });
    return;
  }
  if (!next.sample) {
    res.json({ ok: true, data: null });
    return;
  }
  try {
    const input = await downloadFileTaskInput({
      project_code: scope.projectCode,
      task_uid: scope.taskUid,
      file_id: next.sample.file_id,
    } as Parameters<typeof downloadFileTaskInput>[0]);
    res.json({ ok: true, data: { sample: next.sample, fileName: input.fileName, content: input.bytes.toString('utf8') } });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Could not read the file.' });
  }
});

samplingReviewRouter.post('/samples/:fileId/approve', async (req, res) => {
  const scope = await scopeFor(req, res);
  if (!scope) return;
  const sample = await currentSample(scope, Number(req.params.fileId), res);
  if (!sample) return;
  const startError = await startSample(scope, sample);
  if (startError) {
    res.status(502).json({ ok: false, error: startError });
    return;
  }
  const completed = await updateFileStatus({
    projectCode: scope.projectCode,
    taskUid: scope.taskUid,
    fileId: sample.file_id,
    previousFileStatus: 'I',
    fileStatus: 'C',
    userId: scope.userId,
  });
  if (!completed.ok) {
    res.status(502).json({ ok: false, error: completed.error ?? 'Orion did not complete the file.' });
    return;
  }
  res.json({ ok: true, data: { batchUid: sample.batch_uid } });
});

samplingReviewRouter.post('/samples/:fileId/reject', async (req, res) => {
  const scope = await scopeFor(req, res);
  if (!scope) return;
  const comment = String((req.body as { comment?: string }).comment ?? '').trim();
  if (!comment) {
    res.status(400).json({ ok: false, error: 'Say why the file is rejected: the reason goes back to the rework task.' });
    return;
  }
  const sample = await currentSample(scope, Number(req.params.fileId), res);
  if (!sample) return;
  const startError = await startSample(scope, sample);
  if (startError) {
    res.status(502).json({ ok: false, error: startError });
    return;
  }
  const flowed = await flowBackFileTask({
    projectCode: scope.projectCode,
    jobId: sample.job_id,
    batchId: sample.batch_id ?? undefined,
    fileId: sample.file_id,
    flowBackFromTaskId: sample.task_id,
    flowBackToTaskId: sample.rework_task_id,
    flowbackReason: comment.slice(0, 255),
    userId: scope.userId,
    complete: true,
  });
  if (!flowed.ok) {
    res.status(502).json({ ok: false, error: flowed.error ?? 'Orion did not send the file back.' });
    return;
  }
  res.json({ ok: true, data: { batchUid: sample.batch_uid } });
});

/** Releases every batch whose samples are all approved, now rather than at the next scheduler run. */
samplingReviewRouter.post('/release', async (req, res) => {
  const scope = await scopeFor(req, res);
  if (!scope) return;
  const result = await callUwbe<{ released: Array<{ uid: string; routed: number }>; failed: Array<{ uid: string; error: string }> }>(
    'sampling-batches/run',
    { method: 'POST', body: { project_code: scope.projectCode, workflow_code: scope.workflowCode, task_uid: scope.taskUid, step: 'release' } },
  );
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error ?? 'Release failed.' });
    return;
  }
  res.json({ ok: true, data: result.data });
});
