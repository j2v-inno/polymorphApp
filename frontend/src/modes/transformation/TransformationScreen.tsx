import { useState } from 'react';
import type { TaskContext } from '../../types';
import { transformFile, type TransformFormat, type TransformResult } from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

/**
 * New task — converts this (already by-chapter-split) file's PDF text into
 * structured XML or JSON, one chunk per page, then routes the result to the
 * qualification task for a second review pass. See README.md's
 * "Transformation" section for the deliberate FLUID_APP_DEV_CONTEXT.md scope
 * deviation this represents.
 */
export function TransformationScreen({ taskContext }: Props) {
  // workflow_code/workflow_id come from the launch URL via task-context.ts.
  const [format, setFormat] = useState<TransformFormat>('json');
  const [status, setStatus] = useState<'idle' | 'transforming' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TransformResult | null>(null);

  async function handleTransform() {
    if (!taskContext.workflowCode) {
      setError('workflow code is required to resolve the target task graph');
      return;
    }
    setStatus('transforming');
    setError(null);
    const response = await transformFile(taskContext, taskContext.workflowCode ?? '', format);
    if (!response.ok || !response.data) {
      setStatus('error');
      setError(response.error ?? 'transformation failed');
      return;
    }
    setResult(response.data);
    setStatus('done');
  }

  return (
    <div className="fluid-screen fluid-screen--transformation">
      <h1>Transformation</h1>
      <p>
        Completes this chapter file (file {taskContext.fileId}) and converts its extracted PDF text into a
        structured document — one chunk per page, tagged with order/page/heading — routed to qualification for
        review once done.
      </p>

      <label className="fluid-field">
        Workflow code
        <input value={taskContext.workflowCode ?? ''} disabled readOnly />
      </label>

      <div className="fluid-field">
        Output format
        <div className="fluid-radio-group">
          <label className="fluid-radio">
            <input type="radio" name="transform-format" checked={format === 'json'} onChange={() => setFormat('json')} />
            JSON
          </label>
          <label className="fluid-radio">
            <input type="radio" name="transform-format" checked={format === 'xml'} onChange={() => setFormat('xml')} />
            XML
          </label>
        </div>
      </div>

      <div className="fluid-actions">
        <button className="fluid-btn fluid-btn--primary" onClick={handleTransform} disabled={status === 'transforming'}>
          {status === 'transforming' && <span className="fluid-spinner" />}
          {status === 'transforming' ? 'Transforming…' : 'Run transformation'}
        </button>
      </div>

      {error && <p className="fluid-alert fluid-alert--error">{error}</p>}

      {status === 'done' && result && (
        <div className="fluid-alert fluid-alert--success">
          Transformed {result.pageCount} page{result.pageCount === 1 ? '' : 's'} to {result.format.toUpperCase()} —
          output file {result.fileId}, routed to qualification (task {result.taskUid}).
        </div>
      )}
    </div>
  );
}
