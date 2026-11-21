import { createHash } from 'node:crypto';

/**
 * What the monitor page is sent, live and never stored: the worker's steps for each file, its heartbeat, and the
 * log lines of both processes. A page that reloads starts from nothing.
 */
export type FileStep = 'received' | 'claimed' | 'processing' | 'done' | 'triggered' | 'skipped' | 'failed' | 'held';

export interface FileFacts {
  name: string;
  bytes: number;
  sha256: string;
}

export interface FileEvent {
  kind: 'file';
  at: string;
  step: FileStep;
  task: string;
  projectCode: string;
  workflowCode: string;
  fileId: number;
  fileTaskId: number;
  attempt?: number;
  durationMs?: number;
  input?: FileFacts;
  output?: FileFacts;
  details?: Record<string, unknown>;
  note?: string;
  error?: string;
}

export interface HeartbeatEvent {
  kind: 'heartbeat';
  at: string;
  pid: number;
  startedAt: string;
  queueUrl: string;
  orionUrl: string;
  tasks: string[];
  settings: Record<string, unknown>;
  busyWith: { task: string; fileId: number } | null;
}

export interface LogEvent {
  kind: 'log';
  at: string;
  source: 'server' | 'worker';
  level: 'info' | 'warn' | 'error';
  line: string;
}

export type MonitorEvent = FileEvent | HeartbeatEvent | LogEvent;

export function fileFacts(bytes: Buffer, name: string): FileFacts {
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// pdf-parse's bundled pdf.js prints these for fonts it can't hint; the text is still read. Terminal only.
const PDF_NOISE = /^Warning: (TT: |Indexing all PDF objects|Unsupported feature)/;

/** Routes console.log/warn/error through `sink` as well as the terminal, one event per call. */
export function teeConsole(source: LogEvent['source'], sink: (event: LogEvent) => void): void {
  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error' } as const;
  for (const method of Object.keys(levels) as Array<keyof typeof levels>) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      const line = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (PDF_NOISE.test(line)) return;
      try {
        sink({ kind: 'log', at: new Date().toISOString(), source, level: levels[method], line });
      } catch {
        // The monitor must never break the process it watches.
      }
    };
  }
}
