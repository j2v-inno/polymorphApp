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
// The answer has every part of Orion's contract version 1.0 (the Orion
// backend's docs/api/webapp-contract.md and webapp-contract.v1.0.schema.json):
// the task's settings, the file with a download link, the quota, and the two
// addresses to call next, which answer here too. Every value is canned, and
// the one "secret" among the settings is not a secret.
//
// Every contract here says issuer "Orion self-test". A server set to trust one
// Orion (transapp: ORION_ISSUER) must refuse all of them: that is the proof a
// production server cannot be talked round by a test token.

const SELF_TEST_ISSUER = 'Orion self-test';
// Real Orion: its own address + /api/v1. Every address in `actions` starts here.
const API_BASE_URL = `${BASE_URL}/v1`;
// Seconds a real download link lives (Orion's CONTRACT_DOWNLOAD_URL_TTL).
const DOWNLOAD_URL_TTL = 120;
// The statuses a file has at a task while its operator may work on it: In
// Progress and Pending. Orion's own rule for "still has the file".
const IN_PROCESS = ['I', 'P'];

/** @type {Map<string, { contract: Record<string, any>, expiresAt: number, held: boolean }>} */
const contractsByCode = new Map();

// Where each file stands at its task: who has it, and its status there. A
// code issued for a file puts it In Progress with that operator; "hold" and
// "complete" move it on, and every code for that file is refused from then.
/** @type {Map<number, { id: number, project_id: number, task_id: number, file_id: number, handled_by: number, file_task_status: string }>} */
const fileTasksById = new Map();
const fileTaskId = (fileId) => 900000 + Number(fileId);

// What a contract's file is when this mock run uploaded nothing for it.
const CANNED_INPUT = Buffer.from('Orion self-test: a canned input file.\n');

const instant = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const refuse = (res, status, code, message) =>
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .json({ success: false, code: status, message, error: { code, message, retryable: false } });

// Orion answers a bare 401 to a call with no API token, before anything else.
// The mock checks only that one was sent, not which.
const needsApiToken = (req, res, next) => {
  if (req.header('api-token')) return next();
  res.status(401).json({ success: false, code: 401, message: 'Unauthorized', data: null });
};

const downloadLink = (fileId) => ({
  download_url: `${BASE_URL}/mock/input-file/${fileId}`,
  expires_at: instant(Date.now() + DOWNLOAD_URL_TTL * 1000),
});

// Stands in for Orion's own page asking for a token: Orion checks the
// operator's session there, and this checks nothing. Body, all optional:
// { user_id, login_id, display_name, project_id, project_code, task_id,
//   file_id (null for the register page), web_app, screen, ttl (seconds) }.
//
// The launch code on a `tab` link is the same kind of code, exchanged at the
// same address: a token made here stands in for one, as ?ct=<token> on the
// standalone page (pass "ttl": 3600 for Orion's hour, and a "screen").
app.post('/mock/app-token', (req, res) => {
  const b = req.body ?? {};
  const ttl = Number(b.ttl ?? 600);
  const fileId = b.file_id === null ? null : Number(b.file_id ?? 1001);
  const taskId = Number(b.task_id ?? 204);
  const projectId = Number(b.project_id ?? 334);
  const userId = Number(b.user_id ?? 1);
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttl * 1000;

  if (fileId !== null) {
    fileTasksById.set(fileTaskId(fileId), {
      id: fileTaskId(fileId),
      project_id: projectId,
      task_id: taskId,
      file_id: fileId,
      handled_by: userId,
      file_task_status: 'I',
    });
  }

  contractsByCode.set(token, {
    expiresAt,
    held: false,
    // As Orion keeps it: everything but `inputs`, which the exchange adds.
    contract: {
      contract_version: '1.0',
      issuer: SELF_TEST_ISSUER,
      expires_at: instant(expiresAt),
      organization_id: null,
      api_base_url: API_BASE_URL,
      web_app: { code: b.web_app ?? 'transapp', screen: b.screen ?? null },
      subject:
        fileId === null
          ? { type: 'task', id: taskId, project_id: projectId, process_level: 'F' }
          : { type: 'file_task', id: fileTaskId(fileId), project_id: projectId, process_level: 'F' },
      context: {
        project: { id: projectId, code: b.project_code ?? 'MOCK' },
        workflow: { id: 19, code: 'MAINFLOW' },
        task: { id: taskId, uid: b.task_uid ?? `mock-task-${taskId}`, code: 'QUALIFICATION', name: 'Qualification', type: 'M' },
        job: fileId === null ? null : { id: 87789 },
        batch: fileId === null ? null : { id: 557886, label: 'UF0001013' },
        file: fileId === null ? null : { id: fileId },
      },
      actor: {
        user_id: userId,
        login_id: b.login_id ?? 'selftest',
        display_name: b.display_name ?? 'Self Test',
      },
      // Text or null, as Orion stores them. `api_key` stands in for a secret
      // setting, which real Orion decrypts at the exchange.
      parameters: { markup_profile: 'strict', max_passes: '2', api_key: 'self-test-not-a-secret' },
      constraints: { quota: { unit: 'P', limit: 40 }, due_at: null },
      // Full addresses, each with project_id in its query, used as given.
      actions:
        fileId === null
          ? {}
          : {
              download_url: {
                method: 'GET',
                href: `${API_BASE_URL}/files/${fileId}/download-url?project_id=${projectId}&task_id=${taskId}`,
              },
              complete: {
                method: 'POST',
                href: `${API_BASE_URL}/file-tasks/${fileTaskId(fileId)}/complete?project_id=${projectId}`,
              },
            },
    },
  });

  res.json(respond({ token, expires_in: ttl }, 'App token issued'));
});

