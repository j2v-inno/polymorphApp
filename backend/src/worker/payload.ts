/** The body SqsService::pushFileTask() publishes (uw-be docs/infra/external-app-sqs-consumer.md §3). */
export interface FileTaskMessage {
  api_base_url: string;
  project_id: number;
  project_code: string;
  workflow_id: number;
  workflow_code: string;
  task_id: number;
  task_uid: string;
  file_id: number;
  /** Stable across redeliveries: the idempotency key. */
  file_task_id: number;
  job_metadata: Record<string, unknown>;
  file_metadata: Record<string, unknown>;
  custom_data: Record<string, unknown>;
}

const REQUIRED = ['project_id', 'project_code', 'workflow_code', 'task_id', 'task_uid', 'file_id', 'file_task_id'] as const;

/** Parses a message body, or throws when it is not an Orion file-task message (e.g. a Laravel job on the wrong queue). */
export function parseMessage(body: string | undefined): FileTaskMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new Error('message body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('message body is not an object');
  const msg = parsed as Record<string, unknown>;
  const missing = REQUIRED.filter((key) => msg[key] === undefined || msg[key] === null || msg[key] === '');
  if (missing.length) throw new Error(`not an Orion file-task message (missing ${missing.join(', ')})`);
  const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  return {
    ...(msg as unknown as FileTaskMessage),
    job_metadata: asObject(msg.job_metadata),
    file_metadata: asObject(msg.file_metadata),
    custom_data: asObject(msg.custom_data),
  };
}
