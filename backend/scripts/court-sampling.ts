// Inspects and drives Y23CP's sampling batches at QA_BATCH through Orion's API. Reviewing a sample happens in
// transapp's sample review screen (routes/sampling-review.ts), which this script does not replace.
// Usage (from transapp/backend), optionally COURT_PROJECT_CODE / COURT_WORKFLOW_CODE:
//   npx tsx scripts/court-sampling.ts list | create | release
import 'dotenv/config';
import { callUwbe } from '../src/uwbe-client/http.js';
import { getAllTasks } from '../src/uwbe-client/endpoints.js';

const projectCode = process.env.COURT_PROJECT_CODE ?? 'DEMO';
const workflowCode = process.env.COURT_WORKFLOW_CODE ?? 'Y23CP';
const [command] = process.argv.slice(2);

const tasks = await getAllTasks({ projectCode, workflowCode });
const task = tasks.data?.find((t) => t.code === 'QA_BATCH');
if (!task) throw new Error(`QA_BATCH not found: ${tasks.error ?? 'no such task'}`);
const scope = { project_code: projectCode, workflow_code: workflowCode, task_uid: task.task_uid };

type Batch = { uid: string; status: string; reviewer: string | null; file_count: number; ready_for_release: boolean };
type BatchFile = { file_id: number; file_status: string | null; is_sampled: boolean; review_status: string | null };

if (command === 'list') {
  const res = await callUwbe<{ batches: Batch[] }>('sampling-batches', { method: 'GET', query: scope, styleKey: 'sampling-batches/run' });
  if (!res.ok) throw new Error(res.error ?? 'list failed');
  for (const b of res.data?.batches ?? []) {
    const detail = await callUwbe<{ files: BatchFile[] }>(`sampling-batches/${b.uid}`, { method: 'GET', query: { project_code: projectCode }, styleKey: 'sampling-batches/run' });
    const sampled = (detail.data?.files ?? []).filter((f) => f.is_sampled).map((f) => `${f.file_id}:${f.review_status}/${f.file_status}`);
    console.log(`${b.uid} ${b.status} reviewer=${b.reviewer ?? '-'} files=${b.file_count} sampled=[${sampled.join(', ')}] ready=${b.ready_for_release}`);
  }
} else if (command === 'create' || command === 'release') {
  const res = await callUwbe('sampling-batches/run', { method: 'POST', body: { ...scope, step: command } });
  console.log(JSON.stringify(res.ok ? res.data : res.error, null, 2));
} else {
  throw new Error('usage: list | create | release');
}
