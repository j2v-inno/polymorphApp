import { randomBytes } from 'node:crypto';
import express from 'express';

// Fake uw-be for local testing only. Canned envelopes for the 8 endpoints
// transapp/backend calls — no DB/Redis/S3, no real workflow engine.
//
// Shapes match the REAL controllers (TaskProcessController.php, FileController.php,
// TaskController.php in uw-be), verified 2026-08-12 — NOT the dev-context doc's §5
// table, which turned out wrong for 4 of its 5 "Style B" endpoints. Only
// flow-back-file-task is genuinely Style B; everything else here is Style A
// (`{success, code, data, message}`). Good enough to click through all four
// screens end-to-end; not a substitute for testing against a real uw-be instance
// before shipping.

const PORT = Number(process.env.MOCK_UWBE_PORT ?? 4200);
const BASE_URL = `http://localhost:${PORT}`;

const app = express();
app.use((req, _res, next) => {
  console.log(`[mock-uwbe] ${req.method} ${req.path}`);
  next();
});
// Excludes /mock-upload/:fileId — that route stands in for a presigned S3 PUT
// and must accept ANY content-type as raw bytes (its own express.raw below
// handles that). Without this exclusion, a PUT with Content-Type: application/
// json or application/xml (added by the Transformation task, which uploads
// its own JSON/XML output through this same endpoint — previously every
// caller here only ever uploaded PDFs) gets consumed by this global JSON
// parser first, leaving req.body as an already-parsed object instead of a
// Buffer by the time express.raw runs, which then throws trying to
// Buffer.from() a plain object.
app.use(express.json({ limit: '50mb', type: (req) => !req.path.startsWith('/mock-upload/') }));

const respond = (data, message = 'Operation completed successfully', code = 200) => ({
  success: true,
  code,
  data,
  message,
});

/** @type {Map<number, Buffer>} */
const filesById = new Map();
// Demo-only persistence so update-file-meta-data edits (custom qualification
// fields, chapter_title from a by-chapter split, etc.) are actually visible on
// the next fetch instead of silently vanishing — this mock has no real DB.
/** @type {Map<number, Record<string, unknown>>} */
const metaDataByFileId = new Map();
let nextFileId = 1000;
let nextTaskUidSuffix = 1;
const taskUid = () => `mock-task-uid-${nextTaskUidSuffix++}`;

// --- §6.1 /acquisition ------------------------------------------------------

app.post('/register-job-batch-file', (req, res) => {
  const fileId = nextFileId++;
  metaDataByFileId.set(fileId, req.body.meta_data ?? {});
  res.json(
    respond({
      file_id: fileId,
      project_id: req.body.project_id ?? 334,
      job_id: req.body.job_id ?? 87789,
      batch_id: req.body.batch_id ?? 557886,
      job_name: 'UF0001',
      batch_name: 'UF0001013',
      file_output_path: `acquisition_out/${fileId}.pdf`,
      file_s3_path: `s3://mock-bucket/acquisition_out/${fileId}.pdf`,
      file_output_upload_url: `${BASE_URL}/mock-upload/${fileId}`,
    }),
  );
});

// Not a uw-be envelope endpoint — stands in for the pre-signed S3 PUT target.
app.put('/mock-upload/:fileId', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
  filesById.set(Number(req.params.fileId), Buffer.from(req.body ?? []));
  res.sendStatus(200);
});

// Not a uw-be envelope endpoint — stands in for a short-lived S3 download URL.
app.get('/mock-download/:fileId', (req, res) => {
  const bytes = filesById.get(Number(req.params.fileId));
  if (!bytes) {
    res.status(404).send('file not found (was it ever uploaded/registered in this mock run?)');
    return;
  }
  res.set('Content-Type', 'application/pdf');
  res.send(bytes);
});

app.post('/update-file-status', (_req, res) => {
  // Real response: data is always null on success (TaskProcessController.php:2326).
  res.json(respond(null));
});

// --- §6.2 /qualification -----------------------------------------------------

