import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import XLSX from 'xlsx';
import { registerJobBatchFile, updateFileStatus } from '../uwbe-client/endpoints.js';
import { putRawBytes } from '../uwbe-client/http.js';
import { checkTextExtractability, type TextExtractabilityResult } from '../pdf/text-extractable.js';
import { generatePlaceholderPdf } from '../pdf/dummy.js';
import { config } from '../config.js';
import { withUniqueSuffix } from '../lib/unique-filename.js';
import { tryUwbe } from '../lib/retry.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const bulkRegistrationRouter = Router();

// ---------------------------------------------------------------------------
// Step 1 — parse the uploaded sheet, hand back its columns for the picker UI
// ---------------------------------------------------------------------------

interface ParsedSheet {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * Keyed by a generated sheetId, not a uw-be fileId — there's no uw-be file at
 * all at parse time, this is purely "what did the user upload." Lost on a
 * container restart, same tradeoff batch-split's in-process progress accepts
 * (dev tooling; a fresh parse is needed after that).
 */
const parsedSheets = new Map<string, ParsedSheet>();

bulkRegistrationRouter.post('/parse', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ ok: false, error: 'multipart field "file" is required' });
    return;
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: 'buffer' });
  } catch (err) {
    res.status(400).json({ ok: false, error: `could not parse spreadsheet: ${err instanceof Error ? err.message : 'unknown error'}` });
    return;
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    res.status(400).json({ ok: false, error: 'spreadsheet has no sheets' });
    return;
  }

  // defval keeps every row's key set identical even when a cell is blank —
  // without it, sheet_to_json omits that key entirely for just that row,
  // which would silently drop the value when building metaData/fileName below.
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: false });
  if (rows.length === 0) {
    res.status(400).json({ ok: false, error: 'spreadsheet has no data rows' });
    return;
  }

  const columns = Object.keys(rows[0]);
  const sheetId = randomUUID();
  parsedSheets.set(sheetId, { columns, rows });

  res.json({ ok: true, data: { sheetId, columns, rowCount: rows.length } });
});

/** Distinct values for one column, for the routing-rule picker (one input per value, not free text — avoids typos against a 497-row sheet). */
bulkRegistrationRouter.get('/:sheetId/column-values', (req, res) => {
  const sheet = parsedSheets.get(req.params.sheetId);
  if (!sheet) {
    res.status(404).json({ ok: false, error: 'unknown sheetId — re-upload the spreadsheet' });
    return;
  }
  const column = String(req.query.column ?? '');
  if (!column || !sheet.columns.includes(column)) {
    res.status(400).json({ ok: false, error: "column query param must name one of the sheet's own columns" });
    return;
  }
  const values = Array.from(new Set(sheet.rows.map((row) => String(row[column] ?? '')))).sort();
  res.json({ ok: true, data: { values } });
});

// ---------------------------------------------------------------------------
// Step 2 — iterate every row: register, gate-check, upload, complete. Same
// per-row flow as /acquisition (register-job-batch-file -> text-extractability
// gate -> upload -> update-file-status), just driven once per row instead of
// once per manual upload. Every row gets the exact same placeholder PDF —
// there's no real per-row document, only a filename (picked column) and
// metadata (picked columns) that differ.
// ---------------------------------------------------------------------------

interface StartBody {
  projectCode: string;
  workflowCode: string;
  /** Plumbing only — uw-be calls use workflowCode. Kept so payloads mirror the launch URL. */
  workflowId?: number;
  firstTaskUid: string;
  sheetId: string;
  fileNameColumn: string;
  metadataColumns?: string[];
  /** Optional cap on how many of the sheet's rows to register, in row order — a safety guard against accidentally kicking off a run against a much larger sheet than intended. Omit to process every row. */
  limit?: number;
  /** Which column's value picks a per-row completion target task (e.g. "Level" → route Grad-level rows to the grad team's task, Undergrad to another). Omit for the original single-destination behavior (no `next_task` sent at all). */
  routingColumn?: string;
  /** Column value -> target task_uid. Must cover every value the routingColumn actually takes across the (limited) rows being registered — checked upfront, before any row is touched, not discovered mid-run. Re-checked on every /start call (including a resume), so missing rules can be filled in and retried without losing already-completed rows. */
  routingRules?: Record<string, string>;
  userId?: number;
}

interface PlannedRow {
  rowIndex: number;
  fileName: string;
  metaData: Record<string, string>;
  /** The sheet's own row, kept for routing-rule lookups on any call (including a resume with newly-added rules) — not just the columns already baked into fileName/metaData at plan-build time. */
  rawRow: Record<string, string>;
  registeredFileId?: number;
  taskUid?: string;
  uploadUrl?: string;
  uploaded: boolean;
  completed: boolean;
  failed: boolean;
  error?: string;
}

