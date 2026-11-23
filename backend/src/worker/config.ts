function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** The SQS worker's settings. The uw-be address and token are the server's own (config.ts). */
export const workerConfig = {
  queueUrl: required('SQS_QUEUE_URL'),
  // Set for ElasticMQ/LocalStack only. Unset, the AWS SDK uses the real endpoint and its default credential chain.
  endpoint: process.env.SQS_ENDPOINT || undefined,
  region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  // Local queues only: create the queue at startup, since ElasticMQ forgets it on restart.
  createQueue: process.env.SQS_CREATE_QUEUE === 'true',
  waitSeconds: Number(process.env.SQS_WAIT_SECONDS ?? 20),
  visibilitySeconds: Number(process.env.SQS_VISIBILITY_SECONDS ?? 300),
  maxMessages: Number(process.env.SQS_MAX_MESSAGES ?? 10),
  // After this many deliveries a failing file is put on hold in Orion and the message dropped (there is no DLQ).
  maxReceives: Number(process.env.WORKER_MAX_RECEIVES ?? 5),
  // Orion's own user 1 (system) claims and completes files, as register-job-batch-file defaults to.
  userId: Number(process.env.WORKER_USER_ID ?? 1),
  // Where TRANSMISSION drops packages: a stand-in for the client's SFTP.
  transmissionDir: process.env.TRANSMISSION_DIR ?? './transmission-out',
  // Local-disk Orion only: its storage/app folder, where QA cluster zips are written since it gives no upload URL.
  localStorageRoot: process.env.LOCAL_STORAGE_ROOT || undefined,
  // On a queue other apps also read: only these projects and workflows are processed (comma lists, unset = any).
  // Every other message is handed back to the queue at once, never deleted or acted on.
  onlyProjects: codes(process.env.WORKER_PROJECT_CODE),
  onlyWorkflows: codes(process.env.WORKER_WORKFLOW_CODE),
};

function codes(value: string | undefined): string[] {
  return (value ?? '').split(',').map((c) => c.trim()).filter(Boolean);
}
