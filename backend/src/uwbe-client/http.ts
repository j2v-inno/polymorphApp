import { config } from '../config.js';
import { parseUwbeResponse } from './response-parser.js';
import type { UwbeResult } from '../types.js';

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  /** Overrides `endpoint` for the ENDPOINT_STYLES lookup — needed when `endpoint` is a dynamic path (e.g. `tasks/{uid}`) that can't itself be a stable map key. */
  styleKey?: string;
}

/** §4 tenancy rule: a missing/wrong project_code fails silently downstream. Fail loudly here instead. */
export function assertProjectCode(projectCode: string | undefined): asserts projectCode is string {
  if (!projectCode) {
    throw new Error('project_code is required on every tenancy-gated uw-be call (FLUID_APP_DEV_CONTEXT.md §4)');
  }
}

function buildUrl(endpoint: string, query?: CallOptions['query']): string {
  const base = config.uwbe.baseUrl.endsWith('/') ? config.uwbe.baseUrl : `${config.uwbe.baseUrl}/`;
  const url = new URL(endpoint, base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Calls one `uw-be` `routes/api.php` endpoint and normalizes its response via response-parser.ts (§5). */
export async function callUwbe<T>(endpoint: string, opts: CallOptions = {}): Promise<UwbeResult<T>> {
  const method = opts.method ?? 'POST';
  const url = buildUrl(endpoint, opts.query);

  const headers: Record<string, string> = { 'api-token': config.uwbe.apiToken };
  let body: string | undefined;
  if (opts.body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body });
  } catch (err) {
    // A thrown fetch (connection reset/refused/timeout, DNS failure) never
    // reaches uw-be at all — confirmed via Telescope showing no request logged
    // for calls that failed this way. Left uncaught, this used to bypass every
    // caller's `!result.ok` retry logic entirely (Express 5 auto-forwards the
    // rejection straight to the generic error handler, producing a bare,
    // message-less 502) instead of being retried like a normal uw-be failure.
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? `network error calling ${endpoint}: ${err.message}` : `network error calling ${endpoint}`,
      httpStatus: 0,
    };
  }

  // §7 — some endpoints return plain-text (non-JSON) bodies on failure instead
  // of the documented envelope. Attempt-JSON-then-fallback rather than letting
  // .json() throw.
  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    return {
      ok: false,
      data: null,
      error: text || `non-JSON response (HTTP ${response.status})`,
      httpStatus: response.status,
    };
  }

  return parseUwbeResponse<T>(opts.styleKey ?? endpoint, response.status, parsedBody);
}

/** Uploads raw bytes to a pre-signed URL returned by register-job-batch-file / register-file. Not a uw-be envelope call. */
export async function putRawBytes(uploadUrl: string, bytes: Buffer, contentType = 'application/pdf'): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  // When the presigned URL's own S3/MinIO signer included x-amz-acl in
  // X-Amz-SignedHeaders (confirmed on a real RND MinIO instance — a PUT
  // without this header back 400s: SigV4 signature validation requires every
  // header listed in SignedHeaders to actually be present, with the exact
  // value the signature was computed over), echo that same value back as a
  // real request header. Not needed against setups whose presigned PUTs
  // don't sign ACL at all (e.g. the local MinIO standalone-binary dev setup)
  // — this is a no-op there, so safe to always check.
  const acl = new URL(uploadUrl).searchParams.get('x-amz-acl');
  if (acl) headers['x-amz-acl'] = acl;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers,
    body: bytes,
  });
  if (!response.ok) {
    // S3/MinIO's actual XML error body (e.g. SignatureDoesNotMatch vs.
    // AccessDenied vs. something else entirely) is far more useful than the
    // bare status code alone — include it so a failure is diagnosable from
    // the row's own error field instead of needing server-side log access.
    const body = await response.text().catch(() => '');
    throw new Error(`upload to ${uploadUrl} failed: HTTP ${response.status}${body ? ` — ${body}` : ''}`);
  }
}
