// Creates a second workflow (CHAPTERFLOW) under the same TRANSAPPTEST project
// (project_id 2) as MAINFLOW, for testing transapp's by-chapter batch-split
// method against real uw-be — a new workflow rather than editing MAINFLOW's
// tasks in place, so the original register->qualify->batch->download flow
// stays untouched. Task field values cloned from MAINFLOW's 4 tasks (fetched
// via tinker), except: new task_uids, task_order reflects the new order
// (ACQUISITION -> BATCH_SPLIT -> QUALIFICATION -> DOWNLOAD), and QUALIFICATION
// gets upload_to_storage=1 (MAINFLOW's QUALIFICATION has it 0 — never needed
// it there since files only ever arrived via DAG advancement; CHAPTERFLOW's
// batch-split registers new chapter files directly onto QUALIFICATION via
// register-file, which needs this flag set to get a presigned upload URL).
//
// Uses direct property assignment + save(), not create(), since these models'
// $fillable lists don't cover every column (create()'s mass-assignment guard
// rejects e.g. project_id on Workflow) — same pattern wire_tasks.php uses.

// Idempotent — safe to re-run while iterating on this script.
$existing = \App\Model\Workflow::where('project_id', 2)->where('code', 'CHAPTERFLOW')->first();
if ($existing) {
    \Illuminate\Support\Facades\DB::table('task_next_tasks')
        ->whereIn('task_id', \App\Model\Task::where('workflow_id', $existing->id)->pluck('id'))
        ->delete();
    \App\Model\Task::where('workflow_id', $existing->id)->delete();
    $existing->delete();
}

$mainflow = \App\Model\Workflow::where('project_id', 2)->where('code', 'MAINFLOW')->first();

$workflow = new \App\Model\Workflow();
$workflow->project_id = 2;
$workflow->code = 'CHAPTERFLOW';
$workflow->name = 'Chapter Flow';
$workflow->workflow_order = 2;
$workflow->inactive = 0;
$workflow->save();

$externalAppConfig = ['web_app' => ['url' => 'http://localhost:9100/', 'token' => null, 'time_based_token' => false, 'task_complete_by_api' => false, 'send_iatoken' => false]];

function cloneTaskFields($sourceTask) {
    // toArray() includes some appended/computed attributes that aren't real
    // columns (e.g. multiple_files_count_select_files on this schema) — only
    // keep keys that are actual `tasks` table columns.
    static $columns = null;
    if ($columns === null) {
        $columns = \Illuminate\Support\Facades\Schema::getColumnListing('tasks');
    }
    $attrs = array_intersect_key($sourceTask->toArray(), array_flip($columns));
    unset($attrs['id'], $attrs['created_at'], $attrs['updated_at'], $attrs['task_uid']);
    return $attrs;
}

function makeTask($fields) {
    $task = new \App\Model\Task();
    foreach ($fields as $key => $value) {
        $task->{$key} = $value;
    }
    $task->save();
    return $task;
}

$sourceAcq = \App\Model\Task::where('project_id', 2)->where('workflow_id', $mainflow->id)->where('code', 'ACQUISITION')->first();
$sourceQual = \App\Model\Task::where('project_id', 2)->where('workflow_id', $mainflow->id)->where('code', 'QUALIFICATION')->first();
$sourceSplit = \App\Model\Task::where('project_id', 2)->where('workflow_id', $mainflow->id)->where('code', 'BATCH_SPLIT')->first();
$sourceDl = \App\Model\Task::where('project_id', 2)->where('workflow_id', $mainflow->id)->where('code', 'DOWNLOAD')->first();

$acq = makeTask(array_merge(cloneTaskFields($sourceAcq), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 1,
    'external_app_integration' => $externalAppConfig,
    'new_file_register_task' => 1,
]));

$split = makeTask(array_merge(cloneTaskFields($sourceSplit), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 2,
    'external_app_integration' => $externalAppConfig,
]));

$qual = makeTask(array_merge(cloneTaskFields($sourceQual), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 3,
    'external_app_integration' => $externalAppConfig,
    'upload_to_storage' => 1, // the key fix — see header comment
]));

$dl = makeTask(array_merge(cloneTaskFields($sourceDl), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 4,
    'external_app_integration' => $externalAppConfig,
]));

\Illuminate\Support\Facades\DB::table('task_next_tasks')->insert([
    ['task_id' => $acq->id, 'next_task_id' => $split->id, 'input_source' => 'out'],
    ['task_id' => $split->id, 'next_task_id' => $qual->id, 'input_source' => 'out'],
    ['task_id' => $qual->id, 'next_task_id' => $dl->id, 'input_source' => 'out'],
]);

echo "CHAPTERFLOW created: workflow_id={$workflow->id}\n";
echo "ACQUISITION task_uid={$acq->task_uid}\n";
echo "BATCH_SPLIT  task_uid={$split->task_uid}\n";
echo "QUALIFICATION task_uid={$qual->task_uid} upload_to_storage={$qual->upload_to_storage}\n";
echo "DOWNLOAD    task_uid={$dl->task_uid}\n";