interface BulkRegistrationRun {
  phase: string;
  plan: PlannedRow[];
  /** Same purpose as batch-split's — guards against a second /start for the
   * same sheetId interleaving with one still in flight (e.g. a client retry
   * after a gateway timeout that didn't actually mean the run failed). */
  busy: boolean;
}

const inFlightRuns = new Map<string, BulkRegistrationRun>();

function summarize(run: BulkRegistrationRun) {
  const total = run.plan.length;
  const completed = run.plan.filter((r) => r.completed).length;
  const failed = run.plan.filter((r) => r.failed).length;
  return { phase: run.phase, total, completed, failed };
}

bulkRegistrationRouter.get('/status/:sheetId', (req, res) => {
  const run = inFlightRuns.get(req.params.sheetId);
  if (!run) {
    res.json({ ok: true, data: { phase: 'idle', total: 0, completed: 0, failed: 0 } });
    return;
  }
  res.json({ ok: true, data: summarize(run) });
});

function resolveFileName(rawValue: string, rowIndex: number): string {
  const trimmed = rawValue.trim() || `row-${rowIndex + 1}`;
  const withExtension = /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
  // Every attempt gets a fresh unique suffix at plan-build time only (not
  // re-applied per retry) — a row that fails after registering already holds
  // its one attempt's filename; retrying it reuses the SAME registeredFileId
  // check below rather than re-registering under a new name.
  return withUniqueSuffix(withExtension);
}

/**
 * Unlike /batch/split, a failure on one row does NOT stop the run — these are
 * independent spreadsheet rows, not chunks of one logical parent, so partial
 * success is meaningful. Always responds 200 with a per-row tally; check
 * `data.failed`/`data.rows` for what actually happened. Re-POSTing the same
 * sheetId resumes: completed rows are skipped, failed/pending rows retry.
 */
