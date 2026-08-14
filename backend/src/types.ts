export type ModeKey = 'ACQUISITION' | 'QUALIFICATION' | 'BATCH_SPLIT' | 'DOWNLOAD';

/**
 * Resolved task context — the shape both mount paths (Parcel customProps,
 * standalone URL params) collapse into. See FLUID_APP_DEV_CONTEXT.md §3.
 * Keep in sync with frontend/src/types.ts (duplicated intentionally — no
 * shared workspace package for a two-package repo this size).
 */
export interface TaskContextPointer {
  /**
   * Optional: uw-fe's real "Register New File" launch URL (user-modules.tsx's
   * constructExternalUrl) does NOT include task_code — only project/workflow/
   * task ids+codes and task_uid. Resolved server-side from workflowCode+taskId
   * via get-all-tasks when absent (see routes/task-context.ts).
   */
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
}

/** Normalized result every uw-be call collapses into, regardless of envelope style. §5 */
export interface UwbeResult<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
  /** Raw HTTP status — kept for logging; never used alone to decide success (Style B lies). */
  httpStatus: number;
}
