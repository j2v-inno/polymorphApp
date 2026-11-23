// Registers N sample Court Rules PDFs at Y23CP's ACQUISITION and completes them, as an operator would.
// Usage (from transapp/backend): npx tsx scripts/court-seed.ts [count=10] [projectCode=DEMO] [workflowCode=Y23CP]
import 'dotenv/config';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getAllTasks, registerJobBatchFile, updateFileStatus } from '../src/uwbe-client/endpoints.js';
import { putRawBytes } from '../src/uwbe-client/http.js';

const [count = '10', projectCode = 'DEMO', workflowCode = 'Y23CP'] = process.argv.slice(2);

const SAMPLES = [
  ['RULE 1.100 Pleadings and Motions', 'Amendment to subdivision (a) effective January 1, 2027.', 'The court may, on motion, strike any pleading that fails to comply.'],
  ['ADMINISTRATIVE ORDER NO. 26-14', 'In re: Remote appearances in civil proceedings.', 'Parties may appear by audio-video communication technology.'],
  ['RULE 2.505 Attorneys', 'Repealed rule 2.505(f) is withdrawn as of the date of this order.', 'Notice of appearance must include a primary e-mail address.'],
  ['RULE 3.220 Discovery', 'New rule adopted by the Supreme Court.', 'Within 15 days after the filing of a notice of discovery the prosecutor shall serve a written exhibit list.'],
];

async function samplePdf(i: number): Promise<Buffer> {
  const [heading, change, body] = SAMPLES[i % SAMPLES.length];
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage();
    const { height } = page.getSize();
    const lines = p === 0 ? [heading, change, body, `Sample document ${i + 1}.`] : [`RULE ${i + 4}.010 General Provisions`, body, `Page ${p + 1} of 2.`];
    lines.forEach((line, n) => page.drawText(line, { x: 50, y: height - 60 - n * 22, size: 12, font }));
  }
  // pdf-parse v1 cannot read compressed object streams (see pdf/dummy.ts).
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const tasks = await getAllTasks({ projectCode, workflowCode });
const first = tasks.data?.find((t) => t.code === 'ACQUISITION');
if (!tasks.ok || !first) throw new Error(`ACQUISITION not found in ${projectCode}/${workflowCode}: ${tasks.error ?? 'no such task'}`);

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
for (let i = 0; i < Number(count); i++) {
  const fileName = `court-rule-${stamp}-${String(i + 1).padStart(3, '0')}.pdf`;
  const reg = await registerJobBatchFile({
    projectCode,
    workflowCode,
    firstTaskUid: first.task_uid,
    fileName,
    filePath: fileName,
    fileUniqueIdentifier: fileName,
    metaData: { source: 'court-seed', jurisdiction: 'State Court Rules' },
  });
  if (!reg.ok || !reg.data) throw new Error(`register ${fileName}: ${reg.error}`);
  const bytes = await samplePdf(i);
  const fileId = reg.data.file_id;
  const base = { projectCode, taskUid: first.task_uid, fileId };
  if (reg.data.file_output_upload_url) {
    await putRawBytes(reg.data.file_output_upload_url, bytes);
    const done = await updateFileStatus({ ...base, previousFileStatus: 'I', fileStatus: 'C' });
    if (!done.ok) throw new Error(`complete ${fileName}: ${done.error}`);
  } else {
    // Local disk storage hands out no upload URL: send the PDF as the task output instead.
    const done = await updateFileStatus({ ...base, previousFileStatus: 'I', fileStatus: 'C', fileData: { bytes, fileName, contentType: 'application/pdf' } });
    if (!done.ok) throw new Error(`complete ${fileName}: ${done.error}`);
  }
  console.log(`registered + completed ${fileName} (file ${fileId})`);
}
