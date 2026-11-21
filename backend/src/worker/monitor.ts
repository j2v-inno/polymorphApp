import { teeConsole, type FileEvent, type HeartbeatEvent, type MonitorEvent } from '../monitor/events.js';
import type { FileTaskMessage } from './payload.js';

/**
 * Sends the worker's events to the transapp server, which relays them to any open monitor page. Fire and forget, in
 * order: with the server down or no page open they are simply gone, and the worker carries on.
 */
const url = process.env.WORKER_MONITOR_URL ?? `http://localhost:${process.env.PORT ?? 4100}/monitor/ingest`;
const key = process.env.MONITOR_KEY || undefined;
let chain: Promise<void> = Promise.resolve();

function send(event: MonitorEvent): void {
  chain = chain.then(async () => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'x-monitor-key': key } : {}) },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Never logged: a console line here would be sent again, and fail again.
    }
  });
}

/** The worker's console lines go to the page as well. */
export function startWorkerMonitor(): void {
  teeConsole('worker', send);
}

export function heartbeat(beat: Omit<HeartbeatEvent, 'kind' | 'at'>): void {
  send({ kind: 'heartbeat', at: new Date().toISOString(), ...beat });
}

/** One step of one file at one task. */
export function fileStep(msg: FileTaskMessage, task: string, step: FileEvent['step'], extra: Partial<FileEvent> = {}): void {
  send({
    kind: 'file',
    at: new Date().toISOString(),
    step,
    task,
    projectCode: msg.project_code,
    workflowCode: msg.workflow_code,
    fileId: msg.file_id,
    fileTaskId: msg.file_task_id,
    ...extra,
  });
}
