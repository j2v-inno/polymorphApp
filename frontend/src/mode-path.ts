/**
 * §9.2 addendum — mode selection was previously taskCode-only, resolved
 * server-side from task_id via the workflow graph. That chain breaks the
 * moment uw-fe's launch URL doesn't carry a valid task_id (several distinct
 * causes hit in practice: an empty next_tasks lookup, a task rename changing
 * nothing code-wise but still confusing which task a human picks when wiring
 * external_app_integration, etc.) — and it's an unnecessary round-trip
 * dependency for something that's really just "which screen do I show."
 *
 * Each task's own `external_app_integration.web_app.url` in uw-be is
 * configured ONCE, per task, with a path matching its mode below (e.g.
 * BATCH_SPLIT's task gets ".../batch-split", never just the bare origin).
 * The path segment is keyed to the mode's own stable identity — the same
 * key modeRegistry uses — not the task's display `name`, which is exactly
 * the field that keeps getting renamed ("batch_split" -> "batching") without
 * changing what the task actually does. Renaming a task in uw-be's admin UI
 * never needs to touch this file or the configured external-app URL.
 */
const PATH_TO_TASK_CODE: Record<string, string> = {
  acquisition: 'ACQUISITION',
  'bulk-registration': 'BULK_REGISTRATION',
  'batch-split': 'BATCH_SPLIT',
  qualification: 'QUALIFICATION',
  transformation: 'TRANSFORMATION',
  download: 'DOWNLOAD',
};

/**
 * LAST non-empty path segment, e.g. "/batch-split" -> "batch-split" — and,
 * critically, "/ext/app/wa/batch-split" (the real deployed shape, nested
 * under the frontend's base path) -> "batch-split" too, not "ext". Using the
 * FIRST segment (the original implementation) silently returned undefined
 * for every mode on every real deployment — never caught before because the
 * App.tsx caller's own `?? state.taskContext.taskCode` fallback happened to
 * paper over it for every mode whose real uw-be task `code` column already
 * matched; confirmed broken via BULK_REGISTRATION, the first mode where that
 * fallback also failed (see task-context.ts's own doc comment on that bug).
 */
export function resolveModeFromPath(pathname: string = window.location.pathname): string | undefined {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const segment = segments[segments.length - 1];
  return segment ? PATH_TO_TASK_CODE[segment.toLowerCase()] : undefined;
}
