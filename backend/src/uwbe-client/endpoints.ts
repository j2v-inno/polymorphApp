import { callUwbe, assertProjectCode } from './http.js';
import type { UwbeResult } from '../types.js';

/**
 * Typed wrappers for every uw-be endpoint this app calls (FLUID_APP_DEV_CONTEXT.md §6).
 * Shapes below are verified against the real controllers (TaskProcessController.php,
 * FileController.php, TaskController.php in uw-be), not just the design doc — several
 * doc-stated field names/params turned out wrong (see inline notes). Anything still
 * marked TODO wasn't directly confirmed; treat it as a plausible guess only.
 */

// ---------------------------------------------------------------------------
// §6.1 /acquisition
// ---------------------------------------------------------------------------

export interface RegisterJobBatchFileParams {
  projectCode: string;
  workflowCode: string;
  firstTaskUid: string;
  fileName: string;
  filePath: string;
  fileUniqueIdentifier: string;
  /**
   * Sent as `file_meta_data` — register_job_batch_file (TaskProcessController.php:1239)
   * is the one endpoint that reads `file_meta_data` rather than `meta_data` (like
   * register-file/update-file-status do). Sending `meta_data` silently drops it.
   */
  metaData?: Record<string, unknown>;
  /**
   * uw-be defaults this to 1 (system) when omitted (TaskProcessController.php:903,
   * `$request->user_id ?? 1`) and that's who ends up "claiming" the file's
   * file_task_users session. If a caller later completes this same file with
   * an explicit different userId (see updateFileStatus's own userId doc
   * comment), the completion UPDATE's `user_id = ?` guard won't match this
   * session at all and uw-be throws the misleading "File is already
   * updated." — confirmed live via bulk-registration.ts. Pass the same
   * userId here that completion will use to keep the whole row's claiming
   * session consistent, rather than leaving this defaulted to system.
   */
  userId?: number;
}

export interface RegisterJobBatchFileResult {
  file_id: number;
  project_id: number;
  job_id: number;
  batch_id: number;
  job_name: string;
  batch_name: string;
  /** Pre-signed S3 PUT target for step 2 of §6.1. */
  file_output_upload_url: string;
  file_output_path: string;
  file_s3_path: string;
}

export function registerJobBatchFile(params: RegisterJobBatchFileParams): Promise<UwbeResult<RegisterJobBatchFileResult>> {
  assertProjectCode(params.projectCode);
  return callUwbe<RegisterJobBatchFileResult>('register-job-batch-file', {
    method: 'POST',
    body: {
      project_code: params.projectCode,
      workflow_code: params.workflowCode,
      first_task_uid: params.firstTaskUid,
      file_name: params.fileName,
      file_path: params.filePath,
      // Confirmed required: without start_task=true, the entire file_output_path/
      // file_s3_path/file_output_upload_url block never runs (TaskProcessController.php:753)
      // — they all come back null even with S3 storage configured correctly.
      start_task: true,
      // Real param is `unique_identifier` — the doc's `file_unique_identifier` doesn't
      // exist on TaskProcessController@register_job_batch_file (uw-be:829-847).
      unique_identifier: params.fileUniqueIdentifier,
      file_meta_data: params.metaData,
      user_id: params.userId,
    },
  });
}

export interface UpdateFileStatusParams {
  projectCode: string;
  // The response to register-job-batch-file/register-file does NOT include a
  // task_uid — the file simply sits at whichever task you passed as
  // first_task_uid. Callers must track/resolve task_uid themselves (e.g. it's
  // the same value you registered with, or resolved via getAllTasks).
  taskUid: string;
  fileId: number;
  previousFileStatus: string;
  /** "C" complete, "O" on-hold (requires onholdReason), etc. */
  fileStatus: string;
  metaData?: Record<string, unknown>;
  onholdReason?: string;
  nextTask?: string;
  /**
   * uw-be defaults this to 1 (system) when omitted — a real gap: the file's
   * open file_task_users session belongs to whoever actually claimed it
   * (uw-fe's real "Assign" action claims as the logged-in user), and the
   * completion UPDATE is guarded on `user_id = ? and file_status_ended is
   * null` matching THAT session. Omitting userId here throws "File is
   * already updated." the moment the claiming user isn't 1 — which every
   * real (non-test-default) uw-fe user is.
   */
  userId?: number;
}

