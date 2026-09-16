import { BACKEND_URL } from './config';
import type { TaskContext } from './types';

/** Calls the Fluid App Backend only — this app never talks to uw-be from the browser (§2). */

let apiToken: string | undefined;

export function setApiToken(token: string | undefined): void {
  apiToken = token;
}

/** §10 unmount hygiene — call from single-spa-entry's unmount lifecycle. */
export function clearApiToken(): void {
  apiToken = undefined;
}

export interface BackendResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  formData?: FormData;
}

async function callBackend<T>(path: string, opts: RequestOptions = {}): Promise<BackendResult<T>> {
  // new URL(path, BACKEND_URL) is wrong whenever BACKEND_URL has its own path
  // (e.g. deployed under /ext/app/api): a leading "/" on `path` makes the
  // WHATWG URL parser treat it as absolute-from-origin, silently discarding
  // BACKEND_URL's own path entirely (https://host/ext/app/api + /api/x
  // resolves to https://host/api/x, not .../ext/app/api/api/x — the latter
  // is what nginx's prefix-stripping proxy actually expects on the deployed
  // path, matching the plain http://localhost:4100/api/x shape locally
  // since there BACKEND_URL has no path to lose in the first place).
  // Plain string concatenation avoids that resolution behavior entirely.
  const url = new URL(BACKEND_URL.replace(/\/+$/, '') + path);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {};
  if (apiToken) headers['x-fluid-parcel-token'] = apiToken;

  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const response = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body });
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };

  if (!response.ok || json.ok === false) {
    return { ok: false, data: null, error: json.error ?? `request failed (HTTP ${response.status})` };
  }
  return { ok: true, data: json.data ?? null, error: null };
}

/** §3.3 — re-validate a raw context pointer before rendering any mode screen. */
export function revalidateTaskContext(pointer: TaskContext): Promise<BackendResult<TaskContext>> {
  return callBackend<TaskContext>('/api/task-context/resolve', { method: 'POST', body: pointer });
}

// ---------------------------------------------------------------------------
// §6.1 /acquisition
// ---------------------------------------------------------------------------

export interface AcquisitionResult {
  fileId: number;
  taskUid: string;
  gate: { isTextExtractable: boolean; totalPages: number; extractedCharCount: number };
  gateMode: 'flag' | 'reject';
}

export function registerAndUploadAcquisition(
  taskContext: TaskContext,
  file: File,
): Promise<BackendResult<AcquisitionResult>> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('projectCode', taskContext.projectCode);
  // workflowCode (e.g. "MAINFLOW") — NOT taskCode (the mode key, e.g. "ACQUISITION").
  // firstTaskUid must be the real task_uid string, NOT the internal numeric taskId.
  formData.append('workflowCode', taskContext.workflowCode ?? '');
  formData.append('firstTaskUid', taskContext.taskUid ?? '');
  formData.append('fileName', file.name);
  // jobId/batchId don't exist yet for a fresh "register new file" launch (no file yet) —
  // taskId + a timestamp is unique enough for this identifier's purpose.
  formData.append('fileUniqueIdentifier', `${taskContext.taskId}-${file.name}-${Date.now()}`);
  return callBackend<AcquisitionResult>('/api/acquisition/register-and-upload', { method: 'POST', formData });
}

// ---------------------------------------------------------------------------
// /bulk-registration — another content-acquisition entry point, not in
// FLUID_APP_DEV_CONTEXT.md's original §6. Takes a spreadsheet (one row per
// file to register) instead of a single manual upload; every row gets the
// same placeholder PDF, with a filename and metadata picked from the sheet's
// own columns. See README.md's "Bulk registration" section.
// ---------------------------------------------------------------------------

export interface ParsedSheet {
  sheetId: string;
  columns: string[];
  rowCount: number;
}

