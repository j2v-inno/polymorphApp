import type { UwbeResult } from '../types.js';

/**
 * uw-be has two response envelope conventions this app's endpoints use
 * (FLUID_APP_DEV_CONTEXT.md §5). Every endpoint must be registered below with
 * its known style — deliberately no fallback-to-generic default, so a newly
 * wired endpoint that's missing from this table fails loudly instead of
 * silently mis-parsing.
 *
 * CORRECTED against the real controller code (2026-08-12; TaskProcessController.php,
 * FileController.php in uw-be) — §5's table in the dev-context doc is WRONG for
 * 4 of its 5 "Style B" endpoints. Only `flow-back-file-task` (FileController)
 * is actually Style B, and even then its real shape is narrower than the doc
 * implies: it is ALWAYS exactly `{status: boolean, error: string}`, never any
 * additional payload. `update-file-status`, `update-file-meta-data`,
 * `get-task-ongoing-file`, and `get-file-task-output` are all
 * TaskProcessController methods that go through the shared `respond()` helper
 * — genuinely Style A, same as register-*. Before this fix, every one of
 * those 4 calls would have misparsed a real 200 success as a failure, because
 * parseStyleB checks `body.status`, which doesn't exist on a Style A envelope
 * (it has `success` instead) — do not revert this without re-verifying against
 * the real controllers, not just the design doc.
 */
export type EnvelopeStyle = 'A' | 'B';

const ENDPOINT_STYLES: Record<string, EnvelopeStyle> = {
  'register-job-batch-file': 'A',
  'register-file': 'A',
  'update-file-status': 'A',
  'update-file-meta-data': 'A',
  'get-task-ongoing-file': 'A',
  'get-file-task-output': 'A',
  'get-all-tasks': 'A',
  'flow-back-file-task': 'B',
};

interface StyleAEnvelope<T> {
  success: boolean;
  code: number;
  data?: T;
  message?: string;
  error?: string;
}

interface StyleBEnvelope<T> {
  status: boolean;
  error?: string;
  [key: string]: unknown;
}

function parseStyleA<T>(httpStatus: number, body: StyleAEnvelope<T>): UwbeResult<T> {
  if (body.success) {
    return { ok: true, data: body.data ?? null, error: null, httpStatus };
  }
  return { ok: false, data: null, error: body.error ?? body.message ?? `request failed (code ${body.code})`, httpStatus };
}

function parseStyleB<T>(httpStatus: number, body: StyleBEnvelope<T>): UwbeResult<T> {
  // Style B nests the payload directly on the envelope (no `data` key) and is
  // "almost always HTTP 200 even on failure" — `status` is the only signal.
  if (body.status) {
    const { status: _status, ...rest } = body;
    return { ok: true, data: rest as T, error: null, httpStatus };
  }
  return { ok: false, data: null, error: body.error ?? 'request failed', httpStatus };
}

/**
 * Fallback for any endpoint not yet registered in ENDPOINT_STYLES. Sniffs the
 * shape defensively and logs loudly so a wrong guess surfaces immediately
 * instead of silently mis-parsing. Every endpoint this app currently calls is
 * registered above with a verified style — this path should not trigger in
 * normal operation; if it does, add the endpoint to ENDPOINT_STYLES with its
 * confirmed style rather than leaving it on the sniffed path.
 */
function parseUnknownStyle<T>(endpoint: string, httpStatus: number, body: Record<string, unknown>): UwbeResult<T> {
  console.warn(
    `[uwbe-client] "${endpoint}" has no confirmed response-envelope style; sniffing shape. ` +
      'Confirm the real style and register it in ENDPOINT_STYLES (response-parser.ts).',
  );
  if ('success' in body) return parseStyleA(httpStatus, body as unknown as StyleAEnvelope<T>);
  if ('status' in body) return parseStyleB(httpStatus, body as unknown as StyleBEnvelope<T>);
  // Neither known discriminator present — fall back to HTTP status only, which
  // is explicitly the wrong default for Style B endpoints, but there's nothing
  // better to do with a genuinely unrecognized shape.
  return httpStatus >= 200 && httpStatus < 300
    ? { ok: true, data: body as T, error: null, httpStatus }
    : { ok: false, data: null, error: 'request failed', httpStatus };
}

export function parseUwbeResponse<T>(endpoint: string, httpStatus: number, body: unknown): UwbeResult<T> {
  const style = ENDPOINT_STYLES[endpoint];
  const record = (body ?? {}) as Record<string, unknown>;

  if (style === 'A') return parseStyleA(httpStatus, record as unknown as StyleAEnvelope<T>);
  if (style === 'B') return parseStyleB(httpStatus, record as unknown as StyleBEnvelope<T>);
  return parseUnknownStyle<T>(endpoint, httpStatus, record);
}
