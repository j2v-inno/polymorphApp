// Creates a THIRD workflow (RAGFLOW) under the same TRANSAPPTEST project
// (project_id 2) as MAINFLOW and CHAPTERFLOW, for testing transapp's new
// Transformation task (PDF text -> XML/JSON, brought in-house 2026-08-15 —
// see README.md's "Transformation" section) against real uw-be. A new
// workflow, not an edit to CHAPTERFLOW in place, so CHAPTERFLOW's own
// already-verified register->batch(by-chapter)->qualify->download flow stays
// untouched — both existing workflows are already stood up in this Orion
// project and shouldn't be touched by this script.
//
// Cloned from CHAPTERFLOW's 4 tasks (not MAINFLOW's) since RAGFLOW is really
// "CHAPTERFLOW plus a Transformation step inserted before Qualification" —
// CHAPTERFLOW's BATCH_SPLIT is already the proven by-chapter-capable task,
// and its QUALIFICATION already has upload_to_storage=1 set (still needed
// here — see below).
//
// New order: ACQUISITION -> BATCH_SPLIT -> TRANSFORMATION -> QUALIFICATION -> DOWNLOAD.
// TRANSFORMATION has no CHAPTERFLOW/MAINFLOW source task to clone (it doesn't
// exist in either yet) — cloned from QUALIFICATION's fields instead (closest
// analog: a single-file screen task an operator opens, acts on, and
// completes) with `code`/`name` explicitly overridden, unlike the other four
// clones below which keep their source's own code/name verbatim.
//
// Both TRANSFORMATION and QUALIFICATION need upload_to_storage=1: batch-split
// now registers new chapter files directly onto TRANSFORMATION via
// register-file (needs the flag to get a presigned upload URL), and
// TRANSFORMATION's own completion registers its XML/JSON output directly onto
// QUALIFICATION the same way — both are targets of an explicit register-file
// call, not DAG advancement, so both need the flag.
//
// Uses direct property assignment + save(), not create(), since these models'
// $fillable lists don't cover every column (create()'s mass-assignment guard
// rejects e.g. project_id on Workflow) — same pattern create_chapterflow_workflow.php uses.

// Idempotent — safe to re-run while iterating on this script. Only ever
// touches RAGFLOW's own rows, never MAINFLOW's or CHAPTERFLOW's.
$existing = \App\Model\Workflow::where('project_id', 2)->where('code', 'RAGFLOW')->first();
if ($existing) {
    \Illuminate\Support\Facades\DB::table('task_next_tasks')
        ->whereIn('task_id', \App\Model\Task::where('workflow_id', $existing->id)->pluck('id'))
        ->delete();
    \App\Model\Task::where('workflow_id', $existing->id)->delete();
    $existing->delete();
}

$chapterflow = \App\Model\Workflow::where('project_id', 2)->where('code', 'CHAPTERFLOW')->first();

$workflow = new \App\Model\Workflow();
$workflow->project_id = 2;
$workflow->code = 'RAGFLOW';
$workflow->name = 'RAG Flow';
$workflow->workflow_order = 3;
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

$sourceAcq = \App\Model\Task::where('project_id', 2)->where('workflow_id', $chapterflow->id)->where('code', 'ACQUISITION')->first();
$sourceSplit = \App\Model\Task::where('project_id', 2)->where('workflow_id', $chapterflow->id)->where('code', 'BATCH_SPLIT')->first();
$sourceQual = \App\Model\Task::where('project_id', 2)->where('workflow_id', $chapterflow->id)->where('code', 'QUALIFICATION')->first();
$sourceDl = \App\Model\Task::where('project_id', 2)->where('workflow_id', $chapterflow->id)->where('code', 'DOWNLOAD')->first();

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

$transform = makeTask(array_merge(cloneTaskFields($sourceQual), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 3,
    'code' => 'TRANSFORMATION',
    'name' => 'Transformation',
    'external_app_integration' => $externalAppConfig,
    'upload_to_storage' => 1, // batch-split registers chapter files directly onto this task
    // Cloned from QUALIFICATION, which has this 0 in every existing workflow
    // (MAINFLOW/CHAPTERFLOW too) — never fixed there since those either never
    // needed to resolve a self-registered file's bytes, or the gap was simply
    // never chased down (see README.md's now-resolved "known gap" note).
    // Genuinely required here: without it, get_task_next_file_with_start's
    // entire input_download_url resolution block is skipped outright — no
    // fallback, self-registered path scheme, or task-code check ever runs, so
    // Transformation can never fetch its own input chapter's bytes.
    'download_from_storage' => 1,
]));

$qual = makeTask(array_merge(cloneTaskFields($sourceQual), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 4,
    'external_app_integration' => $externalAppConfig,
    'upload_to_storage' => 1, // transformation registers its XML/JSON output directly onto this task
    // Same reasoning as TRANSFORMATION above — without this, qualification's
    // structured-content viewer (and PDF preview, for that matter) can never
    // resolve input_download_url/download_url for a file that landed here via
    // a direct register-file call rather than DAG advancement.
    'download_from_storage' => 1,
]));

$dl = makeTask(array_merge(cloneTaskFields($sourceDl), [
    'workflow_id' => $workflow->id,
    'task_uid' => (string) \Illuminate\Support\Str::uuid(),
    'task_order' => 5,
    'external_app_integration' => $externalAppConfig,
    // Needed for get-file-task-output to resolve a download link for files
    // that reach here via qualification's normal (audited, DAG) completion —
    // not a register-file path, but still gated by the same flag.
    'download_from_storage' => 1,
]));

// BATCH_SPLIT and TRANSFORMATION are both deliberately NOT wired to a next
// task — same reasoning CHAPTERFLOW's own script documents: each is a
// fan-out/hand-off point where transapp's backend already advances the file
// itself via an explicit register-file call (batch-split.ts per chapter,
// transformation.ts for its own output), so a task_next_tasks edge here would
// make uw-be's DAG engine ALSO auto-advance the original (already-handled)
// file forward — producing a second, broken "ghost" file at the next task
// with no real content and no S3 bytes anywhere it could resolve from.
//
// input_source values are 'T'/'TI'/'O'/'OI' (not 'out' — that's not a valid
// value; use the literal task_uid-based codes uw-be expects).
\Illuminate\Support\Facades\DB::table('task_next_tasks')->insert([
    ['task_id' => $acq->id, 'next_task_id' => $split->id, 'input_source' => 'T'],
    ['task_id' => $qual->id, 'next_task_id' => $dl->id, 'input_source' => 'T'],
]);

echo "RAGFLOW created: workflow_id={$workflow->id}\n";
echo "ACQUISITION   task_uid={$acq->task_uid}\n";
echo "BATCH_SPLIT   task_uid={$split->task_uid}\n";
echo "TRANSFORMATION task_uid={$transform->task_uid} upload_to_storage={$transform->upload_to_storage}\n";
echo "QUALIFICATION task_uid={$qual->task_uid} upload_to_storage={$qual->upload_to_storage}\n";
echo "DOWNLOAD      task_uid={$dl->task_uid}\n";
