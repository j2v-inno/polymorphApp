import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * What Orion says an app token stands for: who the operator is, which Web
 * App the token was issued for, and which work it covers. Orion's contract
 * (`docs/api/app-token.md` in the Orion backend), trimmed to what this
 * server reads.
 */
export interface OrionContract {
  issuer: string;
  expires_at: string;
  web_app: { code: string };
  context: {
    project: { id: number; code: string | null };
    task: { id: number };
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
 * Every /api call must carry the app token Orion's page handed this app's
 * screen, as `Authorization: Bearer`. This server asks Orion what it stands
 * for and acts only as that operator, on that task and file.
 *
 * There is no way in without one. Opened in its own tab, with no Orion page
 * beside it, this app has no token yet: Orion's launch code for `tab` links
 * is not built.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const [scheme, token] = (req.header('authorization') ?? '').split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    res.status(401).json({ ok: false, error: 'No app token. Open this task from Orion.' });
    return;
  }

  let contract = remembered(token);
  if (!contract) {
    const checked = await exchange(token);
    if (!checked.ok) {
      res.status(checked.status).json({ ok: false, error: checked.error });
      return;
    }
    contract = checked.contract;
    answers.set(token, { contract, expiresAt: Date.parse(contract.expires_at) });
  }

  if (config.orion.issuer && contract.issuer !== config.orion.issuer) {
    res.status(401).json({ ok: false, error: 'This app token comes from an Orion this server does not trust.' });
    return;
  }
  if (contract.web_app.code !== config.orion.webAppCode) {
    res.status(403).json({ ok: false, error: 'This app token was issued for another Web App.' });
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
