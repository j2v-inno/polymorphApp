import { Router } from 'express';
import { config } from '../config.js';
import { splitPdf, type SplitMethod, type PdfChunk, type ChapterDetectionMethod } from '../pdf/split.js';
import { getAllTasks, registerFile, resolveActiveFile, updateFileStatus, type TaskGraphNode } from '../uwbe-client/endpoints.js';
import { putRawBytes } from '../uwbe-client/http.js';
import { withUniqueSuffix } from '../lib/unique-filename.js';
import type { UwbeResult } from '../types.js';

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

interface PlannedChunk {
  chunk: PdfChunk;
  targetTaskUid: string;
  routedTo: 'manual-fix' | 'download-ready' | 'transformation';
  /** Name without the unique suffix — a fresh suffix is generated on every
   * register-file attempt (see registerChunk), since a chunk that fails
   * AFTER registering (no upload URL, upload error) already occupies its
   * first attempt's filename in uw-be; reusing it on retry would 422 with
   * "File name already exists in this project." */
  baseFileName: string;
  registeredFileId?: number;
  uploadUrl?: string;
  uploaded: boolean;
  /** Tracks which of the two post-register release calls has landed, so a resumed
   * attempt retries only the specific call still owed instead of redoing both. */
  releaseState: 'pending' | 'held' | 'released';
}

interface SplitProgress {
  /** Human-readable current step, polled by GET /split-status for the UI. */
  phase: string;
  parentTaskUid?: string;
  splitMethod?: SplitMethod;
  usedFallback?: boolean;
  detectionMethod?: ChapterDetectionMethod;
  plan?: PlannedChunk[];
  /** Parent is completed LAST, only once every child is fully released — see
   * module doc comment for why. */
  parentCompleted: boolean;
  /** True for the entire lifetime of one /split execution against this fileId
   * — set the instant a request claims this progress object, cleared in a
   * `finally` when that request returns. A second /split call for the same
   * fileId while this is true means the gateway timed out and gave up on a
   * still-running first request (confirmed happening on RND — the process
   * itself keeps going past a client-visible 504); without this flag both
   * requests would interleave over the same `plan` array and could each
   * register the same not-yet-registered chunk, creating duplicate child
   * files in uw-be. */
  busy: boolean;
}

/**
 * Two independent failure modes were confirmed here, both invisible to a
 * single request's retry logic unless handled explicitly:
 *  1. uw-be file-status calls that DO reach it can still fail on RND in a way
 *     never reproduced against a local uw-be+MySQL (not a read replica, not
 *     app-level caching — both ruled out by reading uw-be's own code; most
 *     likely the connection layer in front of the remote RDS instance).
 *  2. Some calls never reach uw-be at all — confirmed via Telescope showing
 *     no request logged for one such failure — meaning callUwbe's own fetch()
 *     threw (connection reset/timeout) rather than returning a response. Left
 *     uncaught (fixed in uwbe-client/http.ts), this bypassed retry logic
 *     entirely and surfaced as a bare, message-less 502 via Express 5's
 *     default error handler.
 * Neither has a knowable fixed duration, so a single request can't reliably
 * out-wait either. Progress is kept here in-process instead (keyed by parent
 * fileId), and each `/split` call resumes exactly where the previous one
 * left off: already-registered children are never re-registered, already-
 * uploaded chunks are never re-uploaded, and only the specific step still
 * outstanding gets retried.
 *
 * The parent file is completed LAST, only after every child is fully
 * registered/uploaded/released — not first, like the original design. Every
 * stuck-file incident hit while building this fix traced back to the same
 * shape: parent marked 'C' up front, then something later in the same
 * request failed, leaving a parent uw-be would never again resolve as
 * active/claimable — permanently blocking retries without manual DB
 * surgery. Completing it last means a mid-flight failure leaves the parent
 * untouched, so "click Split again" (which resolveActiveFile still finds
 * fine) genuinely converges on its own.
 *
 * Lost on a container restart mid-flight — acceptable for dev tooling; a
 * fresh split attempt is needed after that (parent is still untouched at
 * that point too, so this just means redoing already-uploaded chunks, not
 * a stuck file).
 */
const inFlightSplits = new Map<number, SplitProgress>();

