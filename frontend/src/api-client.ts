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
  const url = new URL(path, BACKEND_URL);
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
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      fileId: taskContext.fileId,
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
    },
  });
}

// ---------------------------------------------------------------------------
// §6.3 /batch
// ---------------------------------------------------------------------------

export interface BatchSplitChild {
  fileId: number;
  taskUid: string;
  splitIndex: number;
  pageNumbers: number[];
  routedTo: 'manual-fix' | 'download-ready';
}

export function splitBatch(taskContext: TaskContext, workflowCode: string): Promise<BackendResult<{ children: BatchSplitChild[] }>> {
  return callBackend('/api/batch/split', {
    method: 'POST',
    body: {
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      jobId: taskContext.jobId,
      batchId: taskContext.batchId,
      fileId: taskContext.fileId,
      fileName: taskContext.fileName ?? `file-${taskContext.fileId}.pdf`,
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
      projectCode: taskContext.projectCode,
      workflowCode,
      taskId: taskContext.taskId,
      jobName: taskContext.jobName ?? '',
      batchName: taskContext.batchName ?? '',
      fileIds: fileIds.join(','),
    },
  });
}
