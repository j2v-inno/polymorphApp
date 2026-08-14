export type ModeKey = 'ACQUISITION' | 'QUALIFICATION' | 'BATCH_SPLIT' | 'DOWNLOAD';

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

/** Whatever single-spa passes to mount()/renderReactNode — our TaskContext fields plus single-spa's own reserved props. */
export type CustomProps = Partial<TaskContext> & {
  domElement?: HTMLElement;
  name?: string;
  [key: string]: unknown;
};
