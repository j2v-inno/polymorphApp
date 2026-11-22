import { useCallback, useEffect, useState } from 'react';
import type { TaskContext } from '../../types';
import {
  createSamplingBatches,
  getNextSample,
  getSamplingBatch,
  listSamplingBatches,
  releaseSamplingBatches,
  reviewSample,
  type NextSample,
  type SamplingBatchFile,
  type SamplingBatchSummary,
} from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

type Batch = SamplingBatchSummary & { files: SamplingBatchFile[] };
type Current = { sample: NextSample; fileName: string; content: string };

const STATUS_LABEL: Record<string, string> = {
  pending: 'To review',
  approved: 'Approved',
  rejected: 'In rework',
};

function shortUid(uid: string): string {
  return uid.slice(0, 8);
}

/**
 * Reviews the sampled files of Orion's sampling batches. Orion hands each reviewer one sample at a time from a
 * batch assigned to them; once every sample of a batch is approved, the whole batch is released on.
 */
export function SamplingReviewScreen({ taskContext }: Props) {
  const [batches, setBatches] = useState<SamplingBatchSummary[]>([]);
  const [showReleased, setShowReleased] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [asked, setAsked] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadBatches = useCallback(async () => {
    const result = await listSamplingBatches();
    if (!result.ok || !result.data) {
      setError(result.error ?? 'Could not load the batches.');
      return;
    }
    setBatches(result.data.batches);
  }, []);

  const openBatch = useCallback(async (uid: string) => {
    const result = await getSamplingBatch(uid);
    if (!result.ok || !result.data) {
      setError(result.error ?? 'Could not load the batch.');
      return;
    }
    setBatch(result.data);
  }, []);

  const loadNext = useCallback(async () => {
    setBusy('next');
    setError(null);
    const result = await getNextSample();
    setBusy(null);
    setAsked(true);
    setComment('');
    if (!result.ok) {
      setError(result.error ?? 'Could not get your next sample.');
      return;
    }
    setCurrent(result.data ?? null);
    if (result.data) await openBatch(result.data.sample.batch_uid);
    await loadBatches();
  }, [loadBatches, openBatch]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  async function decide(decision: 'approve' | 'reject') {
    if (!current) return;
    if (decision === 'reject' && !comment.trim()) {
      setError('Say why the file is rejected. The reason goes back to the rework task.');
      return;
    }
    setBusy(decision);
    setError(null);
    const result = await reviewSample(current.sample.file_id, decision, decision === 'reject' ? comment : undefined);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'The review was not saved.');
      return;
    }
    setNotice(decision === 'approve' ? `Approved ${current.fileName}.` : `Sent ${current.fileName} back for rework.`);
    await loadNext();
  }

  // Refresh also cuts batches from the files waiting now, so a full batch shows up without the scheduler.
  async function refresh() {
    setBusy('refresh');
    setError(null);
    const result = await createSamplingBatches();
    if (!result.ok || !result.data) {
      setError(result.error ?? 'Could not cut new batches.');
    } else if (result.data.created) {
      setNotice(`Cut ${result.data.created} new batch(es).`);
    }
    await loadBatches();
    setBusy(null);
  }

  async function release() {
    setBusy('release');
    setError(null);
    const result = await releaseSamplingBatches();
    setBusy(null);
    if (!result.ok || !result.data) {
      setError(result.error ?? 'Release failed.');
      return;
    }
    const routed = result.data.released.reduce((sum, b) => sum + b.routed, 0);
    const failed = result.data.failed.map((f) => `${shortUid(f.uid)}: ${f.error}`).join('; ');
    setNotice(
      result.data.released.length
        ? `Released ${result.data.released.length} batch(es): ${routed} files sent on.${failed ? ` Failed: ${failed}` : ''}`
        : failed
          ? `Nothing released. ${failed}`
          : 'No batch is ready yet: every sample must be approved first.',
    );
    await loadBatches();
    if (batch) await openBatch(batch.uid);
  }

  const visible = batches.filter((b) => showReleased || b.status !== 'released');
  const readyCount = batches.filter((b) => b.status === 'in_review' && b.ready_for_release).length;
  const samples = batch?.files.filter((f) => f.is_sampled) ?? [];

  return (
    <div className="fluid-screen fluid-review">
      <div className="fluid-review__head">
        <div>
          <h1>Sample review</h1>
          <p className="fluid-review__sub">
            {taskContext.workflowCode ?? 'Workflow'} · approve every sample to release its batch; a rejected sample goes
            back for rework
          </p>
        </div>
        <div className="fluid-toolbar">
          <button className="fluid-btn fluid-btn--secondary" onClick={() => void refresh()} disabled={busy !== null}>
            {busy === 'refresh' && <span className="fluid-spinner" />}
            Refresh
          </button>
          <button className="fluid-btn fluid-btn--primary" onClick={() => void release()} disabled={busy !== null || readyCount === 0}>
            {busy === 'release' && <span className="fluid-spinner" />}
            Release ready batches{readyCount ? ` (${readyCount})` : ''}
          </button>
        </div>
      </div>

      {error && <p className="fluid-alert fluid-alert--error">{error}</p>}
      {notice && <p className="fluid-alert fluid-alert--success">{notice}</p>}

      <div className="fluid-review__grid">
        <section className="fluid-review__pane">
          <div className="fluid-review__pane-head">
            <h2>Batches</h2>
            <label className="fluid-review__toggle">
              <input type="checkbox" checked={showReleased} onChange={(e) => setShowReleased(e.target.checked)} /> Show released
            </label>
          </div>
          {visible.length === 0 && <p className="fluid-review__empty">No batches waiting for review.</p>}
          <ul className="fluid-review__list">
            {visible.map((b) => (
              <li key={b.uid}>
                <button
                  className={`fluid-review__item${batch?.uid === b.uid ? ' is-active' : ''}`}
                  onClick={() => void openBatch(b.uid)}
                >
                  <span className="fluid-review__item-title">Batch {shortUid(b.uid)}</span>
                  <span className="fluid-review__item-meta">
                    {b.file_count} files · {b.sample_count} sampled · {b.reviewer ?? 'not assigned'}
                  </span>
                  <span className={`fluid-review__pill fluid-review__pill--${b.status === 'released' ? 'done' : b.ready_for_release ? 'ready' : 'open'}`}>
                    {b.status === 'released' ? 'Released' : b.ready_for_release ? 'Ready' : `${b.pending_count} to review`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="fluid-review__pane">
          <div className="fluid-review__pane-head">
            <h2>{batch ? `Samples of ${shortUid(batch.uid)}` : 'Samples'}</h2>
          </div>
          {!batch && <p className="fluid-review__empty">Pick a batch to see its samples.</p>}
          {batch && (
            <>
              <ul className="fluid-review__list">
                {samples.map((f) => (
                  <li key={f.file_id}>
                    <div className={`fluid-review__item${current?.sample.file_id === f.file_id ? ' is-active' : ''}`}>
                      <span className="fluid-review__item-title">{f.file_name}</span>
                      <span className="fluid-review__item-meta">
                        file {f.file_id}
                        {f.reject_count ? ` · rejected ${f.reject_count}×` : ''}
                        {f.reviewed_by ? ` · ${f.reviewed_by}` : ''}
                      </span>
                      <span className={`fluid-review__pill fluid-review__pill--${f.review_status ?? 'open'}`}>
                        {STATUS_LABEL[f.review_status ?? ''] ?? 'Sampled'}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="fluid-review__foot">
                {batch.file_count - samples.length} unsampled files travel with this batch when it is released.
              </p>
            </>
          )}
        </section>

        <section className="fluid-review__pane fluid-review__pane--wide">
          <div className="fluid-review__pane-head">
            <h2>{current ? current.fileName : 'Your sample'}</h2>
            <button className="fluid-btn fluid-btn--secondary" onClick={() => void loadNext()} disabled={busy !== null}>
              {busy === 'next' && <span className="fluid-spinner" />}
              {current ? 'Reload' : 'Get my next sample'}
            </button>
          </div>
          {!current && !asked && <p className="fluid-review__empty">Get your next sample to start reviewing.</p>}
          {!current && asked && <p className="fluid-review__empty">No samples waiting for you. Batches are cut every few minutes.</p>}
          {current && (
            <>
              <p className="fluid-review__item-meta">
                Batch {shortUid(current.sample.batch_uid)} · sample {current.sample.sampled_position} of {current.sample.sample_count}
                {current.sample.reject_count ? ` · back from rework (${current.sample.reject_count}×): ${current.sample.review_comment ?? ''}` : ''}
              </p>
              <pre className="fluid-content-viewer">{current.content}</pre>
              <div className="fluid-review__decide">
                <textarea
                  className="fluid-review__comment"
                  placeholder="Reason for rejecting (sent back to the rework task)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={2}
                />
                <div className="fluid-toolbar">
                  <button className="fluid-btn fluid-btn--primary" onClick={() => void decide('approve')} disabled={busy !== null}>
                    {busy === 'approve' && <span className="fluid-spinner" />}
                    Approve
                  </button>
                  <button className="fluid-btn fluid-btn--secondary fluid-review__reject" onClick={() => void decide('reject')} disabled={busy !== null}>
                    {busy === 'reject' && <span className="fluid-spinner" />}
                    Reject
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
