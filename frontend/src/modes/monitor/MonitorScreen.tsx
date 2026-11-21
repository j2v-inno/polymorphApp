import { useEffect, useMemo, useRef, useState } from 'react';
import { BACKEND_URL } from '../../config';
import './monitor.css';

/**
 * Live view of the transapp backend: what the SQS worker is doing to each file at each automated task, and the log
 * lines of the worker and the server. Nothing is stored anywhere; the page shows what happens while it is open.
 */

type Step = 'received' | 'claimed' | 'processing' | 'done' | 'triggered' | 'skipped' | 'failed' | 'held';

interface FileFacts {
  name: string;
  bytes: number;
  sha256: string;
}

interface FileEvent {
  kind: 'file';
  at: string;
  step: Step;
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

interface HeartbeatEvent {
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

interface LogEvent {
  kind: 'log';
  at: string;
  source: 'server' | 'worker';
  level: 'info' | 'warn' | 'error';
  line: string;
}

type MonitorEvent = FileEvent | HeartbeatEvent | LogEvent;

interface Run {
  key: string;
  task: string;
  fileId: number;
  fileTaskId: number;
  projectCode: string;
  workflowCode: string;
  step: Step;
  firstAt: string;
  lastAt: string;
  attempt?: number;
  durationMs?: number;
  input?: FileFacts;
  output?: FileFacts;
  details?: Record<string, unknown>;
  note?: string;
  error?: string;
  trail: Array<{ step: Step; at: string }>;
}

const MAX_LOG_LINES = 400;
// The worker beats before every poll, at most WaitTimeSeconds (20 s) apart; past this it is not answering.
const WORKER_SILENT_MS = 45_000;
const STAGES: Step[] = ['received', 'claimed', 'processing', 'done'];
const STEP_LABEL: Record<Step, string> = {
  received: 'Received',
  claimed: 'Claimed',
  processing: 'Processing',
  done: 'Done',
  triggered: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
  held: 'On hold',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString();
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`);
const ext = (name: string) => name.split('.').pop()?.toUpperCase() ?? '';
const shortHash = (sha: string) => `${sha.slice(0, 10)}…`;

function streamUrl(): string {
  const key = new URLSearchParams(window.location.search).get('key');
  return BACKEND_URL.replace(/\/+$/, '') + '/monitor/stream' + (key ? `?key=${encodeURIComponent(key)}` : '');
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function MonitorScreen() {
  const [connected, setConnected] = useState(false);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [worker, setWorker] = useState<HeartbeatEvent | null>(null);
  const [now, setNow] = useState(Date.now());
  const [taskFilter, setTaskFilter] = useState('');
  const [followLog, setFollowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  // Standalone, there is no Orion to set the theme: follow the system's.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource(streamUrl());
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as MonitorEvent;
      if (event.kind === 'heartbeat') {
        setWorker(event);
      } else if (event.kind === 'log') {
        setLogs((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), event]);
      } else {
        setRuns((prev) => {
          const key = `${event.task}:${event.fileTaskId}`;
          const run = prev[key];
          const next: Run = {
            ...(run ?? {
              key,
              task: event.task,
              fileId: event.fileId,
              fileTaskId: event.fileTaskId,
              projectCode: event.projectCode,
              workflowCode: event.workflowCode,
              firstAt: event.at,
              trail: [],
            }),
            step: event.step,
            lastAt: event.at,
            attempt: event.attempt ?? run?.attempt,
            durationMs: event.durationMs ?? run?.durationMs,
            input: event.input ?? run?.input,
            output: event.output ?? run?.output,
            details: event.details ?? run?.details,
            note: event.note ?? (event.step === 'received' ? undefined : run?.note),
            error: event.error ?? (event.step === 'received' ? undefined : run?.error),
            trail: [...(run?.trail ?? []), { step: event.step, at: event.at }],
          };
          return { ...prev, [key]: next };
        });
      }
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    if (followLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, followLog]);

  const ordered = useMemo(
    () => Object.values(runs).filter((r) => !taskFilter || r.task === taskFilter).sort((a, b) => b.firstAt.localeCompare(a.firstAt)),
    [runs, taskFilter],
  );
  const tasks = useMemo(() => [...new Set(Object.values(runs).map((r) => r.task))].sort(), [runs]);
  const counts = useMemo(() => {
    const all = Object.values(runs);
    return {
      done: all.filter((r) => r.step === 'done' || r.step === 'triggered').length,
      active: all.filter((r) => r.step === 'received' || r.step === 'claimed' || r.step === 'processing').length,
      failed: all.filter((r) => r.step === 'failed' || r.step === 'held').length,
    };
  }, [runs]);

  const workerAge = worker ? now - new Date(worker.at).getTime() : null;
  const workerOnline = workerAge !== null && workerAge < WORKER_SILENT_MS;

  return (
    <div className="fluid-screen fluid-monitor">
      <header className="fluid-monitor__head">
        <div>
          <h1>Backend monitor</h1>
          <p className="fluid-monitor__sub">Live from the transapp worker and server. Nothing is stored: reloading starts empty.</p>
        </div>
        <div className="fluid-monitor__badges">
          <span className={`fluid-monitor__badge fluid-monitor__badge--${connected ? 'ok' : 'bad'}`}>
            <span className="fluid-monitor__dot" />
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          <span className={`fluid-monitor__badge fluid-monitor__badge--${workerOnline ? 'ok' : 'bad'}`}>
            <span className="fluid-monitor__dot" />
            {workerOnline ? 'Worker online' : worker ? 'Worker silent' : 'Waiting for worker'}
          </span>
          <button
            className="fluid-btn fluid-btn--secondary"
            onClick={() => {
              setRuns({});
              setLogs([]);
            }}
          >
            Clear
          </button>
        </div>
      </header>

      <section className="fluid-monitor__worker">
        {worker ? (
          <>
            <div>
              <span className="fluid-monitor__label">Now</span>
              <strong className={worker.busyWith ? 'fluid-monitor__busy' : ''}>
                {worker.busyWith ? `${worker.busyWith.task} · file ${worker.busyWith.fileId}` : 'Waiting for messages'}
              </strong>
            </div>
            <div>
              <span className="fluid-monitor__label">Queue</span>
              <span title={worker.queueUrl}>{worker.queueUrl.split('/').pop()}</span>
            </div>
            <div>
              <span className="fluid-monitor__label">Last heartbeat</span>
              <span>{Math.round((workerAge ?? 0) / 1000)} s ago</span>
            </div>
            <div>
              <span className="fluid-monitor__label">Running since</span>
              <span>
                {time(worker.startedAt)} · pid {worker.pid}
              </span>
            </div>
            <div className="fluid-monitor__wide">
              <span className="fluid-monitor__label">Automated tasks it handles</span>
              <span className="fluid-monitor__chips">
                {worker.tasks.map((t) => (
                  <code key={t}>{t}</code>
                ))}
              </span>
            </div>
            <div className="fluid-monitor__wide">
              <span className="fluid-monitor__label">Settings</span>
              <span className="fluid-monitor__chips">
                {Object.entries(worker.settings).map(([k, v]) => (
                  <code key={k}>
                    {k}={valueText(v)}
                  </code>
                ))}
              </span>
            </div>
          </>
        ) : (
          <p className="fluid-monitor__empty">No heartbeat yet. The worker sends one before every poll of the queue.</p>
        )}
      </section>

      <div className="fluid-monitor__grid">
        <section className="fluid-monitor__pane">
          <div className="fluid-monitor__pane-head">
            <h2>Files at automated tasks</h2>
            <span className="fluid-monitor__counts">
              {counts.active} in progress · {counts.done} done{counts.failed ? ` · ${counts.failed} failed` : ''}
            </span>
            <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
              <option value="">All tasks</option>
              {tasks.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          {ordered.length === 0 && (
            <p className="fluid-monitor__empty">Nothing yet. Complete a manual task in Orion and the next automated task's file shows up here.</p>
          )}
          <ul className="fluid-monitor__runs">
            {ordered.map((run) => (
              <RunCard key={run.key} run={run} />
            ))}
          </ul>
        </section>

        <section className="fluid-monitor__pane">
          <div className="fluid-monitor__pane-head">
            <h2>Backend log</h2>
            <label className="fluid-review__toggle">
              <input type="checkbox" checked={followLog} onChange={(e) => setFollowLog(e.target.checked)} /> Follow
            </label>
          </div>
          <div className="fluid-monitor__log" ref={logRef}>
            {logs.length === 0 && <p className="fluid-monitor__empty">Log lines from the worker and the server appear here.</p>}
            {logs.map((l, i) => (
              <div key={i} className={`fluid-monitor__line fluid-monitor__line--${l.level}`}>
                <span className="fluid-monitor__time">{time(l.at)}</span>
                <span className={`fluid-monitor__source fluid-monitor__source--${l.source}`}>{l.source}</span>
                <span className="fluid-monitor__text">{l.line}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function RunCard({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const finished = run.step === 'done' || run.step === 'triggered';
  const bad = run.step === 'failed' || run.step === 'held';
  const reached = finished ? STAGES.length : Math.max(0, STAGES.indexOf(run.step) + 1);
  const name = run.input?.name ?? `file ${run.fileId}`;

  return (
    <li className={`fluid-monitor__run${bad ? ' is-bad' : finished ? ' is-done' : run.step === 'skipped' ? '' : ' is-active'}`}>
      <div className="fluid-monitor__run-head">
        <code className="fluid-monitor__task">{run.task}</code>
        <span className="fluid-monitor__file" title={name}>
          {name}
        </span>
        <span className={`fluid-monitor__state fluid-monitor__state--${bad ? 'bad' : finished ? 'done' : run.step === 'skipped' ? 'skip' : 'active'}`}>
          {!finished && !bad && run.step !== 'skipped' && <span className="fluid-spinner" />}
          {STEP_LABEL[run.step]}
        </span>
      </div>
      <div className="fluid-monitor__meta">
        Orion file {run.fileId} · file task {run.fileTaskId} · {run.projectCode}/{run.workflowCode} · received {time(run.firstAt)}
        {run.attempt && run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
        {run.durationMs !== undefined ? ` · took ${(run.durationMs / 1000).toFixed(2)} s` : ''}
      </div>
      {run.step !== 'skipped' && run.task !== 'QA_CLUSTER' && (
        <ol className="fluid-monitor__stages">
          {STAGES.map((s, i) => (
            <li key={s} className={i < reached ? 'is-reached' : ''}>
              {STEP_LABEL[s]}
            </li>
          ))}
        </ol>
      )}
      {(run.input || run.output) && (
        <div className="fluid-monitor__io">
          {run.input && (
            <span title={`sha256 ${run.input.sha256}`}>
              In: {ext(run.input.name)} {size(run.input.bytes)} · {shortHash(run.input.sha256)}
            </span>
          )}
          {run.output && (
            <span title={`sha256 ${run.output.sha256}`}>
              → Out: {run.output.name} {size(run.output.bytes)} · {shortHash(run.output.sha256)}
            </span>
          )}
        </div>
      )}
      {run.note && <div className="fluid-monitor__note">{run.note}</div>}
      {run.error && <div className="fluid-monitor__error">{run.error}</div>}
      {run.details && Object.keys(run.details).length > 0 && (
        <>
          <button className="fluid-monitor__more" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} what it found ({Object.keys(run.details).length})
          </button>
          {open && (
            <dl className="fluid-monitor__details">
              {Object.entries(run.details).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{valueText(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </li>
  );
}
