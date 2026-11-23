// Stands in for an operator at a Y23CP manual task: takes the next waiting file, keeps the reviewed input as
// the task output (as transapp's qualification screen does) and completes it. VERIFY_CLASSIFY confirms the
// suggested classification. For rehearsals and tests; the real demo uses the transapp screens.
// Usage (from transapp/backend): npx tsx scripts/court-operator.ts <TASK_CODE> [count=1] [projectCode=DEMO] [workflowCode=Y23CP]
import 'dotenv/config';
import { getAllTasks, getFileTaskStatus, getTaskNextFileWithStart, updateFileStatus } from '../src/uwbe-client/endpoints.js';
import { downloadFileTaskInput } from '../src/worker/uwbe.js';

const [taskCode, count = '1', projectCode = 'DEMO', workflowCode = 'Y23CP'] = process.argv.slice(2);
if (!taskCode) throw new Error('usage: court-operator.ts <TASK_CODE> [count]');
// Unset: claim as Orion's system user, the way the automated steps do. Set it to act as a real allocated operator.
const userId = process.env.OPERATOR_USER_ID ? Number(process.env.OPERATOR_USER_ID) : undefined;

const tasks = await getAllTasks({ projectCode, workflowCode });
const task = tasks.data?.find((t) => t.code === taskCode);
if (!task) throw new Error(`${taskCode} not found in ${projectCode}/${workflowCode}: ${tasks.error ?? 'no such task'}`);

// OPERATOR_FILE_IDS=1203,1204 finishes files already claimed at this task (e.g. left In progress by a crash).
const claimed = (process.env.OPERATOR_FILE_IDS ?? '').split(',').filter(Boolean).map(Number);
const total = claimed.length || Number(count);

for (let i = 0; i < total; i++) {
  let file: { id: number; file_name: string; meta_data: Record<string, unknown> | null };
  if (claimed.length) {
    const status = await getFileTaskStatus({ projectId: Number(task.project_id), taskId: task.id, fileId: claimed[i] });
    if (status.data?.file_task_status !== 'I') {
      console.log(`file ${claimed[i]} is not In progress at ${taskCode} (${status.data?.file_task_status ?? status.error})`);
      continue;
    }
    file = { id: claimed[i], file_name: `file ${claimed[i]}`, meta_data: (status.data?.meta_data as Record<string, unknown>) ?? null };
  } else {
    const next = await getTaskNextFileWithStart({ projectCode, taskUid: task.task_uid, fileId: undefined as unknown as number, userId });
    if (!next.ok || !next.data) {
      console.log(`no more files at ${taskCode}: ${next.error ?? 'none returned'}`);
      break;
    }
    file = next.data;
  }
  const input = await downloadFileTaskInput({
    project_code: projectCode,
    task_uid: task.task_uid,
    file_id: file.id,
  } as Parameters<typeof downloadFileTaskInput>[0]);
  const meta = file.meta_data ?? {};
  const metaData =
    taskCode === 'VERIFY_CLASSIFY'
      ? { ...(meta.classification ?? meta.suggested_classification ? { classification: meta.classification ?? meta.suggested_classification } : {}), verified_at: new Date().toISOString() }
      : { [`${taskCode.toLowerCase()}_reviewed_at`]: new Date().toISOString() };
  const done = await updateFileStatus({
    projectCode,
    taskUid: task.task_uid,
    fileId: file.id,
    previousFileStatus: 'I',
    fileStatus: 'C',
    metaData,
    userId,
    fileData: { bytes: input.bytes, fileName: input.fileName },
  });
  if (!done.ok) throw new Error(`complete file ${file.id}: ${done.error}`);
  console.log(`${taskCode}: completed file ${file.id} (${file.file_name})`);
}
