import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * What Orion says a code stands for: who the operator is, which Web App the
 * code was issued for, and which work it covers. The code is an app token
 * (Orion's page handed it to the screen) or the launch code on this app's
 * own link when Orion opened it in a tab. Orion's contract
 * (`docs/api/app-token.md` and `launch-code.md` in the Orion backend),
 * trimmed to what this server reads.
 */
export interface OrionContract {
  issuer: string;
  expires_at: string;
  /** `screen` is the task's choice of screen, or null for the app's own start page. */
  web_app: { code: string; screen?: string | null };
  context: {
    project: { id: number; code: string | null };
    workflow?: { id: number; code: string | null };
    task: { id: number; uid?: string };
    file: { id: number } | null;
  };
  actor: { user_id: number; login_id: string; display_name: string };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth: the contract Orion answered for this request's app token. */
      orion?: OrionContract;
    }
  }
}

type Checked = { ok: true; contract: OrionContract } | { ok: false; status: number; error: string };

/**
 * Answers kept until the token expires, so Orion is asked about once per
 * operator per ten minutes rather than on every click. The cost: a token
 * Orion would now refuse (the operator put the file on hold) keeps working
 * here until it expires. Refusals are never kept.
 */
const answers = new Map<string, { contract: OrionContract; expiresAt: number }>();

function remembered(token: string): OrionContract | undefined {
  const now = Date.now();
  for (const [key, answer] of answers) {
    if (answer.expiresAt <= now) answers.delete(key);
  }
  return answers.get(token)?.contract;
}

/** Asks Orion what the token stands for, with this server's API token. */
async function exchange(token: string): Promise<Checked> {
  const base = config.uwbe.baseUrl.endsWith('/') ? config.uwbe.baseUrl : `${config.uwbe.baseUrl}/`;
  const url = new URL(`v1/webapp/contract/${encodeURIComponent(token)}`, base);

  let response: globalThis.Response;
  try {
    response = await fetch(url, { headers: { 'api-token': config.uwbe.apiToken } });
  } catch {
    return { ok: false, status: 502, error: 'Could not reach Orion to check who is calling.' };
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: OrionContract;
    error?: { code?: string; message?: string };
  };

  if (response.status === 200 && body.data) {
    return { ok: true, contract: body.data };
  }
  if (response.status === 404 || response.status === 410) {
    // 404: Orion does not know the token (never issued, or expired).
    // 410: the operator no longer has the work the token was issued for.
    return { ok: false, status: 401, error: body.error?.message ?? 'Orion did not accept this app token.' };
  }
  // 401 or 403 here is about this server's own API token, not the operator.
  return { ok: false, status: 502, error: `Orion refused this server's API token (HTTP ${response.status}).` };
}

/** Whether a contract is this app's, from the Orion this server trusts. */
function distrust(contract: OrionContract): { status: number; error: string } | null {
  if (config.orion.issuer && contract.issuer !== config.orion.issuer) {
    return { status: 401, error: 'This app token comes from an Orion this server does not trust.' };
  }
  if (contract.web_app.code !== config.orion.webAppCode) {
    return { status: 403, error: 'This app token was issued for another Web App.' };
  }
  return null;
}

/**
 * This server's own sessions with tabs Orion opened. A launch code is read
 * once, when the tab loads, and Orion never renews it; from then on the
 * screen sends the session id made here, as its bearer.
 *
 * Kept in memory: a restart ends every session, and the tab starts another
 * from its link while Orion still answers for the code.
 */
const tabSessions = new Map<string, { contract: OrionContract; ct: string; expiresAt: number }>();

function tabSession(session: string): { contract: OrionContract; ct: string } | undefined {
  const now = Date.now();
  for (const [key, kept] of tabSessions) {
    if (kept.expiresAt <= now) tabSessions.delete(key);
  }
  return tabSessions.get(session);
}

type Launched = { ok: true; session: string; contract: OrionContract } | { ok: false; status: number; error: string };

/**
 * Starts a tab's session from the launch code on its link. Orion is asked
 * every time a tab arrives with only the code, so a link that has gone stale
 * (the operator held or finished the file, or the hour ran out) opens
 * nothing, whoever holds it. A tab that already has a session for this code
 * (a refresh) keeps it, and Orion is not asked again.
 */
export async function startTabSession(ct: string, session?: string): Promise<Launched> {
  const kept = session ? tabSession(session) : undefined;
  if (session && kept?.ct === ct) {
    return { ok: true, session, contract: kept.contract };
  }

  const checked = await exchange(ct);
  if (!checked.ok) return checked;

  const refused = distrust(checked.contract);
  if (refused) return { ok: false, ...refused };

  const started = randomBytes(32).toString('hex');
  tabSessions.set(started, {
    contract: checked.contract,
    ct,
    expiresAt: Date.now() + config.orion.tabSessionMinutes * 60_000,
  });
  return { ok: true, session: started, contract: checked.contract };
}

/** A value the request names for itself, in its query string or JSON body. */
function named(req: Request, key: string): string | undefined {
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const value = req.query[key] ?? body[key];
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/**
 * Whether what a request names agrees with the contract. A request may
 * leave any of them out; it may never name another operator, task or file.
 * Multipart routes call this again once their body is parsed.
 */
export function mismatch(contract: OrionContract, names: { userId?: string; taskId?: string; fileId?: string }): string | null {
  if (names.userId !== undefined && names.userId !== String(contract.actor.user_id)) {
    return 'This request names an operator other than the one Orion confirmed.';
  }
  if (names.taskId !== undefined && names.taskId !== String(contract.context.task.id)) {
    return 'This request names a task other than the one the app token covers.';
  }
  if (names.fileId !== undefined && names.fileId !== String(contract.context.file?.id)) {
    return 'This request names a file other than the one the app token covers.';
  }
  return null;
}

/**
 * Every /api call must carry a bearer, as `Authorization: Bearer`. Mounted
 * or framed by Orion it is the app token Orion's page handed the screen, and
 * this server asks Orion what it stands for. Opened in its own tab it is the
 * session this server started from the launch code (startTabSession). Either
 * way the server acts only as that operator, on that task and file.
 *
 * There is no way in without one.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const [scheme, token] = (req.header('authorization') ?? '').split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    res.status(401).json({ ok: false, error: 'No app token. Open this task from Orion.' });
    return;
  }

  let contract = tabSession(token)?.contract ?? remembered(token);
  if (!contract) {
    const checked = await exchange(token);
    if (!checked.ok) {
      res.status(checked.status).json({ ok: false, error: checked.error });
      return;
    }
    contract = checked.contract;
    answers.set(token, { contract, expiresAt: Date.parse(contract.expires_at) });
  }

  const refused = distrust(contract);
  if (refused) {
    res.status(refused.status).json({ ok: false, error: refused.error });
    return;
  }

  const problem = mismatch(contract, {
    userId: named(req, 'userId'),
    taskId: named(req, 'taskId'),
    fileId: named(req, 'fileId'),
  });
  if (problem) {
    res.status(403).json({ ok: false, error: problem });
    return;
  }

  req.orion = contract;
  next();
}
