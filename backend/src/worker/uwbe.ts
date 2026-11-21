import { config } from '../config.js';
import { callUwbe } from '../uwbe-client/http.js';
import { getAllTasks, getFileTaskOutput, getTaskWithNextTasks } from '../uwbe-client/endpoints.js';
import type { UwbeResult } from '../types.js';
import type { FileTaskMessage } from './payload.js';

export interface TaskInput {
  bytes: Buffer;
  fileName: string;
}

/** The file's input at its current task, as raw bytes (download-file-task-input). Needs download_from_storage on the task. */
export async function downloadFileTaskInput(msg: FileTaskMessage): Promise<TaskInput> {
  const base = config.uwbe.baseUrl.endsWith('/') ? config.uwbe.baseUrl : `${config.uwbe.baseUrl}/`;
  const url = new URL('download-file-task-input', base);
  url.searchParams.set('project_code', msg.project_code);
  url.searchParams.set('task_uid', msg.task_uid);
  url.searchParams.set('file_id', String(msg.file_id));

  const response = await fetch(url, { headers: { 'api-token': config.uwbe.apiToken } });
  const type = response.headers.get('content-type') ?? '';
  // The file comes through a redirect to storage; a JSON body without one is Orion's error envelope.
  if (!response.ok || (!response.redirected && type.includes('application/json'))) {
    const text = await response.text().catch(() => '');
    throw new Error(`download-file-task-input failed (HTTP ${response.status}): ${text.split('<')[0].trim().slice(0, 300)}`);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  // S3 sets the name on the signed link; a local-disk redirect only has it in the URL path.
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? new URL(response.url).pathname.split('/').pop();
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    fileName: named ? decodeURIComponent(named) : `file-${msg.file_id}`,
  };
}

/** The file's output at an earlier task of its workflow, found by task code (get-file-task-output). */
export async function downloadTaskOutput(msg: FileTaskMessage, taskCode: string): Promise<TaskInput> {
  const tasks = await getAllTasks({ projectCode: msg.project_code, workflowCode: msg.workflow_code });
  const task = tasks.data?.find((t) => t.code === taskCode);
  if (!tasks.ok || !task) throw new Error(`workflow ${msg.workflow_code} has no task ${taskCode}: ${tasks.error ?? 'not found'}`);

  const output = await getFileTaskOutput({ projectCode: msg.project_code, taskUid: task.task_uid, fileId: msg.file_id });
  if (!output.ok || !output.data?.download_url) throw new Error(`get-file-task-output at ${taskCode} failed: ${output.error ?? 'no download_url'}`);

  const response = await fetch(output.data.download_url);
  if (!response.ok) throw new Error(`reading ${taskCode} output failed (HTTP ${response.status})`);
  const fileName = decodeURIComponent(new URL(response.url).pathname.split('/').pop() ?? `file-${msg.file_id}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), fileName };
}

const taskCodes = new Map<string, string>();

/** The task's code (e.g. TEXT_EXTRACT) for a task_uid. Cached: a rebuilt workflow gets new uids, so old ones never collide. */
export async function taskCodeFor(taskUid: string): Promise<string> {
  const cached = taskCodes.get(taskUid);
  if (cached) return cached;
  const result = await getTaskWithNextTasks(taskUid);
  if (!result.ok || !result.data?.code) {
    throw new Error(`could not resolve task ${taskUid}: ${result.error ?? 'no code in tasks/{uid}'}`);
  }
  taskCodes.set(taskUid, result.data.code);
  return result.data.code;
}

/** Starts Orion's auto QA cluster job for a cluster task. Orion throttles this to once per 120s per task. */
export function createQaClusterAutomatically(msg: FileTaskMessage): Promise<UwbeResult<unknown>> {
  return callUwbe('create-qa-cluster-automatically', {
    method: 'POST',
    body: { project_code: msg.project_code, task_uid: msg.task_uid },
  });
}
