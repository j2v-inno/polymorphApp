import { isMountedByHost } from './task-context';
import type { CustomProps, OrionTaskAppProps } from './types';

/**
 * The one place this app tells Orion that something happened. Screens call
 * notifyFilesRegistered / notifyTaskComplete and never ask how the app was
 * opened:
 *
 *   mounted by Orion (`spa`)    -> the callback Orion passed to mount()
 *   in Orion's iframe (`embed`) -> postMessage to the parent page
 *   its own tab, or standalone  -> nothing; there is no host to tell
 *
 * Both signals are nudges, not reports. Orion re-reads its own record when it
 * gets one, so a missed call costs the operator a manual refresh and a
 * repeated call costs nothing.
 */
type HostCallbacks = Pick<OrionTaskAppProps, 'onFilesRegistered' | 'onTaskComplete'>;

type Host =
  | { kind: 'mounted'; callbacks: HostCallbacks }
  | { kind: 'framed' }
  | { kind: 'none' };

let host: Host = { kind: 'none' };

/** Call from App.tsx on mount, with whatever mount() was given. */
export function connectHost(customProps?: CustomProps): void {
  if (isMountedByHost(customProps)) {
    host = { kind: 'mounted', callbacks: customProps };
  } else if (window.parent !== window) {
    host = { kind: 'framed' };
  } else {
    host = { kind: 'none' };
  }
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
