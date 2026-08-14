import { useState } from 'react';
import type { TaskContext } from '../../types';
import { getDownloadLinks, type DownloadLink } from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

/**
 * §6.4 — terminal screen, no compute. Resolves a download link per split child.
 *
 * get-file-task-output requires task_uid, which TaskContext doesn't carry
 * directly (only the internal numeric taskId) — the backend resolves it via
 * get-all-tasks, which needs workflowCode. TaskContext doesn't carry that
 * either (same gap BatchSplitScreen has), so it's a manual input here too.
 *
 * The doc's "×N (one per split child)" assumes the caller already knows every
 * sibling file ID; how this screen discovers all N split-file IDs from a single
 * batch/job launch context isn't specified (no confirmed batch-siblings endpoint
 * in §6 — §7 flags the two obvious candidates as broken). Defaults to the
 * current taskContext.fileId, which always resolves, with a manual add-more
 * affordance until sibling discovery is confirmed.
 */
export function DownloadScreen({ taskContext }: Props) {
  // Pre-filled from the launch context when available — see the same note
  // in BatchSplitScreen.tsx.
  const [workflowCode, setWorkflowCode] = useState(taskContext.workflowCode ?? '');
  const [fileIds, setFileIds] = useState<number[]>(taskContext.fileId ? [taskContext.fileId] : []);
  const [extraFileId, setExtraFileId] = useState('');
  const [links, setLinks] = useState<DownloadLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh(ids: number[]) {
    if (!workflowCode.trim()) {
      setError('workflow code is required to resolve task_uid for these file IDs (§6.4)');
      return;
    }
    setLoading(true);
    setError(null);
    const result = await getDownloadLinks(taskContext, workflowCode, ids);
    setLoading(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? 'failed to resolve download links');
      return;
    }
    setLinks(result.data.links);
  }

  function addFileId() {
    const id = Number(extraFileId);
    if (!id || fileIds.includes(id)) return;
    const next = [...fileIds, id];
    setFileIds(next);
    setExtraFileId('');
    void refresh(next);
  }

  return (
    <div className="fluid-screen fluid-screen--download">
      <h1>Download</h1>

      <label className="fluid-field">
        Workflow code
        <input value={workflowCode} onChange={(event) => setWorkflowCode(event.target.value)} />
      </label>

      <div className="fluid-inline-field">
        <input
          placeholder="Add sibling split file ID"
          value={extraFileId}
          onChange={(event) => setExtraFileId(event.target.value)}
        />
        <button className="fluid-btn fluid-btn--secondary" onClick={addFileId}>
          Add
        </button>
        <button className="fluid-btn fluid-btn--primary" onClick={() => refresh(fileIds)} disabled={loading}>
          {loading && <span className="fluid-spinner" />}
          {loading ? 'Resolving…' : 'Resolve links'}
        </button>
      </div>

      {error && <p className="fluid-alert fluid-alert--error">{error}</p>}

      <ul className="fluid-link-list">
        {links.map((link) => (
          <li key={link.fileId}>
            {link.ok && link.downloadUrl ? (
              <a href={link.downloadUrl} target="_blank" rel="noreferrer">
                {link.fileName ?? `file ${link.fileId}`} ({link.status})
              </a>
            ) : (
              <span className="fluid-error">
                file {link.fileId}: {link.error ?? 'not available yet'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
