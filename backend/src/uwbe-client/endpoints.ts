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
  metaData?: Record<string, unknown>;
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
      meta_data: params.metaData,
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
  metaData?: Record<string, unknown>;
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
      // Confirmed required: without start_task=true, file_output_upload_url etc.
      // never populate at all, even with S3 storage configured correctly
      // (TaskProcessController.php:1300 gates the whole block on it).
      start_task: true,
      meta_data: params.metaData,
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
  /** Confirmed required alongside task_uid/project_code/file_id. */
  jobName: string;
  batchName: string;
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
      job_name: params.jobName,
      batch_name: params.batchName,
    },
  });
  if (!result.ok || !result.data) return { ...result, data: null };
  return { ...result, data: result.data.file };
}