function summarize(progress: SplitProgress) {
  const plan = progress.plan ?? [];
  const total = plan.length;
  const released = plan.filter((p) => p.releaseState === 'released').length;
  return {
    phase: progress.phase,
    totalChunks: total,
    chunksReleased: released,
    parentCompleted: progress.parentCompleted,
  };
}

batchSplitRouter.get('/split-status/:fileId', (req, res) => {
  const fileId = Number(req.params.fileId);
  const progress = inFlightSplits.get(fileId);
  if (!progress) {
    res.json({ ok: true, data: { phase: 'idle', totalChunks: 0, chunksReleased: 0, parentCompleted: false } });
    return;
  }
  res.json({ ok: true, data: summarize(progress) });
});

async function tryUwbe<T>(fn: () => Promise<UwbeResult<T>>, attempts = 3, delayMs = 1500): Promise<UwbeResult<T>> {
  let result = await fn();
  for (let attempt = 1; attempt < attempts && !result.ok; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await fn();
  }
  return result;
}

/**
 * §6.3 — no native split primitive in uw-be. Orchestrated here as: resolve this
 * task's own task_uid, fetch the parent file, split its bytes, resolve target
 * tasks from the workflow graph, register N children routed per §6.3.1
 * (chunks touching pages_with_errors go to the manual-fix task; clean chunks
 * go to the download-ready task), then complete the parent last.
 *
 * resolveActiveFile handles both "file already claimed by uw-fe's Assign
 * action" (the real launch-URL case) and "file just advanced here via the
 * DAG, never claimed" (the original assumption) — see its own doc comment.
 */