app.get('/get-task-ongoing-file', (req, res) => {
  const fileId = Number(req.query.file_id);
  const metaData = { pages_with_errors: [], ...(metaDataByFileId.get(fileId) ?? {}) };
  res.json(
    respond({
      file: {
        file_id: fileId,
        file_name: `file-${fileId}.pdf`,
        download_url: `${BASE_URL}/mock-download/${fileId}`,
        s3_file_path: `s3://mock-bucket/qualification/${fileId}.pdf`,
        // Best-effort field — not directly confirmed against a live response.
        task_uid: taskUid(),
        // Edit to a non-empty array to exercise §6.3.1's manual-fix routing.
        meta_data: metaData,
      },
    }),
  );
});

// Not in the original endpoint set — added so the standalone/frontend
// qualification screen (which claims via get-task-next-file-with-start, not
// get-task-ongoing-file — see README's "real endpoint behavior" notes) has
// something to hit against this mock. Field names deliberately differ from
// get-task-ongoing-file's (input_download_url/s3_path, not download_url/
// s3_file_path) to match the real endpoints' documented naming mismatch.
app.post('/get-task-next-file-with-start', (req, res) => {
  const fileId = Number(req.body.file_id);
  const metaData = { pages_with_errors: [], ...(metaDataByFileId.get(fileId) ?? {}) };
  res.json(
    respond({
      file: {
        id: fileId,
        file_name: `file-${fileId}.pdf`,
        job_name: 'UF0001',
        batch_name: 'UF0001013',
        file_task_id: fileId,
        job_id: req.body.job_id ?? 87789,
        batch_id: req.body.batch_id ?? 557886,
        project_id: 334,
        task_id: 0,
        input_download_url: `${BASE_URL}/mock-download/${fileId}`,
        s3_path: `s3://mock-bucket/qualification/${fileId}.pdf`,
        meta_data: metaData,
      },
    }),
  );
});

app.post('/update-file-meta-data', (req, res) => {
  const fileId = Number(req.body.file_id);
  const existing = metaDataByFileId.get(fileId) ?? {};
  metaDataByFileId.set(fileId, { ...existing, ...(req.body.meta_data ?? {}) });
  // Real response: data is always null on success (TaskProcessController.php:2592-2596).
  res.json(respond(null, 'Success.'));
});

app.post('/flow-back-file-task', (_req, res) => {
  // The one genuinely Style B endpoint — always exactly {status, error}, nothing else.
  res.json({ status: true, error: '' });
});

// --- §6.3 /batch --------------------------------------------------------------

app.post('/register-file', (req, res) => {
  const fileId = nextFileId++;
  metaDataByFileId.set(fileId, req.body.meta_data ?? {});
  // Real endpoint requires start_task=true for this block to populate at all,
  // and file_data (if used) must be a real multipart file capped at ~375KB raw —
  // too small for realistic split chunks. transapp always uses the
  // register-then-PUT pattern instead (like acquisition), never file_data.
  res.json(
    respond({
      file_id: fileId,
      project_id: 334,
      job_id: req.body.job_id ?? 87789,
      batch_id: req.body.batch_id ?? 557886,
      file_output_path: `batch_out/${fileId}.pdf`,
      file_s3_path: `s3://mock-bucket/batch_out/${fileId}.pdf`,
      file_output_upload_url: `${BASE_URL}/mock-upload/${fileId}`,
    }),
  );
});

app.get('/get-all-tasks', (_req, res) => {
  // Bare array, not {tasks: [...]} — and the real column is `code`, not `task_code`.
  // Matches BATCH_SPLIT_DOWNLOAD_TASK_CODE / BATCH_SPLIT_MANUAL_FIX_TASK_CODE
  // defaults in backend/.env.example.
  res.json(
    respond([
      { id: 3759, task_uid: 'mock-qualification-task-uid', code: 'QUALIFICATION', task_order: 2 },
      { id: 3760, task_uid: 'mock-download-task-uid', code: 'DOWNLOAD', task_order: 4 },
      { id: 3761, task_uid: 'mock-manual-fix-task-uid', code: 'MANUAL_FIX', task_order: 5 },
      // New task (2026-08-15): by-chapter batch-split now routes to this instead
      // of QUALIFICATION directly — see README.md's "Transformation" section.
      { id: 3762, task_uid: 'mock-transformation-task-uid', code: 'TRANSFORMATION', task_order: 3 },
    ]),
  );
});

// --- §6.4 /download ------------------------------------------------------------

