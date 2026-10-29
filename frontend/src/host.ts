import { isMountedByHost } from './task-context';
import type { CustomProps, OrionTaskAppProps } from './types';

/**
 * The one place this app talks to Orion's page. Screens call
 * notifyFilesRegistered / notifyTaskComplete, api-client calls getAppToken,
 * and none of them ask how the app was opened:
 *
 *   mounted by Orion (`spa`)    -> the callback Orion passed to mount()
 *   in Orion's iframe (`embed`) -> postMessage to the parent page
 *   its own tab (`tab`)         -> no page to tell; the bearer is the session
 *                                  this app's server started from the launch
 *                                  code on the link
 *   standalone, no launch code  -> nothing; there is no host and no bearer,
 *                                  and App.tsx stops before any call
 *
 * The two notify signals are nudges, not reports. Orion re-reads its own
 * record when it gets one, so a missed call costs the operator a manual
 * refresh and a repeated call costs nothing.
 */
type HostCallbacks = Pick<OrionTaskAppProps, 'getAppToken' | 'onFilesRegistered' | 'onTaskComplete'>;

type Host =
  | { kind: 'mounted'; callbacks: HostCallbacks }
  | { kind: 'framed' }
  | { kind: 'tab'; session: string; onSessionOver?: () => void }
  | { kind: 'none' };

let host: Host = { kind: 'none' };

/** Whether this app runs in a tab of its own: not mounted by Orion, not in its iframe. */
export function inOwnTab(customProps?: CustomProps): boolean {
  return !isMountedByHost(customProps) && window.parent === window;
}

/**
 * Call from App.tsx on mount, with whatever mount() was given. `tabSession`
 * is the session this app's server started from the launch code, when Orion
 * opened the app in a tab, and `onTabSessionOver` is called once if that
 * session ends while the tab is open.
 */
export function connectHost(customProps?: CustomProps, tabSession?: string, onTabSessionOver?: () => void): void {
  if (isMountedByHost(customProps)) {
    host = { kind: 'mounted', callbacks: customProps };
  } else if (window.parent !== window) {
    host = { kind: 'framed' };
  } else if (tabSession) {
    host = { kind: 'tab', session: tabSession, onSessionOver: onTabSessionOver };
  } else {
    host = { kind: 'none' };
  }
}

/**
 * This app's server has ended the tab's session: Orion no longer says the
 * operator has the work, or the session ran out. Drops the bearer, so no
 * call follows, and tells App.tsx. Returns false, and does nothing, when the
 * app is not in a tab of its own: mounted or framed, a refused app token is
 * the screen's own error.
 */
export function tabSessionOver(): boolean {
  if (host.kind !== 'tab') return false;
  const { onSessionOver } = host;
  host = { kind: 'none' };
  onSessionOver?.();
  return true;
}

/** §10 unmount hygiene — a call that lands after unmount must not reach a host that has moved on. */
export function disconnectHost(): void {
  host = { kind: 'none' };
}

/**
 * Call as soon as this app's server confirms a registration with Orion, so
 * Orion's Registered Files panel re-reads without the operator refreshing it.
 * The ids only tell Orion when its read is up to date; an empty list still
 * asks for the re-read (bulk registration's progress doesn't carry ids).
 */
export function notifyFilesRegistered(fileIds: Array<number | string>): void {
  const ids = fileIds.map(String);
  tell((callbacks) => callbacks.onFilesRegistered?.(ids), { type: 'orion:files-registered', fileIds: ids });
}

/**
 * Call after this app's server has completed (or sent back) the file Orion
 * opened it for. Orion re-checks the file and takes the operator on from
 * there; without the call they sit on a finished screen until they leave by
 * hand. Not for the register screens — they are handed no file to finish.
 */
export function notifyTaskComplete(): void {
  tell((callbacks) => callbacks.onTaskComplete?.(), { type: 'orion:task-complete' });
}

/** Orion issued no app token. `reason` is Orion's own code for why, or `unavailable`. */
export class NoAppTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Orion issued no app token (${reason}).`);
    this.name = 'NoAppTokenError';
  }
}

// How long an iframe waits for Orion's page to answer before giving up.
const APP_TOKEN_REPLY_MS = 15_000;
let appTokenRequests = 0;

/**
 * The app token this app's server needs on every call: Orion's statement of
 * which operator is working on which file. Ask before each request and never
 * keep the answer; Orion's page keeps one ready and renews it.
 *
 * Rejects with NoAppTokenError when Orion issues none: the operator no longer
 * has the file, the Web App was switched off, or there is no Orion page
 * beside this app at all. The caller tells the operator and stops.
 */
export function getAppToken(): Promise<string> {
  if (host.kind === 'mounted') {
    const ask = host.callbacks.getAppToken;
    if (!ask) return Promise.reject(new NoAppTokenError('unavailable'));
    return ask().catch((err: unknown) => {
      throw new NoAppTokenError(reasonOf(err));
    });
  }
  if (host.kind === 'framed') return askParentForAppToken();
  // A tab has no Orion page to ask. Its bearer is this app's own session,
  // which its server started by exchanging the launch code with Orion.
  if (host.kind === 'tab') return Promise.resolve(host.session);
  return Promise.reject(new NoAppTokenError('unavailable'));
}

// Orion's page rejects with an error carrying `reason`.
function reasonOf(err: unknown): string {
  const reason = (err as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : 'unavailable';
}

/**
 * `embed`: ask the parent page by message. Orion answers only a frame at this
 * Web App's registered page address, and replies to that address alone, so
 * the token cannot reach a page that framed this app from elsewhere.
 */
function askParentForAppToken(): Promise<string> {
  const requestId = `transapp-${++appTokenRequests}`;

  return new Promise((resolve, reject) => {
    const done = (settle: () => void) => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      settle();
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; requestId?: unknown; token?: unknown; refused?: unknown } | null;
      if (event.source !== window.parent || data?.type !== 'orion:app-token' || data.requestId !== requestId) return;
      if (typeof data.token === 'string') {
        const { token } = data;
        done(() => resolve(token));
      } else {
        done(() => reject(new NoAppTokenError(typeof data.refused === 'string' ? data.refused : 'unavailable')));
      }
    };
    const timer = window.setTimeout(() => done(() => reject(new NoAppTokenError('unavailable'))), APP_TOKEN_REPLY_MS);

    window.addEventListener('message', onMessage);
    // '*' for the same reason as tell(): the request itself says nothing.
    window.parent.postMessage({ type: 'orion:get-app-token', requestId }, '*');
  });
}

function tell(viaCallback: (callbacks: HostCallbacks) => void, message: Record<string, unknown>): void {
  try {
    if (host.kind === 'mounted') {
      viaCallback(host.callbacks);
    } else if (host.kind === 'framed') {
      // '*' because a frame can't be sure of its parent's origin, and nothing
      // here is secret: file ids and a bare "done". Orion checks the sender's
      // origin on its side.
      window.parent.postMessage(message, '*');
    }
  } catch (err) {
    // The work itself succeeded; a host that throws must not turn the
    // screen's result into an error.
    console.error('[transapp] could not notify the host:', err);
  }
}