/** Style A (TaskProcessController@update_file_status) — `data` is always null on success. */
export function updateFileStatus(params: UpdateFileStatusParams): Promise<UwbeResult<null>> {
  assertProjectCode(params.projectCode);
  if (params.fileStatus === 'O' && !params.onholdReason) {
    throw new Error('onholdReason is required when fileStatus is "O" (FLUID_APP_DEV_CONTEXT.md §6.1)');
  }
  return callUwbe<null>('update-file-status', {
    method: 'POST',
    body: {
      project_code: params.projectCode,
      task_uid: params.taskUid,
      file_id: params.fileId,
      previous_file_status: params.previousFileStatus,
      file_status: params.fileStatus,
      meta_data: params.metaData,
      onhold_reason: params.onholdReason,
      next_task: params.nextTask,
      user_id: params.userId,
    },
  });
}

// ---------------------------------------------------------------------------
// §6.2 /qualification
// ---------------------------------------------------------------------------

export interface GetTaskOngoingFileParams {
  projectId: number;
  taskId: number;
  /**
   * Optional — omit to ask "what file does userId currently have active at
   * this task" instead of looking up a known file (fixed uw-be-side to accept
   * this; previously file_id/job_id were required unconditionally, which
   * external-app launch URLs that don't carry a file_id had no way to
   * satisfy). userId is required by uw-be when fileId is omitted.
   */
  fileId?: number;
  jobId?: number;
  userId?: number;
}