export function parseBulkRegistrationSheet(file: File): Promise<BackendResult<ParsedSheet>> {
  const formData = new FormData();
  formData.append('file', file);
  return callBackend<ParsedSheet>('/api/bulk-registration/parse', { method: 'POST', formData });
}

export interface BulkRegistrationRowResult {
  rowIndex: number;
  fileName: string;
  fileId?: number;
  ok: boolean;
  error?: string;
}

export interface BulkRegistrationResult {
  total: number;
  succeeded: number;
  failed: number;
  rows: BulkRegistrationRowResult[];
}

export function startBulkRegistration(
  taskContext: TaskContext,
  workflowCode: string,
  sheetId: string,
  fileNameColumn: string,
  metadataColumns: string[],
  /** Caps how many of the sheet's rows (in row order) get registered. Omit to process every row. */
  limit?: number,
): Promise<BackendResult<BulkRegistrationResult>> {
  return callBackend<BulkRegistrationResult>('/api/bulk-registration/start', {
    method: 'POST',
    body: {
      projectCode: taskContext.projectCode,
      workflowCode,
      firstTaskUid: taskContext.taskUid,
      sheetId,
      fileNameColumn,
      metadataColumns,
      limit,
      userId: taskContext.userId,
    },
  });
}

export interface BulkRegistrationStatus {
  phase: string;
  total: number;
  completed: number;
  failed: number;
}

/** Polled while startBulkRegistration's request is in flight — same in-process progress the backend resumes from on retry (see batch-split's own status-polling). */
export function getBulkRegistrationStatus(sheetId: string): Promise<BackendResult<BulkRegistrationStatus>> {
  return callBackend(`/api/bulk-registration/status/${sheetId}`);
}

// ---------------------------------------------------------------------------
// §6.2 /qualification
// ---------------------------------------------------------------------------

export interface QualificationContext {
  id: number;
  task_uid: string;
  file_name: string;
  /** Confirmed field name from get-task-next-file-with-start — NOT file_download_url. Can be null even for a legitimately-uploaded file; see backend/src/routes/qualification.ts. */
  input_download_url?: string | null;
  meta_data?: Record<string, unknown> | null;
}

export function getQualificationContext(taskContext: TaskContext, workflowCode: string): Promise<BackendResult<QualificationContext>> {
  return callBackend<QualificationContext>('/api/qualification/context', {
    method: 'GET',
    query: {
      projectId: taskContext.projectId,
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      fileId: taskContext.fileId,
      jobId: taskContext.jobId,
    },
  });
}

export function postPagesViewed(taskContext: TaskContext, taskUid: string, pagesViewed: number[]): Promise<BackendResult<null>> {
  return callBackend<null>('/api/qualification/pages-viewed', {
    method: 'POST',
    body: {
      projectCode: taskContext.projectCode,
      taskUid,
      fileId: taskContext.fileId,
      jobId: taskContext.jobId,
      pagesViewed,
    },
  });
}

export function updateQualificationMetadata(
  taskContext: TaskContext,
  taskUid: string,
  metaData: Record<string, string>,
): Promise<BackendResult<null>> {
  return callBackend<null>('/api/qualification/metadata', {
    method: 'POST',
    body: {
      projectCode: taskContext.projectCode,
      taskUid,
      fileId: taskContext.fileId,
      jobId: taskContext.jobId,
      metaData,
    },
  });
}

export type QualificationOutcome = 'clean' | 'rework' | 'archive';

export function completeQualification(
  taskContext: TaskContext,
  taskUid: string,
  outcome: QualificationOutcome,
  pagesWithErrors: number[],
  flowbackReason?: string,
): Promise<BackendResult<{ outcome: QualificationOutcome }>> {
  return callBackend('/api/qualification/complete', {
    method: 'POST',
    body: {
      projectCode: taskContext.projectCode,
      taskUid,
      fileId: taskContext.fileId,
      pagesWithErrors,
      outcome,
      flowbackReason,
      userId: taskContext.userId,
    },
  });
}

