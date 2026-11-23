import { Router, type NextFunction, type Request, type Response } from 'express';
import { teeConsole, type MonitorEvent } from './events.js';

/**
 * Relays monitor events to every open monitor page as Server-Sent Events. Nothing is kept: a page sees what happens
 * while it is open. The worker posts its events to /monitor/ingest; this server adds its own log lines and API calls.
 *
 * MONITOR_KEY, when set, is required as ?key= on the stream and as the x-monitor-key header on ingest. Set it on any
 * server reachable from outside: the page shows file names.
 */
const clients = new Set<Response>();
const key = process.env.MONITOR_KEY || undefined;

export function broadcast(event: MonitorEvent): void {
  if (clients.size === 0) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);
}

/** The server's own console lines go to the page too. */
export function startServerMonitor(): void {
  teeConsole('server', broadcast);
}

/** One line per API call, so the page shows the screens talking to this server. */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/monitor') || req.path === '/health') {
    next();
    return;
  }
  const started = Date.now();
  res.on('finish', () => {
    if (clients.size === 0) return;
    broadcast({
      kind: 'log',
      at: new Date().toISOString(),
      source: 'server',
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      line: `${req.method} ${req.originalUrl.split('?')[0]} → ${res.statusCode} (${Date.now() - started} ms)`,
    });
  });
  next();
}

export const monitorRouter = Router();

monitorRouter.get('/stream', (req, res) => {
  if (key && req.query.key !== key) {
    res.status(401).json({ ok: false, error: 'This monitor needs its key: add ?key=… to the page address.' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx would otherwise hold the stream back in its buffer.
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ kind: 'log', at: new Date().toISOString(), source: 'server', level: 'info', line: 'Monitor connected.' })}\n\n`);
  clients.add(res);
  // Proxies close an idle connection; a comment line every 25 s keeps it open.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

monitorRouter.post('/ingest', (req, res) => {
  if (key && req.header('x-monitor-key') !== key) {
    res.status(401).end();
    return;
  }
  const event = req.body as MonitorEvent;
  if (event && (event.kind === 'file' || event.kind === 'heartbeat' || event.kind === 'log')) broadcast(event);
  res.status(204).end();
});