export interface TaskOngoingFile {
  file_id: number;
  file_name: string;
  /** Confirmed field (TaskProcessController.php:4099,4220-4223) — NOT `file_download_url`. */
  download_url?: string;
  /** Confirmed — raw storage key, not directly fetchable without signing. */
  s3_file_path?: string;
  /** Confirmed, get-task-ongoing-file only — external-app-integration URL. */
  url_to_open?: string;
  /** Confirmed, get-task-ongoing-file only, present only when return_file_content=1 was passed. */
  file_content?: string;
  /** TODO: not directly confirmed on this row — plausible since file_task links file+task, but verify against a live call. */
  task_uid?: string;
  meta_data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GetTaskNextFileWithStartParams {
  projectCode: string;
  taskUid: string;
  fileId: number;
}

export interface StartedTaskFile {
  id: number;
  file_name: string;
  job_name: string;
  batch_name: string | null;
  file_task_id: number;
  meta_data: Record<string, unknown> | null;
  job_id: number;
  batch_id: number | null;
  project_id: number;
  task_id: number;
  /** Confirmed field — NOT `download_url` (that's get-task-ongoing-file's naming). Can be null even for a legitimately-uploaded previous-task file — see batch-split.ts notes on input_source_user_task_id. */
  input_download_url?: string | null;
  s3_path?: string | null;
  output_path?: string;
  input_path?: string;
  [key: string]: unknown;
}

/**
 * Style A. `get-task-ongoing-file` only reads an ALREADY-STARTED file_task_users
 * session — it 400s with "Invalid request of file status already completed" if
 * no such session exists yet, which is the normal case the first time a task
 * screen opens for a file that just advanced here via the DAG. This endpoint
 * (TaskProcessController@get_task_next_file_with_start) is what actually
 * creates that session ("claims" the file for a task) and returns its data in
 * the same call — call this when a screen mounts, not get-task-ongoing-file,
 * whose role is closer to "refresh an already-in-progress session."
 */
export async function getTaskNextFileWithStart(params: GetTaskNextFileWithStartParams): Promise<UwbeResult<StartedTaskFile>> {
  assertProjectCode(params.projectCode);
  const result = await callUwbe<{ file: StartedTaskFile }>('get-task-next-file-with-start', {
    method: 'POST',
    body: {
      project_code: params.projectCode,
      task_uid: params.taskUid,
      file_id: params.fileId,
    },
  });
  if (!result.ok || !result.data) return { ...result, data: null };
  return { ...result, data: result.data.file };
}

/** Style A. Real response is `data: { file: {...} }` — unwrapped here so callers get the file row directly. */
export async function getTaskOngoingFile(params: GetTaskOngoingFileParams): Promise<UwbeResult<TaskOngoingFile>> {
  const result = await callUwbe<{ file: TaskOngoingFile }>('get-task-ongoing-file', {
    method: 'GET',
    query: {
      project_id: params.projectId,
      task_id: params.taskId,
      file_id: params.fileId,
      job_id: params.jobId,
      user_id: params.userId,
    },
  });
  if (!result.ok || !result.data) return { ...result, data: null };
  return { ...result, data: result.data.file };
}

export interface ResolveActiveFileParams {
  projectId: number;
  projectCode: string;
  taskId: number;
  taskUid: string;
  fileId: number;
  jobId?: number;
}

export interface ActiveFileContext {
  meta_data?: Record<string, unknown> | null;
  input_download_url?: string | null;
  s3_path?: string | null;
  taskUid: string;
  [key: string]: unknown;
}

/**
 * Resolves the file for a task screen regardless of whether it's already
 * claimed or not — a real gap this exposed: get-task-next-file-with-start
 * (the original choice, see its own doc comment) only finds YetToStart files,
 * which is correct the first time a file advances here via the DAG with no
 * session yet, but wrong once uw-fe's own "Assign" action has already claimed
 * it (InProgress) before redirecting to this app's external-app launch URL —
 * the real-world case for any task reached that way. Tries
 * get-task-ongoing-file (handles "already claimed") first, falls back to
 * get-task-next-file-with-start (handles "fresh from the DAG, never
 * claimed") — and normalizes the two endpoints' differently-named download
 * URL fields (download_url/s3_file_path vs input_download_url/s3_path) into
 * one shape so callers don't need to care which path resolved it.
 */
export async function resolveActiveFile(params: ResolveActiveFileParams): Promise<UwbeResult<ActiveFileContext>> {
  const ongoing = await getTaskOngoingFile({
    projectId: params.projectId,
    taskId: params.taskId,
    fileId: params.fileId,
    jobId: params.jobId,
  });
  if (ongoing.ok && ongoing.data) {
    return {
      ok: true,
      error: null,
      httpStatus: ongoing.httpStatus,
      data: {
        ...ongoing.data,
        input_download_url: ongoing.data.download_url as string | null | undefined,
        s3_path: ongoing.data.s3_file_path as string | null | undefined,
        taskUid: params.taskUid,
      },
    };
  }

  const started = await getTaskNextFileWithStart({
    projectCode: params.projectCode,
    taskUid: params.taskUid,
    fileId: params.fileId,
  });
  if (!started.ok || !started.data) {
    return {
      ok: false,
      data: null,
      error: started.error ?? ongoing.error ?? 'could not resolve an active file',
      httpStatus: started.httpStatus,
    };
  }
  return {
    ok: true,
    error: null,
    httpStatus: started.httpStatus,
    data: { ...started.data, taskUid: params.taskUid },
  };
}

export interface UpdateFileMetaDataParams {
  projectCode: string;
  taskUid: string;
  fileId: number;
  jobId: number;
  metaData: Record<string, unknown>;
}

/** Style A (TaskProcessController@update_file_meta_data) — `data` is always null on success. Non-audited — use for incidental telemetry like pages_viewed (§6.2 step 2). */
export function updateFileMetaData(params: UpdateFileMetaDataParams): Promise<UwbeResult<null>> {
  assertProjectCode(params.projectCode);
  return callUwbe<null>('update-file-meta-data', {
    method: 'POST',
    body: {
      project_code: params.projectCode,
      task_uid: params.taskUid,
      file_id: params.fileId,
      job_id: params.jobId,
      meta_data: params.metaData,
    },
  });
}

export interface FlowBackFileTaskParams {
  projectCode: string;
  taskUid: string;
  fileId: number;
  flowbackReason: string;
  isReset?: boolean;
  assignedTo?: number;
  /** Same user_id-defaults-to-1 gap as updateFileStatus — see its param doc. */
  userId?: number;
}

/**
 * The one genuinely Style B endpoint (FileController@flow_back_file_task) — and
 * its real shape is narrower than Style B elsewhere in this doc's design: it is
 * ALWAYS exactly `{status: boolean, error: string}`, no other payload, ever.
 */
export function flowBackFileTask(params: FlowBackFileTaskParams): Promise<UwbeResult<Record<string, unknown>>> {
  assertProjectCode(params.projectCode);
  return callUwbe('flow-back-file-task', {
    method: 'POST',
    body: {
      project_code: params.projectCode,
      task_uid: params.taskUid,
      file_id: params.fileId,
      flowback_reason: params.flowbackReason,
      is_reset: params.isReset,
      assigned_to: params.assignedTo,
      user_id: params.userId,
    },
  });
}

// ---------------------------------------------------------------------------
// §6.3 /batch
// ---------------------------------------------------------------------------

export interface RegisterFileParams {
  projectCode: string;
  jobId: number;
  batchId: number;
  firstTaskUid: string;
  fileName: string;
  /** Defaults to fileName — same pattern as registerJobBatchFile's filePath. */
  filePath?: string;
  metaData?: Record<string, unknown>;
  /** Who register-file's start_task claims the file as — uw-be defaults to user 1 when omitted. */
  userId?: number;
}

export interface RegisterFileResult {
  file_id: number;
  project_id: number;
  job_id: number;
  batch_id: number;
  file_output_path: string;
  file_s3_path: string;
  /** Pre-signed S3 PUT target — caller must PUT the chunk's bytes here (see putRawBytes in http.ts). */
  file_output_upload_url: string;
}

/**
 * Does NOT send bytes in this call. `file_data` (bytes embedded directly in the
 * request) is real, but capped by server-side validation at "may not be greater
 * than 500000 characters" (~375KB raw) and must be a genuine multipart file field,
 * not base64 JSON — confirmed by hitting the real endpoint directly. Too small
 * for realistic split chunks, so this always uses the same register-then-PUT
 * pattern as acquisition (registerJobBatchFile + putRawBytes).
 *
 * file_path and file_status are both `required` server-side (the latter must
 * be exactly 'Y') — never previously exercised far enough to hit this: every
 * earlier real-uw-be test was blocked upstream by the input_download_url gap
 * before reaching this call at all, so the missing fields went unnoticed
 * until that gap was actually fixed.
 */
export function registerFile(params: RegisterFileParams): Promise<UwbeResult<RegisterFileResult>> {
  assertProjectCode(params.projectCode);
  return callUwbe<RegisterFileResult>('register-file', {
    method: 'POST',
    body: {
      project_code: params.projectCode,
      job_id: params.jobId,
      batch_id: params.batchId,
      first_task_uid: params.firstTaskUid,
      file_name: params.fileName,
      file_path: params.filePath ?? params.fileName,
      file_status: 'Y',
      // Confirmed required: without start_task=true, file_output_upload_url etc.
      // never populate at all, even with S3 storage configured correctly
      // (TaskProcessController.php:1300 gates the whole block on it).
      start_task: true,
      meta_data: params.metaData,
      user_id: params.userId,
    },
  });
}

export interface TaskGraphNode {
  /** Internal numeric id — matches TaskContext.taskId. */
  id: number;
  task_uid: string;
  /** Confirmed DB column is `code`, not `task_code` (projects_table migration:51) — `task_code` is only a SQL alias uw-be uses internally on two other endpoints' joined queries. */
  code: string;
  task_order: number;
  [key: string]: unknown;
}

export interface GetAllTasksParams {
  projectCode: string;
  workflowCode: string;
}

/** Style A — `data` is a bare array of raw Task rows (not `{tasks: [...]}`). No DAG edges included. */
export function getAllTasks(params: GetAllTasksParams): Promise<UwbeResult<TaskGraphNode[]>> {
  assertProjectCode(params.projectCode);
  return callUwbe<TaskGraphNode[]>('get-all-tasks', {
    method: 'GET',
    query: {
      project_code: params.projectCode,
      workflow_code: params.workflowCode,
    },
  });
}

// ---------------------------------------------------------------------------
// §6.4 /download
// ---------------------------------------------------------------------------

export interface GetFileTaskOutputParams {
  projectCode: string;
  /** Confirmed required (TaskProcessController.php:4511-4521) — the task the file currently sits at. */
  taskUid: string;
  fileId: number;
  /** Both nullable server-side (get_file_task_output's own validator) — CHAPTERFLOW's files have no batch at all. */
  jobName?: string;
  batchName?: string;
}

export interface FileTaskOutput {
  file_id: number;
  file_name: string;
  /** Confirmed field (TaskProcessController.php:4630,4660-4663). */
  download_url: string;
  s3_file_path?: string;
  /** TODO: plausible column name (matches update-file-status's file_status enum O/P/C/I/Y/BQ) but not directly confirmed on this row. */
  file_status?: string;
}

/** Style A. Real response is `data: { file: {...} }` — unwrapped here so callers get the file row directly. */
export async function getFileTaskOutput(params: GetFileTaskOutputParams): Promise<UwbeResult<FileTaskOutput>> {
  assertProjectCode(params.projectCode);
  const result = await callUwbe<{ file: FileTaskOutput }>('get-file-task-output', {
    method: 'GET',
    query: {
      project_code: params.projectCode,
      task_uid: params.taskUid,
      file_id: params.fileId,
      job_name: params.jobName || undefined,
      batch_name: params.batchName || undefined,
    },
  });
  if (!result.ok || !result.data) return { ...result, data: null };
  return { ...result, data: result.data.file };
}
