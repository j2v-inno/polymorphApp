import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getFileTaskStatus } from '../uwbe-client/endpoints.js';

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

/**
 * A code this server could not act on. `stale` is set when Orion itself
 * turned the code down, and holds Orion's own word for why (`unknown_code`,
 * `file_not_yours`, `cannot_register`): Orion no longer answers for the
 * code, and the operator's way back is a new launch from Orion. Without it
 * something broke (Orion unreachable, this server's API token refused,
 * another app's code) and the code itself may be fine. `unreachable` marks
 * the case where Orion gave no answer at all.
 */
type Refused = { ok: false; status: number; error: string; stale?: string; unreachable?: true };

type Checked = { ok: true; contract: OrionContract } | Refused;

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
    return { ok: false, status: 502, error: 'Could not reach Orion to check who is calling.', unreachable: true };
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
    return {
      ok: false,
      status: 401,
      error: body.error?.message ?? 'Orion did not accept this app token.',
      stale: body.error?.code ?? (response.status === 404 ? 'unknown_code' : 'gone'),
    };
  }
  if (response.status === 429 || response.status >= 500) {
    // Orion is there and could not answer: too many exchanges of this code in
    // a minute, or a fault of its own. Nothing was said about the operator.
    return { ok: false, status: 502, error: `Orion could not answer just now (HTTP ${response.status}).`, unreachable: true };
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
 * This server's own sessions with tabs Orion opened. The launch code is read
 * when the tab loads, and Orion never renews it; from then on the screen
 * sends the session id made here, as its bearer.
 *
 * Kept in memory: a restart ends every session, and the tab starts another
 * from its link while Orion still answers for the code.
 */
interface TabSession {
  contract: OrionContract;
  ct: string;
  expiresAt: number;
  /** When Orion last said the operator still has the work. */
  checkedAt: number;
  /** Orion has answered 404 for the launch code: its hour is up, and it is not exchanged again. */
  codeExpired: boolean;
  /** Orion being asked right now, shared by every call that arrives meanwhile. */
  asking?: Promise<Standing>;
}

const tabSessions = new Map<string, TabSession>();

function tabSession(session: string): TabSession | undefined {
  const now = Date.now();
  for (const [key, kept] of tabSessions) {
    if (kept.expiresAt <= now) tabSessions.delete(key);
  }
  return tabSessions.get(session);
}

/**
 * Orion's word on a session at a re-check: the operator still has the work,
 * Orion could not be asked, or a refusal. A refusal with `stale` ends the
 * session; one without is about this server's API token.
 */
type Standing = 'confirmed' | 'unasked' | Refused;

// The statuses a file has at a task while its operator may still work on it:
// In Progress and Pending. Orion's own rule (OperatorStanding::fileTask).
const IN_PROCESS = ['I', 'P'];

const NOT_YOURS: Refused = {
  ok: false,
  status: 401,
  error: 'The operator no longer has this file in process at this task.',
  stale: 'file_not_yours',
};

/**
 * Asks Orion whether the operator still has the work a session was started
 * for.
 *
 * While Orion knows the launch code, the code is exchanged again: Orion runs
 * its own rule and answers 410 once the operator has held, finished or sent
 * back the file. After an hour Orion forgets the code and answers 404
 * whoever has the file, so from then on this server asks about the file
 * itself (get-file-task-status, with its API token) and applies the rule
 * Orion's exchange runs: the file is still handled by the session's
 * operator, In Progress or Pending. A session with no file (Register New
 * File) has nothing to ask about once its code is gone, and ends with it.
 */
async function askOrion(kept: TabSession): Promise<Standing> {
  if (!kept.codeExpired) {
    const checked = await exchange(kept.ct);
    if (checked.ok) return 'confirmed';
    if (checked.unreachable) return 'unasked';
    if (checked.stale !== 'unknown_code') return checked;
    kept.codeExpired = true;
  }

  const { context, actor } = kept.contract;
  if (!context.file) {
    return { ok: false, status: 401, error: 'The launch code has expired, and there is no file to ask Orion about.', stale: 'unknown_code' };
  }

  const asked = await getFileTaskStatus({ projectId: context.project.id, taskId: context.task.id, fileId: context.file.id });
  if (asked.ok) {
    // An answer that does not say who has the file, or its status, does not
    // say the operator still has it.
    const held = Number(asked.data?.handled_by) === actor.user_id && IN_PROCESS.includes(asked.data?.file_task_status ?? '');
    return held ? 'confirmed' : NOT_YOURS;
  }
  // 404: the file is no longer active at the task. 400: the project no longer has the file.
  if (asked.httpStatus === 404 || asked.httpStatus === 400) return NOT_YOURS;
  if (asked.httpStatus === 401 || asked.httpStatus === 403) {
    return { ok: false, status: 502, error: `Orion refused this server's API token (HTTP ${asked.httpStatus}).` };
  }
  return 'unasked';
}

/**
 * A tab's session goes on Orion's last answer for TAB_RECHECK_MINUTES. The
 * first call after that asks Orion again, so a file put on hold, completed
 * or sent back closes the tab within that time, in the launch code's hour or
 * after it.
 *
 * Returns the refusal when the call must not go on, and null when it may.
 * When Orion cannot be reached the session is kept and the call goes on: a
 * network fault does not cut an operator off, and the next call asks again.
 */
async function recheck(session: string, kept: TabSession): Promise<Refused | null> {
  if (Date.now() - kept.checkedAt < config.orion.tabRecheckMinutes * 60_000) return null;

  kept.asking ??= askOrion(kept).finally(() => {
    kept.asking = undefined;
  });
  const standing = await kept.asking;

  if (standing === 'unasked') return null;
  if (standing === 'confirmed') {
    kept.checkedAt = Date.now();
    return null;
  }
  if (standing.stale) tabSessions.delete(session);
  return standing;
}

type Launched = { ok: true; session: string; contract: OrionContract } | Refused;

/**
 * Starts a tab's session from the launch code on its link. Orion is asked
 * every time a tab arrives with only the code, so a link that has gone stale
 * (the operator held or finished the file, or the hour ran out) opens
 * nothing, whoever holds it. A tab that already has a session for this code
 * (a refresh) keeps it, and Orion is not asked here: the session's own
 * re-check (recheck) decides when it is asked next.
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
  const now = Date.now();
  tabSessions.set(started, {
    contract: checked.contract,
    ct,
    expiresAt: now + config.orion.tabSessionMinutes * 60_000,
    checkedAt: now,
    codeExpired: false,
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
 * session this server started from the launch code (startTabSession), which
 * asks Orion again every few minutes (recheck). Either way the server acts
 * only as that operator, on that task and file.
 *
 * A bearer Orion no longer answers for is refused with `code: 'stale_link'`
 * and Orion's reason, as the launch route does. A tab reads it as "the
 * session is over" and tells the operator to open the task from Orion;
 * mounted or framed, the screen shows the error as it always has.
 *
 * There is no way in without one.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const [scheme, token] = (req.header('authorization') ?? '').split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    res.status(401).json({ ok: false, error: 'No app token. Open this task from Orion.' });
    return;
  }

  const refuse = (refused: Refused) =>
    res.status(refused.status).json({
      ok: false,
      error: refused.error,
      ...(refused.stale ? { code: 'stale_link', reason: refused.stale } : {}),
    });

  const tab = tabSession(token);
  if (tab) {
    const over = await recheck(token, tab);
    if (over) {
      refuse(over);
      return;
    }
  }

  let contract = tab?.contract ?? remembered(token);
  if (!contract) {
    const checked = await exchange(token);
    if (!checked.ok) {
      refuse(checked);
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
