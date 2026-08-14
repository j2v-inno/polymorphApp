import { config } from '../config.js';
import { parseUwbeResponse } from './response-parser.js';
import type { UwbeResult } from '../types.js';

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
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

  const response = await fetch(url, { method, headers, body });

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

  return parseUwbeResponse<T>(endpoint, response.status, parsedBody);
}

/** Uploads raw bytes to a pre-signed URL returned by register-job-batch-file / register-file. Not a uw-be envelope call. */
export async function putRawBytes(uploadUrl: string, bytes: Buffer, contentType = 'application/pdf'): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`upload to ${uploadUrl} failed: HTTP ${response.status}`);
  }
}
