import { useEffect, useRef, useState } from 'react';
import type { TaskContext } from '../../types';
import {
  parseBulkRegistrationSheet,
  startBulkRegistration,
  getBulkRegistrationStatus,
  getBulkRegistrationColumnValues,
  type ParsedSheet,
  type BulkRegistrationResult,
} from '../../api-client';

interface Props {
  taskContext: TaskContext;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'parsing' }
  | { kind: 'picking'; sheet: ParsedSheet }
  | { kind: 'running'; sheet: ParsedSheet }
  | { kind: 'done'; sheet: ParsedSheet; result: BulkRegistrationResult }
  | { kind: 'error'; message: string };

/**
 * Another content-acquisition entry point (not in FLUID_APP_DEV_CONTEXT.md's
 * original §6): instead of one manual PDF upload, takes a spreadsheet with
 * one row per file to register. Every row gets the exact same placeholder
 * PDF — there's no real per-row document — only a filename and metadata
 * differ, both picked from the sheet's own columns. Reuses the same
 * register->gate->upload->complete flow as Acquisition, once per row.
 */
export function BulkRegistrationScreen({ taskContext }: Props) {
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [workflowCode, setWorkflowCode] = useState(taskContext.workflowCode ?? '');
  const [fileNameColumn, setFileNameColumn] = useState('');
  const [metadataColumns, setMetadataColumns] = useState<string[]>([]);
  /** String, not number, so the field can sit empty (= no limit, register every row) without fighting a numeric default. */
  const [limitInput, setLimitInput] = useState('');
  /** '' = no routing — the original single-destination behavior (no next_task sent). */
  const [routingColumn, setRoutingColumn] = useState('');
  const [routingValues, setRoutingValues] = useState<string[]>([]);
  const [routingValuesLoading, setRoutingValuesLoading] = useState(false);
  /** Distinct column value -> target task_uid the operator typed in. Not validated client-side — the backend checks every value has a rule before touching any row and reports exactly which ones are missing. */
  const [routingRuleInputs, setRoutingRuleInputs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
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

  async function handleParse() {
    if (!sheetFile) return;
    setStatus({ kind: 'parsing' });
    const result = await parseBulkRegistrationSheet(sheetFile);
    if (!result.ok || !result.data) {
      setStatus({ kind: 'error', message: result.error ?? 'could not parse spreadsheet' });
      return;
    }
    setFileNameColumn(result.data.columns[0] ?? '');
    setMetadataColumns([]);
    setRoutingColumn('');
    setRoutingValues([]);
    setRoutingRuleInputs({});
    setStatus({ kind: 'picking', sheet: result.data });
  }

  function toggleMetadataColumn(column: string) {
    setMetadataColumns((prev) => (prev.includes(column) ? prev.filter((c) => c !== column) : [...prev, column]));
  }

  async function handleRoutingColumnChange(column: string, sheetId: string) {
    setRoutingColumn(column);
    setRoutingRuleInputs({});
    if (!column) {
      setRoutingValues([]);
      return;
    }
    setRoutingValuesLoading(true);
    const result = await getBulkRegistrationColumnValues(sheetId, column);
    setRoutingValuesLoading(false);
    setRoutingValues(result.ok && result.data ? result.data.values : []);
  }

  async function handleStart() {
    if (status.kind !== 'picking' && status.kind !== 'done') return;
    const sheet = status.kind === 'picking' ? status.sheet : status.sheet;
    if (!workflowCode.trim() || !fileNameColumn) return;

    let limit: number | undefined;
    if (limitInput.trim()) {
      limit = Number(limitInput);
      if (!Number.isInteger(limit) || limit <= 0) {
        setStatus({ kind: 'error', message: 'Limit must be a positive whole number, or left blank to register every row.' });
        return;
      }
    }

    setStatus({ kind: 'running', sheet });
    setProgressPhase('starting…');

    stopPolling();
    pollIntervalRef.current = setInterval(async () => {
      const statusResult = await getBulkRegistrationStatus(sheet.sheetId);
      if (statusResult.ok && statusResult.data) {
        const { phase, total, completed, failed } = statusResult.data;
        setProgressPhase(total > 0 ? `${phase} (${completed} done, ${failed} failed, of ${total})` : phase);
      }
    }, 1500);

    const result = await startBulkRegistration(taskContext, {
      workflowCode,
      sheetId: sheet.sheetId,
      fileNameColumn,
      metadataColumns,
      limit,
      routingColumn: routingColumn || undefined,
      routingRules: routingColumn ? routingRuleInputs : undefined,
    });
    stopPolling();
    setProgressPhase(null);

    if (!result.ok || !result.data) {
      setStatus({ kind: 'error', message: result.error ?? 'bulk registration failed' });
      return;
    }
    setStatus({ kind: 'done', sheet, result: result.data });
  }

  const canPickColumns = status.kind === 'picking' || status.kind === 'done';
  const isRunning = status.kind === 'running';

  return (
    <div className="fluid-screen fluid-screen--bulk-registration">
      <h1>Bulk registration</h1>
      <p>
        Upload a spreadsheet (CSV or Excel) with one row per file to register. Pick which column supplies each
        file's name and which columns get attached as metadata — every row registers the same placeholder PDF and
        goes through the same register → text-extractability gate → upload → complete flow as Acquisition.
      </p>

      {status.kind !== 'picking' && status.kind !== 'running' && status.kind !== 'done' && (
        <>
          <label className="fluid-dropzone" htmlFor="fluid-bulk-registration-file">
            <span className="fluid-dropzone__icon">↑</span>
            <span className="fluid-dropzone__title">{sheetFile ? sheetFile.name : 'Choose a CSV or Excel sheet'}</span>
            <span className="fluid-dropzone__hint">
              {sheetFile ? `${(sheetFile.size / 1024).toFixed(0)} KB — click to change` : '.csv, .xlsx, .xls'}
            </span>
            <input
              id="fluid-bulk-registration-file"
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(event) => setSheetFile(event.target.files?.[0] ?? null)}
              disabled={status.kind === 'parsing'}
            />
          </label>

          <div className="fluid-actions">
            <button
              className="fluid-btn fluid-btn--primary"
              onClick={handleParse}
              disabled={!sheetFile || status.kind === 'parsing'}
            >
              {status.kind === 'parsing' && <span className="fluid-spinner" />}
              {status.kind === 'parsing' ? 'Parsing…' : 'Parse sheet'}
            </button>
          </div>
        </>
      )}

      {canPickColumns && (
        <>
          <p className="fluid-flag-summary">
            {status.sheet.rowCount} rows, {status.sheet.columns.length} columns found in {sheetFile?.name}.
          </p>

          <label className="fluid-field">
            Workflow code
            <input value={workflowCode} onChange={(event) => setWorkflowCode(event.target.value)} disabled={isRunning} />
          </label>

          <label className="fluid-field">
            File name column
            <select value={fileNameColumn} onChange={(event) => setFileNameColumn(event.target.value)} disabled={isRunning}>
              {status.sheet.columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
          </label>

          <label className="fluid-field">
            Limit (optional)
            <input
              type="number"
              min={1}
              max={status.sheet.rowCount}
              step={1}
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
              placeholder={`All ${status.sheet.rowCount} rows`}
              disabled={isRunning}
            />
          </label>

          <div className="fluid-field">
            Metadata columns ({metadataColumns.length} selected)
            <div className="fluid-radio-group">
              {status.sheet.columns.map((column) => (
                <label key={column} className="fluid-radio">
                  <input
                    type="checkbox"
                    checked={metadataColumns.includes(column)}
                    onChange={() => toggleMetadataColumn(column)}
                    disabled={isRunning || column === fileNameColumn}
                  />
                  {column}
                  {column === fileNameColumn ? ' (used as file name)' : ''}
                </label>
              ))}
            </div>
          </div>

          <label className="fluid-field">
            Route by column (optional)
            <select
              value={routingColumn}
              onChange={(event) => handleRoutingColumnChange(event.target.value, status.sheet.sheetId)}
              disabled={isRunning}
            >
              <option value="">None — single destination for every row</option>
              {status.sheet.columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </select>
          </label>

          {routingColumn && (
            <div className="fluid-field">
              Target task per "{routingColumn}" value
              {routingValuesLoading ? (
                <p className="fluid-flag-summary">Loading distinct values…</p>
              ) : (
                <div className="fluid-metadata-editor">
                  {routingValues.map((value) => (
                    <div key={value} className="fluid-metadata-row">
                      <input value={value} disabled readOnly />
                      <input
                        placeholder="Target task UID"
                        value={routingRuleInputs[value] ?? ''}
                        onChange={(event) =>
                          setRoutingRuleInputs((prev) => ({ ...prev, [value]: event.target.value }))
                        }
                        disabled={isRunning}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="fluid-actions">
            <button
              className="fluid-btn fluid-btn--primary"
              onClick={handleStart}
              disabled={!workflowCode.trim() || !fileNameColumn || isRunning}
            >
              {isRunning && <span className="fluid-spinner" />}
              {isRunning ? 'Registering…' : 'Start bulk registration'}
            </button>
          </div>
        </>
      )}

      {isRunning && progressPhase && <p className="fluid-alert fluid-alert--info">{progressPhase}</p>}

      {status.kind === 'error' && <p className="fluid-alert fluid-alert--error">{status.message}</p>}

      {status.kind === 'done' && (
        <>
          <p className={`fluid-alert fluid-alert--${status.result.failed > 0 ? 'warning' : 'success'}`}>
            {status.result.succeeded} of {status.result.total} rows registered successfully
            {status.result.failed > 0 ? `, ${status.result.failed} failed.` : '.'}
          </p>

          <table className="fluid-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>File name</th>
                <th>File ID</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {status.result.rows.map((row) => (
                <tr key={row.rowIndex}>
                  <td>{row.rowIndex + 1}</td>
                  <td>{row.fileName}</td>
                  <td>{row.fileId ?? '—'}</td>
                  <td>
                    {row.ok ? (
                      <span className="fluid-badge fluid-badge--download-ready">Registered</span>
                    ) : (
                      <span className="fluid-badge fluid-badge--manual-fix" title={row.error}>
                        Failed
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {status.result.failed > 0 && (
            <div className="fluid-actions">
              <button className="fluid-btn fluid-btn--secondary" onClick={handleStart}>
                Retry failed rows
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
