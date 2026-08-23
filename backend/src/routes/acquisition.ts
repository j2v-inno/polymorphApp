import { Router } from 'express';
import multer from 'multer';
import { registerJobBatchFile, updateFileStatus } from '../uwbe-client/endpoints.js';
import { putRawBytes } from '../uwbe-client/http.js';
import { checkTextExtractability } from '../pdf/text-extractable.js';
import { config } from '../config.js';
import { withUniqueSuffix } from '../lib/unique-filename.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

export const acquisitionRouter = Router();

/** §6.1 — register, gate-check text-extractability, upload, complete. One call from the browser. */
acquisitionRouter.post('/register-and-upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ ok: false, error: 'multipart field "file" is required' });
    return;
  }

  const { projectCode, workflowCode, firstTaskUid, fileName: rawFileName, fileUniqueIdentifier } = req.body as Record<string, string>;
  if (!projectCode || !workflowCode || !firstTaskUid || !rawFileName || !fileUniqueIdentifier) {
    res.status(400).json({
      ok: false,
      error: 'projectCode, workflowCode, firstTaskUid, fileName, and fileUniqueIdentifier are required',
    });
    return;
  }
  const fileName = withUniqueSuffix(rawFileName);

  // 1. Register
  const registerResult = await registerJobBatchFile({
    projectCode,
    workflowCode,
    firstTaskUid,
    fileName,
    filePath: fileName,
    fileUniqueIdentifier,
  });
  if (!registerResult.ok || !registerResult.data) {
    res.status(502).json({ ok: false, error: registerResult.error ?? 'register-job-batch-file failed' });
    return;
  }
  const { file_id: fileId, file_output_upload_url: uploadUrl } = registerResult.data;
  if (!uploadUrl) {
    res.status(502).json({
      ok: false,
      error: 'register-job-batch-file returned no upload URL — check this task\'s upload_to_storage flag',
    });
    return;
  }
  // The registration response doesn't return a task_uid — the file simply now
  // sits at whichever task you registered it against (verified: uw-be's
  // register-job-batch-file response has no task_uid field).
  const taskUid = firstTaskUid;

  // 2. Gate: text-extractable PDF only (§6.1)
  const gate = await checkTextExtractability(file.buffer);

  // 3. Upload regardless of gate outcome — a human still needs the file to review
  // it on the on-hold/flagged path.
  try {
    await putRawBytes(uploadUrl, file.buffer, file.mimetype || 'application/pdf');
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'upload failed' });
    return;
  }

  // 4. Complete. Behavior on gate failure is an open blocker (§13 #1, owner: Bhanu:
  // reject vs. flag-and-continue). Config-driven so switching is one env var, not a
  // code change, once that's decided.
  const statusResult = gate.isTextExtractable
    ? await updateFileStatus({ projectCode, taskUid, fileId, previousFileStatus: 'I', fileStatus: 'C' })
    : config.acquisitionGateMode === 'reject'
      ? await updateFileStatus({
          projectCode,
          taskUid,
          fileId,
          previousFileStatus: 'I',
          fileStatus: 'O',
          onholdReason: 'PDF failed the text-extractability gate (scanned/image-only)',
        })
      : await updateFileStatus({
          projectCode,
          taskUid,
          fileId,
          previousFileStatus: 'I',
          fileStatus: 'C',
          metaData: { acquisition_check: 'fail' },
        });

  if (!statusResult.ok) {
    res.status(502).json({ ok: false, error: statusResult.error ?? 'update-file-status failed' });
    return;
  }

  res.json({ ok: true, data: { fileId, taskUid, gate, gateMode: config.acquisitionGateMode } });
});
