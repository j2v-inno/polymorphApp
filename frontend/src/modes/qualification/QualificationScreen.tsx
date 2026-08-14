import { useEffect, useState } from 'react';
import type { TaskContext } from '../../types';
import {
  completeQualification,
  getQualificationContext,
  postPagesViewed,
  updateQualificationMetadata,
  type QualificationContext,
  type QualificationOutcome,
} from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

interface MetadataField {
  key: string;
  value: string;
}

// System-managed keys other steps write — kept out of the free-form editor so
// the operator can't accidentally clobber them with a stray edit.
const SYSTEM_META_KEYS = new Set(['pages_viewed', 'pages_with_errors', 'parent_file_id', 'split_index', 'chapter_title']);

function extractEditableMetadata(metaData: Record<string, unknown> | null | undefined): MetadataField[] {
  if (!metaData) return [];
  return Object.entries(metaData)
    .filter(([key]) => !SYSTEM_META_KEYS.has(key))
    .map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
}

/** §6.2 — page-by-page review with error flagging, then 3-way routing. */
export function QualificationScreen({ taskContext }: Props) {
  // Pre-filled from the launch context when available — see the same note
  // in BatchSplitScreen.tsx.
  const [workflowCode, setWorkflowCode] = useState(taskContext.workflowCode ?? '');
  const [context, setContext] = useState<QualificationContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [viewedPages, setViewedPages] = useState<number[]>([]);
  const [errorPages, setErrorPages] = useState<Set<number>>(new Set());
  const [flowbackReason, setFlowbackReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<QualificationOutcome | null>(null);
  const [metadataFields, setMetadataFields] = useState<MetadataField[]>([]);
  const [metadataStatus, setMetadataStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [metadataError, setMetadataError] = useState<string | null>(null);

  // TaskContext doesn't carry workflowCode (same gap BatchSplitScreen/DownloadScreen
  // have) — needed to resolve this task's task_uid via get-all-tasks.
  function loadContext() {
    if (!workflowCode.trim()) {
      setLoadError('workflow code is required to resolve this task (§6.2)');
      return;
    }
    setLoadError(null);
    getQualificationContext(taskContext, workflowCode).then((result) => {
      if (!result.ok || !result.data) {
        setLoadError(result.error ?? 'failed to load task context');
        return;
      }
      setContext(result.data);
      setMetadataFields(extractEditableMetadata(result.data.meta_data));
    });
  }

  // §6.2 step 2 — non-audited telemetry, fire-and-forget on every page view.
  useEffect(() => {
    if (!context) return;
    setViewedPages((prev) => {
      if (prev.includes(currentPage)) return prev;
      const next = [...prev, currentPage];
      void postPagesViewed(taskContext, context.task_uid, next);
      return next;
    });
  }, [context, currentPage, taskContext]);

  function toggleError(page: number) {
    setErrorPages((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  }

  function updateMetadataField(index: number, patch: Partial<MetadataField>) {
    setMetadataFields((prev) => prev.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  }

  function removeMetadataField(index: number) {
    setMetadataFields((prev) => prev.filter((_, i) => i !== index));
  }

  async function saveMetadata() {
    if (!context) return;
    setMetadataStatus('saving');
    setMetadataError(null);
    const metaData = Object.fromEntries(
      metadataFields.filter((field) => field.key.trim()).map((field) => [field.key.trim(), field.value]),
    );
    const result = await updateQualificationMetadata(taskContext, context.task_uid, metaData);
    if (!result.ok) {
      setMetadataStatus('error');
      setMetadataError(result.error ?? 'failed to save metadata');
      return;
    }
    // Reflect the server's canonical (key-deduped) view rather than whatever
    // possibly-duplicate-keyed rows the editor had locally before this save.
    setMetadataFields(Object.entries(metaData).map(([key, value]) => ({ key, value })));
    setMetadataStatus('saved');
  }

  async function submit(outcome: QualificationOutcome) {
    if (!context) return;
    if (outcome === 'rework' && !flowbackReason.trim()) {
      setSubmitError('A flowback reason is required for rework.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const result = await completeQualification(
      taskContext,
      context.task_uid,
      outcome,
      Array.from(errorPages),
      outcome === 'rework' ? flowbackReason : undefined,
    );
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error ?? `${outcome} failed`);
      return;
    }
    setSubmitted(outcome);
  }

  if (submitted) {
    return (
      <div className="fluid-screen fluid-screen--qualification">
        <div className="fluid-done">Qualification complete — outcome: {submitted}.</div>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="fluid-screen fluid-screen--qualification">
        <h1>Qualification</h1>
        <p>Enter this task's workflow code to load the file queued for review.</p>
        <label className="fluid-field">
          Workflow code
          <input value={workflowCode} onChange={(event) => setWorkflowCode(event.target.value)} />
        </label>
        <div className="fluid-actions">
          <button className="fluid-btn fluid-btn--primary" onClick={loadContext}>
            Load
          </button>
        </div>
        {loadError && <p className="fluid-alert fluid-alert--error">{loadError}</p>}
      </div>
    );
  }

  const chapterTitle = context.meta_data?.chapter_title;

  return (
    <div className="fluid-screen fluid-screen--qualification">
      <h1>Qualification</h1>
      <p>
        {context.file_name}
        {typeof chapterTitle === 'string' && chapterTitle ? ` — ${chapterTitle}` : ''}
      </p>

      <div className="fluid-page-nav">
        <button
          className="fluid-btn fluid-btn--secondary"
          onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
          disabled={currentPage <= 1}
        >
          ← Previous
        </button>
        <span>
          Page {currentPage}
          {viewedPages.includes(currentPage) ? ' (viewed)' : ''}
        </span>
        <button className="fluid-btn fluid-btn--secondary" onClick={() => setCurrentPage((page) => page + 1)}>
          Next →
        </button>
        <label>
          <input type="checkbox" checked={errorPages.has(currentPage)} onChange={() => toggleError(currentPage)} />
          Flag this page as an error
        </label>
      </div>

      {context.input_download_url ? (
        <iframe
          className="fluid-pdf-frame"
          src={`${context.input_download_url}#page=${currentPage}`}
          title={context.file_name}
        />
      ) : (
        <p className="fluid-alert fluid-alert--warning">
          No preview available for this file yet — its input_download_url hasn't been populated (this can happen
          before the previous task's file_task_users session is fully wired; see README's "known gap" note).
        </p>
      )}

      <p className="fluid-flag-summary">
        Flagged pages: {errorPages.size ? Array.from(errorPages).join(', ') : 'none'}
      </p>

      <div className="fluid-metadata-editor">
        <h2>Metadata</h2>
        {metadataFields.length === 0 && <p className="fluid-flag-summary">No custom metadata yet.</p>}
        {metadataFields.map((field, index) => (
          <div className="fluid-metadata-row" key={index}>
            <input
              placeholder="Field name"
              value={field.key}
              onChange={(event) => updateMetadataField(index, { key: event.target.value })}
            />
            <input
              placeholder="Value"
              value={field.value}
              onChange={(event) => updateMetadataField(index, { value: event.target.value })}
            />
            <button className="fluid-btn fluid-btn--ghost" onClick={() => removeMetadataField(index)}>
              Remove
            </button>
          </div>
        ))}
        <div className="fluid-metadata-actions">
          <button
            className="fluid-btn fluid-btn--secondary"
            onClick={() => setMetadataFields((prev) => [...prev, { key: '', value: '' }])}
          >
            Add field
          </button>
          <button className="fluid-btn fluid-btn--primary" onClick={saveMetadata} disabled={metadataStatus === 'saving'}>
            {metadataStatus === 'saving' && <span className="fluid-spinner" />}
            {metadataStatus === 'saving' ? 'Saving…' : 'Save metadata'}
          </button>
        </div>
        {metadataStatus === 'saved' && <p className="fluid-alert fluid-alert--success">Metadata saved.</p>}
        {metadataStatus === 'error' && <p className="fluid-alert fluid-alert--error">{metadataError}</p>}
      </div>

      <div className="fluid-actions">
        <button className="fluid-btn fluid-btn--primary" onClick={() => submit('clean')} disabled={submitting}>
          Complete (clean)
        </button>
        <div className="fluid-inline-field">
          <input
            placeholder="Flowback reason (required for rework)"
            value={flowbackReason}
            onChange={(event) => setFlowbackReason(event.target.value)}
          />
          <button className="fluid-btn fluid-btn--secondary" onClick={() => submit('rework')} disabled={submitting}>
            Send back for rework
          </button>
        </div>
        <button
          className="fluid-btn fluid-btn--ghost"
          disabled
          title="Blocked pending confirmation of which endpoint/route surface owns archiving (FLUID_APP_DEV_CONTEXT.md §13, open question #2)"
        >
          Archive (not yet available)
        </button>
      </div>

      {submitError && <p className="fluid-alert fluid-alert--error">{submitError}</p>}
    </div>
  );
}
