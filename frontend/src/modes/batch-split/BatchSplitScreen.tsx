import { useState } from 'react';
import type { TaskContext } from '../../types';
import { splitBatch, type BatchSplitChild } from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

/** §6.3 — completes the parent file, then splits it into 2-5 roughly-equal-page-count children. */
export function BatchSplitScreen({ taskContext }: Props) {
  const [workflowCode, setWorkflowCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'splitting' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<BatchSplitChild[]>([]);

  async function handleSplit() {
    if (!workflowCode.trim()) {
      setError('workflow code is required to resolve the target task graph (§6.3.1)');
      return;
    }
    setStatus('splitting');
    setError(null);
    const result = await splitBatch(taskContext, workflowCode);
    if (!result.ok || !result.data) {
      setStatus('error');
      setError(result.error ?? 'split failed');
      return;
    }
    setChildren(result.data.children);
    setStatus('done');
  }

  return (
    <div className="fluid-screen fluid-screen--batch-split">
      <h1>Batch split</h1>
      <p>
        Completes the parent file (file {taskContext.fileId}) and splits it into 2-5 roughly-equal-page-count
        files, routing chunks that touch flagged pages to a manual-fix task (§6.3.1).
      </p>

      <label className="fluid-field">
        Workflow code
        <input value={workflowCode} onChange={(event) => setWorkflowCode(event.target.value)} />
      </label>

      <div className="fluid-actions">
        <button className="fluid-btn fluid-btn--primary" onClick={handleSplit} disabled={status === 'splitting'}>
          {status === 'splitting' && <span className="fluid-spinner" />}
          {status === 'splitting' ? 'Splitting…' : 'Split'}
        </button>
      </div>

      {error && <p className="fluid-alert fluid-alert--error">{error}</p>}

      {status === 'done' && (
        <table className="fluid-table">
          <thead>
            <tr>
              <th>File ID</th>
              <th>Task UID</th>
              <th>Pages</th>
              <th>Routed to</th>
            </tr>
          </thead>
          <tbody>
            {children.map((child) => (
              <tr key={child.fileId}>
                <td>{child.fileId}</td>
                <td>{child.taskUid}</td>
                <td>{child.pageNumbers.join(', ')}</td>
                <td>
                  <span className={`fluid-badge fluid-badge--${child.routedTo}`}>
                    {child.routedTo === 'manual-fix' ? 'Manual fix' : 'Download ready'}
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