/**
 * Fetches the raw text of a file's own input_download_url via the backend
 * (avoids the browser hitting CORS on the presigned S3/MinIO URL directly).
 * Used for the structured-content viewer when meta_data.content_format is
 * 'xml'|'json' instead of the PDF iframe.
 */
export function fetchQualificationContent(url: string): Promise<BackendResult<{ content: string }>> {
  return callBackend<{ content: string }>('/api/qualification/content-proxy', {
    method: 'GET',
    query: { url },
  });
}

// ---------------------------------------------------------------------------
// §6.3 /batch
// ---------------------------------------------------------------------------

export type SplitMethod = 'equal-pages' | 'by-chapter';
export type ChapterDetectionMethod = 'outline' | 'text-scan' | 'equal-pages';

export interface BatchSplitChild {
  fileId: number;
  taskUid: string;
  splitIndex: number;
  pageNumbers: number[];
  routedTo: 'manual-fix' | 'download-ready' | 'transformation';
  label?: string;
}

export interface BatchSplitResult {
  children: BatchSplitChild[];
  splitMethod: SplitMethod;
  /** True when by-chapter was requested but no chapters were found any way, so it fell back to equal-pages. */
  usedFallback: boolean;
  /** How chapters were actually found — only present when splitMethod is 'by-chapter'. */
  detectionMethod?: ChapterDetectionMethod;
}

export function splitBatch(
  taskContext: TaskContext,
  workflowCode: string,
  splitMethod: SplitMethod,
): Promise<BackendResult<BatchSplitResult>> {
  return callBackend('/api/batch/split', {
    method: 'POST',
    body: {
      projectId: taskContext.projectId,
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      jobId: taskContext.jobId,
      batchId: taskContext.batchId,
      fileId: taskContext.fileId,
      fileName: taskContext.fileName ?? `file-${taskContext.fileId}.pdf`,
      userId: taskContext.userId,
      splitMethod,
    },
  });
}

export interface BatchSplitStatus {
  phase: string;
  totalChunks: number;
  chunksReleased: number;
  parentCompleted: boolean;
}

/** Polled while splitBatch's request is in flight — same in-process progress the backend resumes from on retry. */
export function getBatchSplitStatus(fileId: number): Promise<BackendResult<BatchSplitStatus>> {
  return callBackend(`/api/batch/split-status/${fileId}`);
}

// ---------------------------------------------------------------------------
// /transformation — new task, not in FLUID_APP_DEV_CONTEXT.md's original §6
// (see README.md's "Transformation" section for the deliberate scope change)
// ---------------------------------------------------------------------------

export type TransformFormat = 'xml' | 'json';

export interface TransformResult {
  fileId: number;
  taskUid: string;
  format: TransformFormat;
  pageCount: number;
}

export function transformFile(
  taskContext: TaskContext,
  workflowCode: string,
  format: TransformFormat,
): Promise<BackendResult<TransformResult>> {
  return callBackend('/api/transformation/transform', {
    method: 'POST',
    body: {
      projectId: taskContext.projectId,
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      jobId: taskContext.jobId,
      batchId: taskContext.batchId,
      fileId: taskContext.fileId,
      fileName: taskContext.fileName ?? `file-${taskContext.fileId}.pdf`,
      format,
      userId: taskContext.userId,
    },
  });
}

// ---------------------------------------------------------------------------
// §6.4 /download
// ---------------------------------------------------------------------------

export interface DownloadLink {
  fileId: number;
  ok: boolean;
  downloadUrl: string | null;
  fileName: string | null;
  status: string | null;
  error: string | null;
}

export function getDownloadLinks(
  taskContext: TaskContext,
  workflowCode: string,
  fileIds: number[],
): Promise<BackendResult<{ links: DownloadLink[] }>> {
  return callBackend('/api/download', {
    method: 'GET',
    query: {
      projectId: taskContext.projectId,
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      fileIds: fileIds.join(','),
    },
  });
}