batchSplitRouter.post('/split', async (req, res) => {
  const body = req.body as SplitBody;

  const existing = inFlightSplits.get(body.fileId);
  if (existing?.busy) {
    res.status(409).json({
      ok: false,
      error:
        `Already working on this split (${existing.phase}). A gateway timeout doesn't mean it failed — ` +
        `check GET /split-status/${body.fileId} instead of clicking Split again right away.`,
      busy: true,
    });
    return;
  }

  const taskGraph = await getAllTasks({ projectCode: body.projectCode, workflowCode: body.workflowCode });
  if (!taskGraph.ok || !taskGraph.data) {
    res.status(409).json({ ok: false, error: taskGraph.error ?? 'get-all-tasks failed' });
    return;
  }
  const currentTask = taskGraph.data.find((t) => t.id === body.taskId);
  if (!currentTask) {
    res.status(409).json({ ok: false, error: `no task with id ${body.taskId} found in the workflow graph` });
    return;
  }

  let progress = inFlightSplits.get(body.fileId);
  if (progress) {
    progress.busy = true;
  }

  try {

  if (!progress) {
    progress = { phase: 'resolving parent file', parentCompleted: false, busy: true };
    inFlightSplits.set(body.fileId, progress);

    const parentContext = await resolveActiveFile({
      projectId: body.projectId,
      projectCode: body.projectCode,
      taskId: body.taskId,
      taskUid: currentTask.task_uid,
      fileId: body.fileId,
      jobId: body.jobId,
    });
    if (!parentContext.ok || !parentContext.data) {
      inFlightSplits.delete(body.fileId);
      res.status(404).json({ ok: false, error: parentContext.error ?? 'could not resolve parent file context' });
      return;
    }

    const downloadUrl = parentContext.data.input_download_url;
    if (!downloadUrl) {
      inFlightSplits.delete(body.fileId);
      res.status(409).json({ ok: false, error: 'could not resolve an input_download_url for the parent file' });
      return;
    }

    const pagesWithErrors = new Set<number>(
      (parentContext.data.meta_data as { pages_with_errors?: number[] } | undefined)?.pages_with_errors ?? [],
    );

    progress.phase = 'downloading parent file';
    const fileResponse = await fetch(downloadUrl);
    if (!fileResponse.ok) {
      inFlightSplits.delete(body.fileId);
      res.status(409).json({ ok: false, error: `failed to download parent file: HTTP ${fileResponse.status}` });
      return;
    }
    const parentBytes = Buffer.from(await fileResponse.arrayBuffer());

    const splitMethod: SplitMethod = body.splitMethod ?? 'equal-pages';

    // Resolve target tasks dynamically (§6.3.1) — never hardcode a task_uid.
    const downloadReadyTaskUid = findTaskUid(taskGraph.data, config.batchSplit.downloadReadyTaskCode);
    const manualFixTaskUid = findTaskUid(taskGraph.data, config.batchSplit.manualFixTaskCode);
    const transformTaskUid = findTaskUid(taskGraph.data, config.batchSplit.transformTaskCode);

    // by-chapter has no pages_with_errors yet (qualification hasn't run on these
    // chapters — that happens AFTER transformation, per-chapter), so every chunk
    // routes to the Transformation task (PDF text -> XML/JSON) instead of the
    // equal-pages download/manual-fix split. Transformation's own completion is
    // what routes each chapter onward to qualification (routes/transformation.ts).
    if (splitMethod === 'by-chapter' && !transformTaskUid) {
      inFlightSplits.delete(body.fileId);
      res.status(409).json({ ok: false, error: `no task with code "${config.batchSplit.transformTaskCode}" found in the workflow graph` });
      return;
    }
    if (splitMethod === 'equal-pages' && !downloadReadyTaskUid) {
      inFlightSplits.delete(body.fileId);
      res.status(409).json({ ok: false, error: `no task with code "${config.batchSplit.downloadReadyTaskCode}" found in the workflow graph` });
      return;
    }

    progress.phase = 'detecting chapters and splitting the PDF';
    const { chunks, usedFallback, detectionMethod } = await splitPdf(parentBytes, splitMethod);

    const plan: PlannedChunk[] = chunks.map((chunk) => {
      let targetTaskUid: string;
      let routedTo: PlannedChunk['routedTo'];
      if (splitMethod === 'by-chapter' && !usedFallback) {
        targetTaskUid = transformTaskUid!;
        routedTo = 'transformation';
      } else {
        const hasErrors = chunk.pageNumbers.some((p) => pagesWithErrors.has(p));
        // Intentional deviation from DAG-only routing — flagged to Vibhor per §6.3.1.
        targetTaskUid = hasErrors && manualFixTaskUid ? manualFixTaskUid : downloadReadyTaskUid!;
        routedTo = hasErrors ? 'manual-fix' : 'download-ready';
      }
      const baseFileName = chunk.label
        ? `${chunk.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}.pdf`
        : `${body.fileName.replace(/\.pdf$/i, '')}-part-${chunk.index + 1}.pdf`;
      return { chunk, targetTaskUid, routedTo, baseFileName, uploaded: false, releaseState: 'pending' };
    });

    progress.parentTaskUid = currentTask.task_uid;
    progress.splitMethod = splitMethod;
    progress.usedFallback = usedFallback;
    progress.detectionMethod = detectionMethod;
    progress.plan = plan;
  }

  const plan = progress.plan!;

  for (const planned of plan) {
    const chunkLabel = `chapter ${planned.chunk.index + 1} of ${plan.length}`;

    if (planned.registeredFileId === undefined) {
      progress.phase = `registering ${chunkLabel}`;
      const registered = await registerFile({
        projectCode: body.projectCode,
        jobId: body.jobId,
        batchId: body.batchId,
        firstTaskUid: planned.targetTaskUid,
        // Fresh suffix every attempt — a chunk that registered but then failed
        // later (no upload URL, upload error) already occupies its previous
        // attempt's filename in uw-be.
        fileName: withUniqueSuffix(planned.baseFileName),
        metaData: {
          parent_file_id: body.fileId,
          split_index: planned.chunk.index,
          ...(planned.chunk.label ? { chapter_title: planned.chunk.label } : {}),
        },
        userId: body.userId,
      });
      if (!registered.ok || !registered.data) {
        res.status(409).json({ ok: false, error: registered.error ?? `register-file failed for ${chunkLabel}`, retryable: true });
        return;
      }
      if (!registered.data.file_output_upload_url) {
        res.status(409).json({
          ok: false,
          error: `register-file for ${chunkLabel} returned no upload URL — check the target task's upload_to_storage flag. Click Split again to retry with a fresh registration.`,
          retryable: true,
        });
        return;
      }
      planned.registeredFileId = registered.data.file_id;
      planned.uploadUrl = registered.data.file_output_upload_url;
    }

    if (!planned.uploaded) {
      progress.phase = `uploading ${chunkLabel}`;
      try {
        await putRawBytes(planned.uploadUrl!, planned.chunk.bytes);
      } catch (err) {
        res.status(409).json({
          ok: false,
          error: `${err instanceof Error ? err.message : `upload failed for ${chunkLabel}`} — click Split again in a few seconds to resume.`,
          retryable: true,
        });
        return;
      }
      planned.uploaded = true;
    }

    // register-file's start_task:true is only needed to get file_output_upload_url
    // back in the same call (see registerFile's own doc comment) — it also
    // auto-claims the child as InProgress under whoever ran the split. A
    // different team typically owns the target task than the one running
    // batching, so release the claim right after uploading: this child should
    // surface through that task's own unclaimed queue / "Start next file" like
    // any other file, not be silently pre-owned. uw-be's own status machine
    // only allows YetToStart from OnHold (never directly from InProgress), so
    // this is a genuine two-hop release, not a single call.
    if (planned.releaseState === 'pending') {
      progress.phase = `releasing ${chunkLabel} (1/2)`;
      const releaseToHold = await tryUwbe(() =>
        updateFileStatus({
          projectCode: body.projectCode,
          taskUid: planned.targetTaskUid,
          fileId: planned.registeredFileId!,
          previousFileStatus: 'I',
          fileStatus: 'O',
          onholdReason: 'Released from auto-claim after batch-split — queued for assignment.',
          userId: body.userId,
        }),
      );
      if (!releaseToHold.ok) {
        res.status(409).json({
          ok: false,
          error: `${releaseToHold.error ?? `failed to release ${chunkLabel} to on-hold`} — click Split again in a few seconds to resume.`,
          retryable: true,
        });
        return;
      }
      planned.releaseState = 'held';
    }

    if (planned.releaseState === 'held') {
      progress.phase = `releasing ${chunkLabel} (2/2)`;
      const releaseToQueue = await tryUwbe(() =>
        updateFileStatus({
          projectCode: body.projectCode,
          taskUid: planned.targetTaskUid,
          fileId: planned.registeredFileId!,
          previousFileStatus: 'O',
          fileStatus: 'Y',
          userId: body.userId,
        }),
      );
      if (!releaseToQueue.ok) {
        res.status(409).json({
          ok: false,
          error: `${releaseToQueue.error ?? `failed to release ${chunkLabel} to the unclaimed queue`} — click Split again in a few seconds to resume.`,
          retryable: true,
        });
        return;
      }
      planned.releaseState = 'released';
    }
  }

  if (!progress.parentCompleted) {
    progress.phase = 'finalizing parent file';
    const parentTaskUid = progress.parentTaskUid!;
    const parentCompletion = await tryUwbe(() =>
      updateFileStatus({
        projectCode: body.projectCode,
        taskUid: parentTaskUid,
        fileId: body.fileId,
        previousFileStatus: 'I',
        fileStatus: 'C',
        userId: body.userId,
      }),
    );
    if (!parentCompletion.ok) {
      res.status(409).json({
        ok: false,
        error: `${parentCompletion.error ?? 'update-file-status failed for parent'} — all chapters are already split; click Split again in a few seconds to finish.`,
        retryable: true,
      });
      return;
    }
    progress.parentCompleted = true;
  }

  const children = plan.map((planned) => ({
    fileId: planned.registeredFileId!,
    // register-file's response has no task_uid — the file now sits at
    // whichever task we just registered it against.
    taskUid: planned.targetTaskUid,
    splitIndex: planned.chunk.index,
    pageNumbers: planned.chunk.pageNumbers,
    routedTo: planned.routedTo,
    label: planned.chunk.label,
  }));

  inFlightSplits.delete(body.fileId);
  res.json({
    ok: true,
    data: { children, splitMethod: progress.splitMethod, usedFallback: progress.usedFallback, detectionMethod: progress.detectionMethod },
  });

  } finally {
    // Only clears the flag on a progress object that's still in the map —
    // a no-op on the success path above, which already deleted it outright.
    const stillTracked = inFlightSplits.get(body.fileId);
    if (stillTracked) stillTracked.busy = false;
  }
});
