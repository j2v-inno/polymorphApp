import { getFileTaskStatus, updateFileStatus } from '../uwbe-client/endpoints.js';
import { workerConfig } from './config.js';
import { handlers } from './handlers/index.js';
import type { FileTaskMessage } from './payload.js';
import { downloadFileTaskInput, downloadTaskOutput, taskCodeFor } from './uwbe.js';

/** What to do with the SQS message once the attempt is over. */
export type Outcome = { ack: true; note: string } | { ack: false; note: string };

const label = (msg: FileTaskMessage, code: string) => `${code} file=${msg.file_id} ft=${msg.file_task_id}`;

/** Where the file stands at the message's task: a status letter, or null when it is no longer active there. */
async function statusAtTask(msg: FileTaskMessage): Promise<string | null> {
  const result = await getFileTaskStatus({ projectId: msg.project_id, taskId: msg.task_id, fileId: msg.file_id });
  if (result.httpStatus === 404) return null;
  if (!result.ok) throw new Error(`get-file-task-status failed: ${result.error}`);
  return result.data?.file_task_status ?? null;
}

/**
 * One delivery of one message, following the consumer contract: dedupe on where the file stands, claim (Y → I),
 * read the input, run the handler, complete (I → C) with its output. Throws on failure, so the message returns.
 */
export async function processMessage(msg: FileTaskMessage): Promise<Outcome> {
  const code = await taskCodeFor(msg.task_uid);
  const handler = handlers[code];
  if (!handler) return { ack: false, note: `no handler for task ${code}` };

  const status = await statusAtTask(msg);
  if (status === null) return { ack: true, note: `${label(msg, code)} is no longer at this task` };

  if (handler.kind === 'trigger') {
    await handler.run(msg);
    return { ack: true, note: `${label(msg, code)} triggered` };
  }

  if (status !== 'Y' && status !== 'I') return { ack: true, note: `${label(msg, code)} already ${status}` };
  const base = { projectCode: msg.project_code, taskUid: msg.task_uid, fileId: msg.file_id, userId: workerConfig.userId };
  if (status === 'Y') {
    const claimed = await updateFileStatus({ ...base, previousFileStatus: 'Y', fileStatus: 'I' });
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.error}`);
  }

  const started = Date.now();
  const input = handler.inputFrom ? await downloadTaskOutput(msg, handler.inputFrom) : await downloadFileTaskInput(msg);
  const result = await handler.run({ msg, taskCode: code, input });

  const completed = await updateFileStatus({
    ...base,
    previousFileStatus: 'I',
    fileStatus: 'C',
    metaData: { ...result.metaData, [`${code.toLowerCase()}_ms`]: Date.now() - started },
    fileData: result.output,
  });
  if (!completed.ok) throw new Error(`complete failed: ${completed.error}`);

  if (handler.afterComplete) await handler.afterComplete(msg).catch((err) => console.warn(`[worker] after ${code}: ${err}`));
  return { ack: true, note: `${label(msg, code)} done in ${Date.now() - started}ms (${result.output.bytes.length} bytes)` };
}

/** After too many failed deliveries: hold the file in Orion with the reason, so the failure is visible there. */
export async function giveUp(msg: FileTaskMessage, reason: string): Promise<void> {
  const status = await statusAtTask(msg).catch(() => null);
  if (status !== 'I' && status !== 'Y') return;
  const base = { projectCode: msg.project_code, taskUid: msg.task_uid, fileId: msg.file_id, userId: workerConfig.userId };
  if (status === 'Y') await updateFileStatus({ ...base, previousFileStatus: 'Y', fileStatus: 'I' });
  const held = await updateFileStatus({
    ...base,
    previousFileStatus: 'I',
    fileStatus: 'O',
    onholdReason: `Automated step failed: ${reason}`.slice(0, 250),
  });
  if (!held.ok) console.error(`[worker] could not hold file ${msg.file_id}: ${held.error}`);
}