// Stands in for the operator putting the file on hold (completing it or
// sending it back ends the same way): the code stays known, and the exchange
// answers 410. It works on a code that has expired too, so a server that
// asks about the file after the code's hour (get-file-task-status, below)
// can be tried. For a code with no file it stands in for the operator being
// taken off the task.
app.post('/mock/app-token/:ct/hold', (req, res) => {
  const kept = contractsByCode.get(req.params.ct);
  if (!kept) return refuse(res, 404, 'unknown_code', 'The mock never issued this code.');
  kept.held = true;
  const file = kept.contract.context.file;
  const fileTask = file ? fileTasksById.get(fileTaskId(file.id)) : undefined;
  if (fileTask) fileTask.file_task_status = 'O';
  res.json(respond(null, 'Held'));
});

// The exchange itself, at Orion's own address under UWBE_BASE_URL.
app.get('/v1/webapp/contract/:ct', needsApiToken, (req, res) => {
  const kept = contractsByCode.get(req.params.ct);
  if (!kept || kept.expiresAt <= Date.now()) {
    return refuse(res, 404, 'unknown_code', 'Orion does not know this code. It was never issued, or it has expired.');
  }

  const { context, actor } = kept.contract;
  if (!context.file) {
    if (kept.held) return refuse(res, 410, 'cannot_register', 'The operator can no longer register files at this task.');
    return res.set('Cache-Control', 'no-store').json(respond({ ...kept.contract, inputs: [] }, 'Web App contract'));
  }

  // Read now, never from the code: what was true when it was made may not be.
  const fileTask = fileTasksById.get(fileTaskId(context.file.id));
  if (!fileTask || fileTask.handled_by !== actor.user_id || !IN_PROCESS.includes(fileTask.file_task_status)) {
    return refuse(res, 410, 'file_not_yours', 'The operator no longer has this file in process at this task.');
  }

  // The file and its download link are made by the exchange, as in Orion.
  const uploaded = filesById.get(context.file.id);
  const inputs = [
    {
      file_id: context.file.id,
      name: uploaded ? `file-${context.file.id}.pdf` : `file-${context.file.id}.txt`,
      mime: uploaded ? 'application/pdf' : 'text/plain',
      bytes: (uploaded ?? CANNED_INPUT).length,
      ...downloadLink(context.file.id),
    },
  ];
  res.set('Cache-Control', 'no-store').json(respond({ ...kept.contract, inputs }, 'Web App contract'));
});

// Not an Orion address: where a contract's download link points, in place of
// a signed storage link. Serves what this mock run uploaded for the file, or
// a line of canned text. Unlike a real link it never stops working.
app.get('/mock/input-file/:fileId', (req, res) => {
  const uploaded = filesById.get(Number(req.params.fileId));
  res.set('Content-Type', uploaded ? 'application/pdf' : 'text/plain').send(uploaded ?? CANNED_INPUT);
});

// `actions.download_url`: a fresh link, for when the one in `inputs` has run out.
app.get('/v1/files/:file/download-url', needsApiToken, (req, res) => {
  const fileTask = fileTasksById.get(fileTaskId(req.params.file));
  if (!fileTask || String(fileTask.task_id) !== String(req.query.task_id) || String(fileTask.project_id) !== String(req.query.project_id)) {
    return refuse(res, 404, 'file_not_found', 'This file is not at that task, or nothing is stored for it.');
  }
  res.set('Cache-Control', 'no-store').json(respond(downloadLink(fileTask.file_id), 'Download link'));
});

// `actions.complete`: finishes the file at the task, recorded for whoever has
// it. The answer is update-file-status's own. From here the file is no longer
// the operator's, so the exchange and the look-up below both say so.
app.post('/v1/file-tasks/:fileTask/complete', needsApiToken, (req, res) => {
  const fileTask = fileTasksById.get(Number(req.params.fileTask));
  if (!fileTask || String(fileTask.project_id) !== String(req.query.project_id)) {
    return refuse(res, 404, 'file_task_not_found', 'This file is no longer at that task.');
  }
  fileTask.file_task_status = 'C';
  res.json(respond(null));
});

// Orion's look-up of where a file stands at a task (routes/api.php,
// get-file-task-status), cut down to what a `tab` app's server reads once its
// launch code has expired: who has the file, and its status at the task.
// Both stay as they were after a hold or a completion; only the status moves.
app.get('/get-file-task-status', needsApiToken, (req, res) => {
  const fileTask = fileTasksById.get(fileTaskId(req.query.file_id));
  if (!fileTask || String(fileTask.task_id) !== String(req.query.task_id) || String(fileTask.project_id) !== String(req.query.project_id)) {
    return res.status(404).json({ success: false, code: 404, data: null, message: 'File task not found.' });
  }
  res.json(
    respond(
      {
        file: {
          id: fileTask.file_id,
          file_id: fileTask.file_id,
          file_name: `file-${fileTask.file_id}.pdf`,
          file_task_id: fileTask.id,
          project_id: fileTask.project_id,
          task_id: fileTask.task_id,
          file_task_status: fileTask.file_task_status,
          handled_by: fileTask.handled_by,
          user_id: fileTask.handled_by,
        },
      },
      'File retrieved successfully',
    ),
  );
});

app.listen(PORT, () => {
  console.log(`mock-uwbe listening on :${PORT} — point backend/.env's UWBE_BASE_URL at ${BASE_URL}/`);
});
