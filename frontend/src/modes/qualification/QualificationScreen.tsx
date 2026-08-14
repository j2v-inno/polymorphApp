import { useEffect, useState } from 'react';
import type { TaskContext } from '../../types';
import {
  completeQualification,
  getQualificationContext,
  postPagesViewed,
  type QualificationContext,
  type QualificationOutcome,
} from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

/** §6.2 — page-by-page review with error flagging, then 3-way routing. */
export function QualificationScreen({ taskContext }: Props) {
  const [workflowCode, setWorkflowCode] = useState('');
  const [context, setContext] = useState<QualificationContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [viewedPages, setViewedPages] = useState<number[]>([]);
  const [errorPages, setErrorPages] = useState<Set<number>>(new Set());
  const [flowbackReason, setFlowbackReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<QualificationOutcome | null>(null);

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

  return (
    <div className="fluid-screen fluid-screen--qualification">
      <h1>Qualification</h1>
      <p>{context.file_name}</p>

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

      <p className="fluid-flag-summary">
        Flagged pages: {errorPages.size ? Array.from(errorPages).join(', ') : 'none'}
      </p>

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