bulkRegistrationRouter.post('/start', async (req, res) => {
  const body = req.body as StartBody;
  if (!body.projectCode || !body.workflowCode || !body.firstTaskUid || !body.sheetId || !body.fileNameColumn) {
    res.status(400).json({
      ok: false,
      error: 'projectCode, workflowCode, firstTaskUid, sheetId, and fileNameColumn are required',
    });
    return;
  }
  if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit <= 0)) {
    res.status(400).json({ ok: false, error: 'limit must be a positive integer when supplied' });
    return;
  }

  const existing = inFlightRuns.get(body.sheetId);
  if (existing?.busy) {
    res.status(409).json({
      ok: false,
      error:
        `Already running (${existing.phase}). A gateway timeout doesn't mean it failed — ` +
        `check GET /status/${body.sheetId} instead of starting again right away.`,
      busy: true,
    });
    return;
  }

  let run = existing;
  if (!run) {
    const sheet = parsedSheets.get(body.sheetId);
    if (!sheet) {
      res.status(404).json({ ok: false, error: 'unknown sheetId — re-upload the spreadsheet' });
      return;
    }
    const metadataColumns = body.metadataColumns ?? [];
    // Row order, not sheet-appearance order — sheet.rows is already in that
    // order (XLSX.utils.sheet_to_json preserves it), so slicing here is the
    // same as "first N rows" in the actual spreadsheet.
    const rows = body.limit !== undefined ? sheet.rows.slice(0, body.limit) : sheet.rows;
    run = {
      phase: 'starting',
      busy: true,
      plan: rows.map((row, rowIndex) => ({
        rowIndex,
        fileName: resolveFileName(String(row[body.fileNameColumn] ?? ''), rowIndex),
        metaData: Object.fromEntries(metadataColumns.map((col) => [col, String(row[col] ?? '')])),
        rawRow: row,
        uploaded: false,
        completed: false,
        failed: false,
      })),
    };
    inFlightRuns.set(body.sheetId, run);
  } else {
    run.busy = true;
  }

  // Validate routing BEFORE touching any row — a 497-row run shouldn't burn
  // through real uw-be registrations only to discover row 300's value has no
  // rule. Re-checked on every call (including a resume) so newly-added rules
  // are picked up without needing to rebuild the plan.
  if (body.routingColumn) {
    const rules = body.routingRules ?? {};
    const missing = new Set<string>();
    for (const row of run.plan) {
      if (row.completed) continue;
      const value = String(row.rawRow[body.routingColumn] ?? '');
      if (!(value in rules)) missing.add(value);
    }
    if (missing.size > 0) {
      run.busy = false;
      res.status(400).json({
        ok: false,
        error: `No routing rule for ${missing.size} distinct value(s) of "${body.routingColumn}": ${Array.from(missing).join(', ')}`,
        missingValues: Array.from(missing),
      });
      return;
    }
  }

  try {
    const placeholderPdf = await generatePlaceholderPdf();
    // Same fixed bytes every row — the gate's outcome can't differ between
    // rows, so compute it once instead of re-parsing the identical PDF N times.
    let gate: TextExtractabilityResult | undefined;

    for (const row of run.plan) {
      if (row.completed) continue;
      row.failed = false;
      row.error = undefined;
      const rowLabel = `row ${row.rowIndex + 1}/${run.plan.length} (${row.fileName})`;

      if (row.registeredFileId === undefined) {
        run.phase = `registering ${rowLabel}`;
        const registered = await tryUwbe(() =>
          registerJobBatchFile({
            projectCode: body.projectCode,
            workflowCode: body.workflowCode,
            firstTaskUid: body.firstTaskUid,
            fileName: row.fileName,
            filePath: row.fileName,
            fileUniqueIdentifier: `bulk-${body.firstTaskUid}-${row.rowIndex}-${Date.now()}`,
            metaData: row.metaData,
            userId: body.userId,
          }),
        );
        if (!registered.ok || !registered.data || !registered.data.file_output_upload_url) {
          row.failed = true;
          row.error = registered.error ?? "register-job-batch-file returned no upload URL — check this task's upload_to_storage flag";
          continue;
        }
        row.registeredFileId = registered.data.file_id;
        row.taskUid = body.firstTaskUid;
        row.uploadUrl = registered.data.file_output_upload_url;
      }

      if (!row.uploaded) {
        run.phase = `uploading ${rowLabel}`;
        try {
          await putRawBytes(row.uploadUrl!, placeholderPdf, 'application/pdf');
          row.uploaded = true;
        } catch (err) {
          row.failed = true;
          row.error = err instanceof Error ? err.message : 'upload failed';
          continue;
        }
      }

      if (!gate) gate = await checkTextExtractability(placeholderPdf);

      // Already validated to exist above (whenever routingColumn is set) —
      // never undefined here for a row that reached this point.
      const nextTaskUid = body.routingColumn ? (body.routingRules ?? {})[String(row.rawRow[body.routingColumn] ?? '')] : undefined;

      run.phase = `completing ${rowLabel}`;
      // Same gate-outcome branching as acquisition.ts's step 4 — reject vs.
      // flag-and-continue is config.acquisitionGateMode (§13 #1, still unconfirmed).
      const statusResult = await tryUwbe(() =>
        gate!.isTextExtractable
          ? updateFileStatus({
              projectCode: body.projectCode,
              taskUid: row.taskUid!,
              fileId: row.registeredFileId!,
              previousFileStatus: 'I',
              fileStatus: 'C',
              // Merge row metadata on completion too — update_file_status merges this
              // into files.meta_data BEFORE routing evaluates it, so routing is
              // deterministic even for rows whose registration-time storage was
              // skipped (pre-fix or resumed). Handles the applicable
              // meta_data_expression edges (user_decides_next_task=0 tasks ignore nextTask).
              metaData: row.metaData,
              nextTask: nextTaskUid,
              userId: body.userId,
            })
          : config.acquisitionGateMode === 'reject'
            ? updateFileStatus({
                projectCode: body.projectCode,
                taskUid: row.taskUid!,
                fileId: row.registeredFileId!,
                previousFileStatus: 'I',
                fileStatus: 'O',
                onholdReason: 'Placeholder PDF failed the text-extractability gate (scanned/image-only).',
                userId: body.userId,
              })
            : updateFileStatus({
                projectCode: body.projectCode,
                taskUid: row.taskUid!,
                fileId: row.registeredFileId!,
                previousFileStatus: 'I',
                fileStatus: 'C',
                metaData: { acquisition_check: 'fail' },
                nextTask: nextTaskUid,
                userId: body.userId,
              }),
      );
      if (!statusResult.ok) {
        row.failed = true;
        row.error = statusResult.error ?? 'update-file-status failed';
        continue;
      }
      row.completed = true;
    }

    run.phase = 'done';
    res.json({
      ok: true,
      data: {
        total: run.plan.length,
        succeeded: run.plan.filter((r) => r.completed).length,
        failed: run.plan.filter((r) => r.failed).length,
        rows: run.plan.map((r) => ({
          rowIndex: r.rowIndex,
          fileName: r.fileName,
          fileId: r.registeredFileId,
          ok: r.completed,
          error: r.error,
        })),
      },
    });
  } finally {
    run.busy = false;
  }
});
