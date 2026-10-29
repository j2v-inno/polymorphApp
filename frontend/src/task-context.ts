import type { CustomProps, OrionTaskAppProps, TaskContext } from './types';
import { resolveModeFromPath, resolveModeFromQuery, taskCodeForScreen } from './mode-path';

/**
 * §3.3 — detect mount mode by whether a host supplied the contract's `task_id`
 * (Parcel mode, §3.1) vs. falling back to URL query params (standalone mode,
 * §3.2). Keyed on `task_id` because Orion's published prop contract is
 * snake_case strings and always carries it; the camelCase `taskId` this used to
 * check is not something any host sends, so every real mount fell through to
 * parsing Orion's own URL and every field came out NaN.
 *
 * Mounted, this never reads window.location — the host's page URL is not ours.
 * This is a pointer only — App.tsx must re-validate it against the backend
 * (which re-fetches via get-task-ongoing-file, filling in job/batch, or
 * resolves taskCode when missing) before rendering a mode.
 */
export function resolveTaskContextPointer(customProps?: CustomProps): TaskContext {
  if (isMountedByHost(customProps)) {
    return fromOrionProps(customProps as OrionTaskAppProps);
  }
  return resolveFromUrl();
}

/** The rule above, shared with host.ts: a host mounted us iff it passed the contract's `task_id`. */
export function isMountedByHost(customProps?: CustomProps): customProps is CustomProps {
  return !!customProps && typeof customProps.task_id === 'string' && !!customProps.task_id;
}

/**
 * The one adapter from Orion's contract to this app's TaskContext. Orion passes
 * only the context it launched with; job_id, batch_id, job_name and batch_name
 * are left for the backend's /task-context/resolve to derive from file_id, and
 * the screen comes from app_screen (ticket 13) rather than a URL path.
 */
function fromOrionProps(props: OrionTaskAppProps): TaskContext {
  const num = (value: string | undefined) => (value ? Number(value) : undefined);

  return {
    // Absent app_screen leaves taskCode unset, and the backend falls back to
    // the task graph — the same path a standalone launch with no screen takes.
    taskCode: props.app_screen ? taskCodeForScreen(props.app_screen) : undefined,
    taskId: Number(props.task_id),
    fileId: num(props.file_id),
    projectId: num(props.project_id) ?? NaN,
    workflowId: num(props.workflow_id),
    projectCode: props.project_code ?? '',
    userId: num(props.user_id) ?? NaN,
    workflowCode: props.workflow_code || undefined,
    taskUid: props.task_uid || undefined,
    fileName: props.file_name || undefined,
  };
}

/**
 * The launch code Orion puts on this app's link when it opens it in a tab:
 * `?ct=`, and nothing else about the task or the operator.
 */
export function launchCodeFromUrl(search: string = window.location.search): string | undefined {
  return new URLSearchParams(search).get('ct') || undefined;
}

/** What this app's server answers for a launch code: Orion's own word on the work. */
export interface LaunchedContext {
  appScreen?: string;
  taskId: number;
  taskUid?: string;
  fileId?: number;
  projectId: number;
  projectCode: string;
  workflowId?: number;
  workflowCode?: string;
  userId: number;
  userLoginId?: string;
}

/**
 * The pointer for a tab Orion opened with a launch code. Every field is
 * Orion's answer to this app's server; the page address is not read. The
 * screen is the task's choice, mapped as the mounted path maps the prop.
 */
export function fromLaunch(launched: LaunchedContext): TaskContext {
  const { appScreen, ...context } = launched;
  return { ...context, taskCode: appScreen ? taskCodeForScreen(appScreen) : undefined };
}

function resolveFromUrl(): TaskContext {
  const params = new URLSearchParams(window.location.search);
  const num = (key: string) => (params.get(key) ? Number(params.get(key)) : undefined);
  const str = (key: string) => params.get(key) ?? undefined;

  return {
    // §3.3 — task_code is the mode registry key. Optional in the URL itself:
    // uw-fe's real "Register New File" launch URL (user-modules.tsx's
    // constructExternalUrl) never sends task_code — only workflow_code +
    // task_id + task_uid. Prefers the URL's own path segment — the same
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
    // Orion's own app_screen comes first: a tab or iframe launch of a Web App
    // puts it on the query string, and it is the task's choice of screen, where
    // the path is only whatever the app's one registered page address ends in.
    taskCode: resolveModeFromQuery() ?? resolveModeFromPath() ?? str('task_code'),
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
    // No token is ever read from the URL: the app token comes from Orion's
    // page, through host.ts. A tab Orion opened does not come through here at
    // all: its link carries a launch code and none of these (fromLaunch).
  };
}
