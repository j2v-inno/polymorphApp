export type ModeKey = 'ACQUISITION' | 'BULK_REGISTRATION' | 'QUALIFICATION' | 'BATCH_SPLIT' | 'TRANSFORMATION' | 'DOWNLOAD';

/**
 * Resolved task context — the shape both mount paths (Parcel customProps,
 * standalone URL params) collapse into. See FLUID_APP_DEV_CONTEXT.md §3.
 * Keep in sync with backend/src/types.ts (duplicated intentionally — no
 * shared workspace package for a two-package repo this size).
 */
export interface TaskContext {
  /** Optional: resolved server-side (backend/routes/task-context.ts) when the launch context doesn't supply it — real Orion launch URLs don't always send it. */
  taskCode?: string;
  taskId: number;
  /** Optional: absent for "register a new file" launches (e.g. ACQUISITION) — there's no file yet. */
  fileId?: number;
  projectId: number;
  /** Plumbing only — carried for payload fidelity with the launch URL (workflow_id); uw-be endpoints use workflowCode. */
  workflowId?: number;
  /** Optional: only present once a file exists (see fileId). */
  jobId?: number;
  batchId?: number;
  projectCode: string;
  userId: number;
  userLoginId?: string;
  /** Real Orion launch URLs do send this even though FLUID_APP_DEV_CONTEXT.md §3's examples omit it. */
  workflowCode?: string;
  taskUid?: string;
  jobName?: string;
  batchName?: string;
  fileName?: string;
  /** Parcel mode only (§10) — never present in the standalone-mode URL. */
  apiToken?: string;
}

/**
 * The props Orion passes to mount() — its published task-app contract, where
 * every context field is a string. task-context.ts adapts these into
 * TaskContext; nothing else should read them.
 */
export interface OrionTaskAppProps {
  project_id: string;
  project_code: string;
  workflow_id: string;
  workflow_code: string;
  task_id: string;
  task_uid: string;
  user_id: string;
  /** Which screen to render — one of mode-path.ts's path keys, declared on the app's registry row in Orion. */
  app_screen?: string;
  file_id?: string;
  file_task_id?: string;
  file_url?: string;
  file_name?: string;
  file_mime?: string;
  basePath?: string;
  apiBaseUrl?: string;
  onTaskComplete?: () => void;
  onTaskProgress?: (progress: number) => void;
}

/** Whatever single-spa passes to mount()/renderReactNode — Orion's contract props plus single-spa's own reserved props. */
export type CustomProps = Partial<OrionTaskAppProps> & {
  domElement?: HTMLElement;
  name?: string;
  [key: string]: unknown;
};
