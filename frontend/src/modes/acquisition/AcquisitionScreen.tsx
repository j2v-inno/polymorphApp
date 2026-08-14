import { useState, type FormEvent } from 'react';
import type { TaskContext } from '../../types';
import { registerAndUploadAcquisition, type AcquisitionResult } from '../../api-client';

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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setStatus({ kind: 'uploading' });
    const result = await registerAndUploadAcquisition(taskContext, file);
    if (!result.ok || !result.data) {
      setStatus({ kind: 'error', message: result.error ?? 'upload failed' });
      return;
    }
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
            disabled={status.kind === 'uploading'}
          />
        </label>

        <div className="fluid-actions">
          <button type="submit" className="fluid-btn fluid-btn--primary" disabled={!file || status.kind === 'uploading'}>
            {status.kind === 'uploading' && <span className="fluid-spinner" />}
            {status.kind === 'uploading' ? 'Uploading…' : 'Register & upload'}
          </button>
        </div>
      </form>

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
