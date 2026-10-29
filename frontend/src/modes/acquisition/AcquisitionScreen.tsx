import { useEffect, useState, type FormEvent } from 'react';
import type { TaskContext } from '../../types';
import { registerAndUploadAcquisition, type AcquisitionResult } from '../../api-client';
import { notifyFilesRegistered } from '../../host';

interface Props {
  taskContext: TaskContext;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'done'; result: AcquisitionResult }
  | { kind: 'error'; message: string };

/** §6.1 — register, gate-check, upload, complete. One backend call does all four steps. */
export function AcquisitionScreen({ taskContext }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const uploading = status.kind === 'uploading';

  // One backend call does all four steps, so there is no real progress to
  // report; a running count tells the operator it hasn't stalled.
  useEffect(() => {
    if (!uploading) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [uploading]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setStatus({ kind: 'uploading' });
    const result = await registerAndUploadAcquisition(taskContext, file);
    if (!result.ok || !result.data) {
      setStatus({ kind: 'error', message: result.error ?? 'upload failed' });
      return;
    }
    notifyFilesRegistered([result.data.fileId]);
    setStatus({ kind: 'done', result: result.data });
  }

  return (
    <div className="fluid-screen fluid-screen--acquisition">
      <h1>Acquisition</h1>
      <p>
        Register and upload the source PDF for workflow {taskContext.workflowCode}.
        {taskContext.jobName ? ` Job ${taskContext.jobName}.` : ' A new job will be created.'}
      </p>

      <form onSubmit={handleSubmit}>
        <label className="fluid-dropzone" htmlFor="fluid-acquisition-file">
          <span className="fluid-dropzone__icon">↑</span>
          <span className="fluid-dropzone__title">{file ? file.name : 'Choose a PDF to upload'}</span>
          <span className="fluid-dropzone__hint">
            {file ? `${(file.size / 1024).toFixed(0)} KB — click to change` : 'PDF files only'}
          </span>
          <input
            id="fluid-acquisition-file"
            type="file"
            accept="application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            disabled={uploading}
          />
        </label>

        <div className="fluid-actions">
          <button
            type="submit"
            className="fluid-btn fluid-btn--primary"
            disabled={!file || uploading}
            aria-busy={uploading}
          >
            {uploading && <span className="fluid-spinner" />}
            {uploading ? 'Registering…' : 'Register & upload'}
          </button>
        </div>
      </form>

      {uploading && (
        <div className="fluid-loading" role="status">
          <span className="fluid-spinner" />
          Registering {file?.name} with Orion, checking its text and uploading it… {elapsed}s
        </div>
      )}

      {status.kind === 'error' && <p className="fluid-alert fluid-alert--error">{status.message}</p>}

      {status.kind === 'done' && (
        <div className="fluid-result">
          <p>
            Registered file <strong>{status.result.fileId}</strong> (task {status.result.taskUid}).
          </p>
          {status.result.gate.isTextExtractable ? (
            <p className="fluid-alert fluid-alert--success">
              Text-extractability gate passed ({status.result.gate.totalPages} pages).
            </p>
          ) : (
            <p className="fluid-alert fluid-alert--warning">
              Text-extractability gate FAILED — looks scanned/image-only. Handled per gate mode "
              {status.result.gateMode}". Reject-vs-flag behavior is still unconfirmed with Bhanu
              (FLUID_APP_DEV_CONTEXT.md §13, open question #1).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
