import type { CustomProps, TaskContext } from './types';
import { resolveModeFromPath } from './mode-path';

/**
 * §3.3 — detect mount mode by whether a host supplied customProps.taskId
 * (Parcel mode, §3.1) vs. falling back to URL query params (standalone mode,
 * §3.2). Checking taskId rather than taskCode: real Orion launch contexts can
 * omit task_code entirely (see resolveFromUrl below) but always supply taskId.
 * This is a pointer only — App.tsx must re-validate it against the backend
 * (which re-fetches via get-task-ongoing-file, or resolves taskCode when
 * missing) before rendering a mode.
 */
export function resolveTaskContextPointer(customProps?: CustomProps): TaskContext {
  if (customProps && customProps.taskId) {
    const { domElement: _domElement, name: _name, ...context } = customProps;
    return context as TaskContext;
  }
  return resolveFromUrl();
}

function resolveFromUrl(): TaskContext {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string) => (params.get(key) ? Number(params.get(key)) : undefined);
  const str = (key: string) => params.get(key) ?? undefined;

  return {
    // §3.3 — task_code is the mode registry key. Optional in the URL itself:
    // uw-fe's real "Register New File" launch URL (user-modules.tsx's
    // constructExternalUrl) never sends task_code — only workflow_code +
    // task_id + task_uid. Falls back to the URL's own path segment — the same
    // mapping mode-path.ts already uses to pick which screen renders — rather
    // than leaving this entirely to the backend's uw-be task-graph lookup.
    // That lookup resolves taskCode from the real task's `code` column in
    // uw-be, which has to exactly match this app's mode keys for anything
    // depending on taskCode to work — not guaranteed, and confirmed broken in
    // practice (a real BULK_REGISTRATION launch resolved to a different code,
    // silently taking the wrong branch in task-context.ts's resolve handler).
    // taskCode has no other role in this app (every actual uw-be call uses
    // taskUid, not taskCode) — it only ever selects a screen/branch, so
    // preferring the same value the path already drives is strictly more
    // consistent, not a new trust boundary.
    taskCode: str('task_code') ?? resolveModeFromPath(),
    taskId: num('task_id') ?? NaN,
    // Optional: absent for "register a new file" launches — there's no file yet.
    fileId: num('file_id'),
    projectId: num('project_id') ?? NaN,
    // Plumbing only — no uw-be endpoint consumes it (all registration/status
    // calls use workflow_code); carried end-to-end so payloads mirror the
    // launch URL, which always includes workflow_id.
    workflowId: num('workflow_id'),
    jobId: num('job_id'),
    batchId: num('batch_id'),
    projectCode: params.get('project_code') ?? '',
    userId: num('user_id') ?? NaN,
    userLoginId: str('user_login_id'),
    // Real Orion launch URLs do send workflow_code/task_uid even though
    // FLUID_APP_DEV_CONTEXT.md §3's examples omit them.
    workflowCode: str('workflow_code'),
    taskUid: str('task_uid'),
    jobName: str('job_name'),
    batchName: str('batch_name'),
    fileName: str('file_name'),
    // §10 — no long-lived auth token is ever placed in the standalone-mode URL.
    // apiToken intentionally stays undefined; standalone auth is an open blocker (§13 #6).
  };
}