app.get('/get-file-task-output', (req, res) => {
  const fileId = Number(req.query.file_id);
  res.json(
    respond({
      file: {
        file_id: fileId,
        file_name: `file-${fileId}.pdf`,
        download_url: `${BASE_URL}/mock-download/${fileId}`,
        // Best-effort field name — not directly confirmed against a live response.
        file_status: 'C',
      },
    }),
  );
});

// --- Orion's app token: a stand-in for the issue and the exchange ------------
//
// Real Orion hands its page an app token (a random code), and an app's server
// exchanges it at GET /api/v1/webapp/contract/{ct} with its API token. This is
// that exchange with canned answers, so a server's token check can be tried
// without an Orion: accept the operator's own token, refuse one Orion does not
// know, one that expired, one issued for another Web App, and one whose
// operator no longer has the file.
//
// Every contract here says issuer "Orion self-test". A server set to trust one
// Orion (transapp: ORION_ISSUER) must refuse all of them: that is the proof a
// production server cannot be talked round by a test token.

const SELF_TEST_ISSUER = 'Orion self-test';
/** @type {Map<string, { contract: Record<string, unknown>, expiresAt: number, held: boolean }>} */
const contractsByCode = new Map();

const refuse = (res, status, code, message) =>
  res.status(status).json({ success: false, code: status, message, error: { code, message, retryable: false } });

// Stands in for Orion's own page asking for a token: Orion checks the
// operator's session there, and this checks nothing. Body, all optional:
// { user_id, login_id, display_name, project_id, project_code, task_id,
//   file_id (null for the register page), web_app, ttl (seconds) }.
app.post('/mock/app-token', (req, res) => {
  const b = req.body ?? {};
  const ttl = Number(b.ttl ?? 600);
  const fileId = b.file_id === undefined ? 1001 : b.file_id;
  const taskId = Number(b.task_id ?? 204);
  const projectId = Number(b.project_id ?? 334);
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttl * 1000;

  contractsByCode.set(token, {
    expiresAt,
    held: false,
    contract: {
      contract_version: '1.0',
      issuer: SELF_TEST_ISSUER,
      expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      organization_id: null,
      web_app: { code: b.web_app ?? 'transapp' },
      subject:
        fileId === null
          ? { type: 'task', id: taskId, project_id: projectId }
          : { type: 'file_task', id: 900000 + Number(fileId), project_id: projectId },
      context: {
        project: { id: projectId, code: b.project_code ?? 'MOCK' },
        workflow: { id: 19, code: 'MAINFLOW' },
        task: { id: taskId, code: 'QUALIFICATION', name: 'Qualification' },
        file: fileId === null ? null : { id: Number(fileId) },
      },
      actor: {
        user_id: Number(b.user_id ?? 1),
        login_id: b.login_id ?? 'selftest',
        display_name: b.display_name ?? 'Self Test',
      },
    },
  });

  res.json(respond({ token, expires_in: ttl }, 'App token issued'));
});

// Stands in for the operator putting the file on hold, completing it or
// sending it back: the token stays known, and the exchange answers 410.
app.post('/mock/app-token/:ct/hold', (req, res) => {
  const kept = contractsByCode.get(req.params.ct);
  if (!kept) return refuse(res, 404, 'unknown_code', 'The mock never issued this code.');
  kept.held = true;
  res.json(respond(null, 'Held'));
});

// The exchange itself, at Orion's own address under UWBE_BASE_URL.
app.get('/v1/webapp/contract/:ct', (req, res) => {
  if (!req.header('api-token')) {
    return res.status(401).json({ success: false, code: 401, message: 'Unauthorized', data: null });
  }
  const kept = contractsByCode.get(req.params.ct);
  if (!kept || kept.expiresAt <= Date.now()) {
    contractsByCode.delete(req.params.ct);
    return refuse(res, 404, 'unknown_code', 'Orion does not know this code. It was never issued, or it has expired.');
  }
  if (kept.held) {
    return refuse(res, 410, 'file_not_yours', 'The operator no longer has this file in process at this task.');
  }
  res.set('Cache-Control', 'no-store').json(respond(kept.contract, 'Web App contract'));
});

app.listen(PORT, () => {
  console.log(`mock-uwbe listening on :${PORT} — point backend/.env's UWBE_BASE_URL at ${BASE_URL}/`);
});
