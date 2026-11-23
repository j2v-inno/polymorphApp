import 'dotenv/config';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { workerConfig } from './config.js';
import { parseMessage } from './payload.js';
import { handlers } from './handlers/index.js';
import { fileStep, heartbeat, startWorkerMonitor } from './monitor.js';
import { giveUp, processMessage } from './pipeline.js';
import { taskCodeFor } from './uwbe.js';

startWorkerMonitor();

const sqs = new SQSClient({
  region: workerConfig.region,
  endpoint: workerConfig.endpoint,
  // ElasticMQ accepts any key; the real endpoint uses the SDK's default credential chain.
  ...(workerConfig.endpoint && !process.env.AWS_ACCESS_KEY_ID
    ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
    : {}),
});

let stopping = false;
const startedAt = new Date().toISOString();
let busyWith: { task: string; fileId: number } | null = null;
// Messages handed back because they belong to another project or app. Counted only: their contents are not ours to show.
let handedBack = 0;
const scoped = workerConfig.onlyProjects.length > 0 || workerConfig.onlyWorkflows.length > 0;

/** Tells the monitor page the worker is alive, what it reads and how it is set up. */
function beat(): void {
  heartbeat({
    pid: process.pid,
    startedAt,
    queueUrl: workerConfig.queueUrl,
    orionUrl: config.uwbe.baseUrl,
    tasks: Object.keys(handlers),
    settings: {
      wait_seconds: workerConfig.waitSeconds,
      visibility_seconds: workerConfig.visibilitySeconds,
      max_messages: workerConfig.maxMessages,
      max_receives: workerConfig.maxReceives,
      acting_user_id: workerConfig.userId,
      transmission_source: process.env.TRANSMISSION_SOURCE_TASK ?? 'MARKUP_REVIEW',
      only_projects: workerConfig.onlyProjects.join(',') || 'any',
      only_workflows: workerConfig.onlyWorkflows.join(',') || 'any',
      ...(scoped ? { handed_back_to_queue: handedBack } : {}),
    },
    busyWith,
  });
}
const log = (line: string) => console.log(`${new Date().toISOString()} [worker] ${line}`);

async function ack(message: Message): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: workerConfig.queueUrl, ReceiptHandle: message.ReceiptHandle }));
}

/** Makes the message visible again at once, for whichever consumer it is meant for. */
async function handBack(message: Message): Promise<void> {
  handedBack++;
  await sqs
    .send(new ChangeMessageVisibilityCommand({ QueueUrl: workerConfig.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }))
    .catch(() => {
      // It comes back by itself when the receive's visibility timeout runs out.
    });
}

/** Whether this worker should process the message. Unscoped, everything is; scoped, only the named projects and workflows. */
function isOurs(message: Message): boolean {
  if (!scoped) return true;
  try {
    const msg = parseMessage(message.Body);
    return (
      (workerConfig.onlyProjects.length === 0 || workerConfig.onlyProjects.includes(msg.project_code)) &&
      (workerConfig.onlyWorkflows.length === 0 || workerConfig.onlyWorkflows.includes(msg.workflow_code))
    );
  } catch {
    // Not an Orion file-task message: on a shared queue that is some other consumer's.
    return false;
  }
}

async function handle(message: Message): Promise<void> {
  const receives = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
  let msg;
  try {
    msg = parseMessage(message.Body);
  } catch (err) {
    log(`dropping ${message.MessageId}: ${err instanceof Error ? err.message : err}`);
    await ack(message);
    return;
  }
  if (msg.api_base_url && !config.uwbe.baseUrl.startsWith(msg.api_base_url)) {
    log(`note: message names ${msg.api_base_url}, calling UWBE_BASE_URL ${config.uwbe.baseUrl}`);
  }

  const code = await taskCodeFor(msg.task_uid).catch(() => '?');
  busyWith = { task: code, fileId: msg.file_id };
  beat();
  try {
    const outcome = await processMessage(msg, receives);
    log(outcome.note);
    if (outcome.ack) await ack(message);
    else if (receives >= workerConfig.maxReceives) await ack(message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`file=${msg.file_id} attempt ${receives}/${workerConfig.maxReceives} failed: ${reason}`);
    fileStep(msg, code, 'failed', { attempt: receives, error: reason, note: receives >= workerConfig.maxReceives ? 'last attempt' : 'the message comes back for another attempt' });
    if (receives >= workerConfig.maxReceives) {
      await giveUp(msg, reason);
      await ack(message);
      log(`file=${msg.file_id} put on hold after ${receives} attempts`);
    }
  } finally {
    busyWith = null;
    beat();
  }
}

async function main(): Promise<void> {
  if (workerConfig.createQueue) {
    const name = workerConfig.queueUrl.split('/').pop()!;
    await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: String(workerConfig.visibilitySeconds) } }));
  }
  log(`polling ${workerConfig.queueUrl}, calling ${config.uwbe.baseUrl}`);

  while (!stopping) {
    beat();
    try {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: workerConfig.queueUrl,
          MaxNumberOfMessages: workerConfig.maxMessages,
          WaitTimeSeconds: workerConfig.waitSeconds,
          VisibilityTimeout: workerConfig.visibilitySeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      // Hand other consumers' messages back first, so they do not wait behind ours.
      const ours = Messages.filter(isOurs);
      await Promise.all(Messages.filter((m) => !ours.includes(m)).map(handBack));
      for (const message of ours) {
        if (stopping) break;
        await handle(message);
      }
      // Only others' messages: wait before asking again, or the same ones come straight back and their receive count climbs.
      if (Messages.length > 0 && ours.length === 0) await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (err) {
      log(`receive failed: ${err instanceof Error ? err.message : err}; retrying in 5s`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  log('stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`${signal}: finishing the current message, then stopping`);
    stopping = true;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
