import type { CustomProps, TaskContext } from './types';

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
    // §3.3 — task_code is the mode registry key regardless of the `/<screen>`
    // path segment; the path is cosmetic (legacy launch pattern), not authoritative.
    // Optional here: uw-fe's real "Register New File" launch URL
    // (user-modules.tsx's constructExternalUrl) never sends task_code — only
    // workflow_code + task_id + task_uid. Resolved server-side when absent.
    taskCode: str('task_code'),
    taskId: num('task_id') ?? NaN,
    // Optional: absent for "register a new file" launches — there's no file yet.
    fileId: num('file_id'),
    projectId: num('project_id') ?? NaN,
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
