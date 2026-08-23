import { useEffect, useRef, useState } from 'react';
import type { TaskContext } from '../../types';
import { splitBatch, getBatchSplitStatus, type BatchSplitChild, type ChapterDetectionMethod, type SplitMethod } from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

const ROUTED_TO_LABEL: Record<BatchSplitChild['routedTo'], string> = {
  'manual-fix': 'Manual fix',
  'download-ready': 'Download ready',
  transformation: 'Transformation',
};

const DETECTION_METHOD_LABEL: Record<ChapterDetectionMethod, string> = {
  outline: "PDF's embedded bookmarks/outline",
  'text-scan': 'page-heading text scan',
  'equal-pages': 'equal pages (no chapters found)',
};

/**
 * §6.3 — completes the parent file, then splits it. Two methods:
 * equal-pages (original §6.3 behavior — 2-5 roughly-equal-page-count children,
 * routed by whether they touch flagged pages) or by-chapter (detects chapter
 * headings and produces one file per chapter, each routed to its own
 * Transformation task — PDF text -> XML/JSON — since qualification reviews
 * the transformed output, not these chapters' raw PDFs).
 */
export function BatchSplitScreen({ taskContext }: Props) {
  // Pre-filled from the launch context when available (real uw-fe launch
  // URLs do carry workflow_code — task-context.ts resolves it into
  // taskContext.workflowCode). Still a manual, editable field for launch
  // paths that don't supply it, rather than a hard requirement.
  const [workflowCode, setWorkflowCode] = useState(taskContext.workflowCode ?? '');
  const [splitMethod, setSplitMethod] = useState<SplitMethod>('equal-pages');
  const [status, setStatus] = useState<'idle' | 'splitting' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<BatchSplitChild[]>([]);
  const [usedFallback, setUsedFallback] = useState(false);
  const [detectionMethod, setDetectionMethod] = useState<ChapterDetectionMethod | undefined>(undefined);
  // Polled from the backend's own in-process progress (the same state a
  // resumed /split call picks up from) — real status, not a guessed spinner.
  const [progressPhase, setProgressPhase] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }

  // §10 unmount hygiene — a poll landing after the component's gone would setState on nothing.
  useEffect(() => stopPolling, []);

  async function handleSplit() {
    if (!workflowCode.trim()) {
      setError('workflow code is required to resolve the target task graph (§6.3.1)');
      return;
    }
    setStatus('splitting');
    setError(null);
    setProgressPhase('starting…');

    stopPolling();
    const fileId = taskContext.fileId;
    if (fileId !== undefined) {
      pollIntervalRef.current = setInterval(async () => {
        const statusResult = await getBatchSplitStatus(fileId);
        if (statusResult.ok && statusResult.data) {
          const { phase, totalChunks, chunksReleased } = statusResult.data;
          setProgressPhase(totalChunks > 0 ? `${phase} (${chunksReleased}/${totalChunks} chapters done)` : phase);
        }
      }, 1500);
    }

    const result = await splitBatch(taskContext, workflowCode, splitMethod);
    stopPolling();

    if (!result.ok || !result.data) {
      setStatus('error');
      setError(result.error ?? 'split failed');
      setProgressPhase(null);
      return;
    }
    setChildren(result.data.children);
    setUsedFallback(result.data.usedFallback);
    setDetectionMethod(result.data.detectionMethod);
    setProgressPhase(null);
    setStatus('done');
  }

  return (
    <div className="fluid-screen fluid-screen--batch-split">
      <h1>Batch split</h1>
      <p>
        Completes the parent file (file {taskContext.fileId}) and splits it either into 2-5 roughly-equal-page-count
        files (routing chunks that touch flagged pages to a manual-fix task, §6.3.1) or into one file per detected
        chapter, each routed to its own Transformation task (PDF text → XML/JSON, reviewed in qualification after).
      </p>

      <label className="fluid-field">
        Workflow code
        <input value={workflowCode} onChange={(event) => setWorkflowCode(event.target.value)} />
      </label>

      <div className="fluid-field">
        Split method
        <div className="fluid-radio-group">
          <label className="fluid-radio">
            <input
              type="radio"
              name="split-method"
              checked={splitMethod === 'equal-pages'}
              onChange={() => setSplitMethod('equal-pages')}
            />
            Equal pages (default)
          </label>
          <label className="fluid-radio">
            <input
              type="radio"
              name="split-method"
              checked={splitMethod === 'by-chapter'}
              onChange={() => setSplitMethod('by-chapter')}
            />
            By chapter (detects chapter headings)
          </label>
        </div>
      </div>

      <div className="fluid-actions">
        <button className="fluid-btn fluid-btn--primary" onClick={handleSplit} disabled={status === 'splitting'}>
          {status === 'splitting' && <span className="fluid-spinner" />}
          {status === 'splitting' ? 'Splitting…' : 'Split'}
        </button>
      </div>

      {status === 'splitting' && progressPhase && <p className="fluid-alert fluid-alert--info">{progressPhase}</p>}

      {error && <p className="fluid-alert fluid-alert--error">{error}</p>}

      {status === 'done' && splitMethod === 'by-chapter' && usedFallback && (
        <p className="fluid-alert fluid-alert--warning">
          No chapters were detected in this document (no outline/bookmarks, and no page-heading text match), so it
          split by equal pages instead. Tune BATCH_SPLIT_CHAPTER_HEADING_PATTERN if this book's chapter headings
          look different, or check whether it has embedded bookmarks at all.
        </p>
      )}

      {status === 'done' && splitMethod === 'by-chapter' && !usedFallback && detectionMethod && (
        <p className="fluid-alert fluid-alert--success">
          Detected {children.length} chapters via {DETECTION_METHOD_LABEL[detectionMethod]}.
        </p>
      )}

      {status === 'done' && (
        <table className="fluid-table">
          <thead>
            <tr>
              <th>File ID</th>
              <th>Task UID</th>
              {splitMethod === 'by-chapter' && !usedFallback && <th>Chapter</th>}
              <th>Pages</th>
              <th>Routed to</th>
            </tr>
          </thead>
          <tbody>
            {children.map((child) => (
              <tr key={child.fileId}>
                <td>{child.fileId}</td>
                <td>{child.taskUid}</td>
                {splitMethod === 'by-chapter' && !usedFallback && <td>{child.label ?? '—'}</td>}
                <td>{child.pageNumbers.join(', ')}</td>
                <td>
                  <span className={`fluid-badge fluid-badge--${child.routedTo}`}>
                    {ROUTED_TO_LABEL[child.routedTo]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
