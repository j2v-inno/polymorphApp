import 'dotenv/config';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { workerConfig } from './config.js';
import { parseMessage } from './payload.js';
import { giveUp, processMessage } from './pipeline.js';

const sqs = new SQSClient({
  region: workerConfig.region,
  endpoint: workerConfig.endpoint,
  // ElasticMQ accepts any key; the real endpoint uses the SDK's default credential chain.
  ...(workerConfig.endpoint && !process.env.AWS_ACCESS_KEY_ID
    ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
    : {}),
});

let stopping = false;
const log = (line: string) => console.log(`${new Date().toISOString()} [worker] ${line}`);

async function ack(message: Message): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: workerConfig.queueUrl, ReceiptHandle: message.ReceiptHandle }));
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

  try {
    const outcome = await processMessage(msg);
    log(outcome.note);
    if (outcome.ack) await ack(message);
    else if (receives >= workerConfig.maxReceives) await ack(message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`file=${msg.file_id} attempt ${receives}/${workerConfig.maxReceives} failed: ${reason}`);
    if (receives >= workerConfig.maxReceives) {
      await giveUp(msg, reason);
      await ack(message);
      log(`file=${msg.file_id} put on hold after ${receives} attempts`);
    }
  }
}

async function main(): Promise<void> {
  if (workerConfig.createQueue) {
    const name = workerConfig.queueUrl.split('/').pop()!;
    await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: String(workerConfig.visibilitySeconds) } }));
  }
  log(`polling ${workerConfig.queueUrl}, calling ${config.uwbe.baseUrl}`);

  while (!stopping) {
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
      for (const message of Messages) {
        if (stopping) break;
        await handle(message);
      }
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
