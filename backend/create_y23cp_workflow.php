<?php

// Builds the Y23CP Court Rules demo workflow in an existing Orion project.
//
//   ACQUISITION (M) → TEXT_EXTRACT (A) → VERIFY_CLASSIFY (M) → XML_MARKUP (A) → MARKUP_REVIEW (M)
//     → QA_BATCH (M, sampling batch) → QA_CLUSTER (C, auto QA cluster) → QA_AUDIT (Q) → TRANSMISSION (A)
//   + SAMPLING_REVIEW: register-type launcher for transapp's sample review screen (no edges).
//
// QA_BATCH holds files yet to start until Orion's sampling-batch scheduler cuts a batch (sampling batches v2).
// The reviewer works the batch's sampled files in transapp's sample review: approve completes the file at QA_BATCH,
// reject flows it back to MARKUP_REVIEW. Once every sample is approved, Orion releases the whole batch on.
//
// Every task's settings are written out here, so the target project needs nothing but its own row. Every edge
// is 'T' except QA_BATCH → QA_CLUSTER, which is 'TI': QA_BATCH produces no output, so QA_CLUSTER reads
// QA_BATCH's own input (the reviewed markup). The worker's TRANSMISSION reads MARKUP_REVIEW's output, since a task
// after a QA task gets no input file in Orion.
//
// Automated tasks publish to Y23CP_SQS_QUEUE_URL when given, otherwise to the BE's SQS_QUEUE_URL (nothing while it is
// empty). Give one when the BE's queue is shared with other apps, and point the transapp worker at the same queue.
// Re-running rebuilds this workflow only; it refuses to drop files unless Y23CP_PURGE=1.
// When the organization has its own database (a tenants row), everything is built inside that database.
//
// Run from be/ (all settings optional except the operators):
//   Y23CP_OPERATOR_IDS=1,7 php artisan tinker --execute="require '../transapp/backend/create_y23cp_workflow.php';"
//
//   Y23CP_ORG_CODE (DEFAULT) · Y23CP_PROJECT_CODE (DEMO) · Y23CP_WORKFLOW_CODE (Y23CP) · Y23CP_WEB_APP (transapp)
//   Y23CP_BATCH_SIZE (10) · Y23CP_SAMPLING_PCT (20) · Y23CP_CLUSTER_SIZE (5) · Y23CP_PURGE (0) · Y23CP_SQS_QUEUE_URL

use App\Model\SamplingBatchConfig;
use App\Model\Task;
use App\Model\Tenant;
use App\Model\Workflow;
use App\Services\SamplingBatch\SamplingBatchService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

$env = fn (string $key, string $default = '') => (string) (getenv($key) ?: $default);
$opts = [
    'org' => $env('Y23CP_ORG_CODE', 'DEFAULT'),
    'project' => $env('Y23CP_PROJECT_CODE', 'DEMO'),
    'workflow' => $env('Y23CP_WORKFLOW_CODE', 'Y23CP'),
    'web_app' => $env('Y23CP_WEB_APP', 'transapp'),
    'operators' => array_values(array_filter(array_map('intval', explode(',', $env('Y23CP_OPERATOR_IDS'))))),
    'batch_size' => (int) $env('Y23CP_BATCH_SIZE', '10'),
    'sampling_percentage' => (float) $env('Y23CP_SAMPLING_PCT', '20'),
    'cluster_size' => (int) $env('Y23CP_CLUSTER_SIZE', '5'),
    'purge' => $env('Y23CP_PURGE') === '1',
    // The automated tasks' own queue. Unset, they publish to the BE's default SQS_QUEUE_URL, which other apps may share.
    'sqs_queue_url' => $env('Y23CP_SQS_QUEUE_URL') ?: null,
];
if ($opts['operators'] === []) {
    throw new RuntimeException('Set Y23CP_OPERATOR_IDS to the Orion user ids who work the manual and QA tasks, e.g. 1,7.');
}

// The organization lives in the central database; its tenants row says whether its work has a database of its own.
$org = DB::table('organizations')->where('code', $opts['org'])->first();
if (! $org) {
    throw new RuntimeException("No organization with code '{$opts['org']}'.");
}
$tenant = Tenant::where('organization_id', $org->id)->first();
if ($tenant) {
    tenancy()->initialize($tenant);
}

try {
    $database = DB::connection()->getDatabaseName();
    $project = DB::table('projects')->where('code', $opts['project'])->first();
    if (! $project) {
        throw new RuntimeException("No project '{$opts['project']}' in database {$database}. Create it in Orion first.");
    }
    if ((int) $project->organization_id !== (int) $org->id) {
        throw new RuntimeException("Project {$project->code} belongs to organization {$project->organization_id}, not {$org->code} ({$org->id}).");
    }
    $webApp = DB::table('web_apps')->where('code', $opts['web_app'])->first();
    if (! $webApp) {
        throw new RuntimeException("No Web App '{$opts['web_app']}' in database {$database}. Register it on Orion's Web Apps page first.");
    }

    DB::transaction(function () use ($opts, $project, $webApp) {
        removeWorkflow($project->id, $opts['workflow'], $opts['purge']);

        $workflow = new Workflow;
        $workflow->project_id = $project->id;
        $workflow->code = $opts['workflow'];
        $workflow->name = 'Court Rules (Y23CP)';
        $workflow->workflow_order = (int) Workflow::where('project_id', $project->id)->max('workflow_order') + 1;
        $workflow->inactive = 0;
        $workflow->save();

        $screen = fn (string $key) => ['web_app' => ['code' => $webApp->code, 'mode' => 'spa', 'screen' => $key, 'finishes_file' => false]];
        $order = 0;
        $make = function (string $code, string $name, string $type, array $io, array $attrs = [], array $settings = []) use ($project, $workflow, &$order) {
            $task = new Task;
            foreach (array_merge([
                'project_id' => $project->id,
                'workflow_id' => $workflow->id,
                'task_uid' => (string) Str::uuid(),
                'task_order' => ++$order,
                'code' => $code,
                'name' => $name,
                'task_type' => $type,
                'inactive' => 0,
                'root_input_path' => strtolower($code).'_in',
                'root_output_path' => strtolower($code).'_out',
                'input_file_ext' => $io[0],
                'output_file_ext' => $io[1],
                'unit' => 'pg',
                'quota' => 0,
                'download_from_storage' => 1,
                'upload_to_storage' => 1,
                'user_should_upload_output' => 0,
                'user_decides_next_task' => 0,
                'combine_task_type' => 1,
                'task_process_level' => 'F',
                'start_next_file_option' => 'B',
                'external_app_integration' => null,
                'flow_back_options' => null,
                'task_setting_json' => array_replace_recursive(baseTaskSettings(), $settings),
            ], $attrs) as $key => $value) {
                $task->{$key} = $value;
            }
            $task->save();

            return $task;
        };
        $sqs = ['use_aws_sqs_as_task_queue' => 1, 'aws_sqs_queue_url' => $opts['sqs_queue_url']];

        $t = [];
        $t['ACQUISITION'] = $make('ACQUISITION', 'Acquisition', 'M', ['pdf', 'pdf'], [
            'unit' => 'P',
            'new_file_register_task' => 1,
            // transapp's acquisition screen registers each file with the next task chosen.
            'user_decides_next_task' => 1,
            'external_app_integration' => $screen('acquisition'),
            'meta_data_to_edit_in_processing_page' => json_encode(['mandatory' => [], 'optional' => []]),
        ]);
        $t['TEXT_EXTRACT'] = $make('TEXT_EXTRACT', 'Text Extraction', 'A', ['pdf', 'json'], [], $sqs);
        $t['VERIFY_CLASSIFY'] = $make('VERIFY_CLASSIFY', 'Updates Verification & Classification', 'M', ['json', 'json'], [
            'user_should_upload_output' => 1,
            'external_app_integration' => $screen('qualification'),
        ]);
        $t['XML_MARKUP'] = $make('XML_MARKUP', 'XML Mark Up', 'A', ['json', 'xml'], [], $sqs);
        $t['MARKUP_REVIEW'] = $make('MARKUP_REVIEW', 'Markup Review and Rework', 'M', ['xml', 'xml'], [
            'user_should_upload_output' => 1,
            'external_app_integration' => $screen('qualification'),
        ]);
        // Sampling batches need a task the system can route without a person: no user-picked next task, no older sampler.
        $t['QA_BATCH'] = $make('QA_BATCH', 'QA Batching (sampling)', 'M', ['xml', 'xml'], ['is_sampling_task' => 0]);
        // Task type C opens Orion's PM cluster list and Q its QA instance list; the worker cuts and packages clusters.
        $t['QA_CLUSTER'] = $make('QA_CLUSTER', 'QA Cluster Generation', 'C', ['xml', 'xml'], [
            'create_auto_qa_cluster' => 1,
            'show_cluster' => 1,
        ], $sqs + ['auto_create_cluster_condition' => ['condition_type' => 'FC', 'condition_value' => $opts['cluster_size']]]);
        $t['QA_AUDIT'] = $make('QA_AUDIT', 'QA Audit', 'Q', ['xml', 'xml']);
        $t['TRANSMISSION'] = $make('TRANSMISSION', 'Transmission', 'A', ['xml', 'zip'], ['last_task_for_sla' => 1], $sqs);

        $codes = array_keys($t);
        $edges = [];
        for ($i = 0; $i < count($codes) - 1; $i++) {
            $edges[] = [
                'task_id' => $t[$codes[$i]]->id,
                'next_task_id' => $t[$codes[$i + 1]]->id,
                'input_source' => $codes[$i] === 'QA_BATCH' ? 'TI' : 'T',
                'meta_data_expression' => null,
            ];
        }
        DB::table('task_next_tasks')->insert($edges);

        // A rejected sample goes back to MARKUP_REVIEW with MARKUP_REVIEW's own last output as its input.
        $t['QA_BATCH']->flow_back_options = ['flow_back_tasks' => [
            ['task_id' => $t['MARKUP_REVIEW']->id, 'input_source' => 'T', 'input_source_task_id' => $t['MARKUP_REVIEW']->id],
        ]];
        $t['QA_BATCH']->save();

        // A register-type task is the one way Orion opens a Web App without a file; with no edges no file lands here.
        $launcher = $make('SAMPLING_REVIEW', 'Sample Review', 'M', ['xml', 'xml'], [
            'new_file_register_task' => 1,
            'external_app_integration' => $screen('sampling-review'),
        ]);
        ensureWebAppScreen($webApp->code, 'sampling-review', 'Sample Review');

        $rows = [];
        foreach (['ACQUISITION', 'VERIFY_CLASSIFY', 'MARKUP_REVIEW', 'QA_BATCH', 'QA_CLUSTER', 'QA_AUDIT'] as $code) {
            foreach ($opts['operators'] as $userId) {
                $rows[] = ['user_id' => $userId, 'project_id' => $project->id, 'task_id' => $t[$code]->id, 'workflow_id' => $workflow->id, 'list_un_allocated_files' => 1];
            }
        }
        foreach ($opts['operators'] as $userId) {
            $rows[] = ['user_id' => $userId, 'project_id' => $project->id, 'task_id' => $launcher->id, 'workflow_id' => $workflow->id, 'list_un_allocated_files' => 1];
        }
        DB::table('user_task_allocation')->insert($rows);

        SamplingBatchConfig::create([
            'project_id' => $project->id,
            'workflow_id' => $workflow->id,
            'task_id' => $t['QA_BATCH']->id,
            'is_active' => 1,
            'batch_size' => $opts['batch_size'],
            'sampling_percentage' => $opts['sampling_percentage'],
            'rework_task_id' => $t['MARKUP_REVIEW']->id,
            'updated_by' => 1,
        ]);
        SamplingBatchService::forgetConfig($t['QA_BATCH']->id);
        Cache::forget('wf_'.$workflow->code);
        Cache::forget('proj_w_wf_'.$project->code);

        echo "{$workflow->code} workflow_id={$workflow->id} in project {$project->code} ({$project->id})"
            ." · batch {$opts['batch_size']} @ {$opts['sampling_percentage']}% · cluster {$opts['cluster_size']}"
            .' · queue '.($opts['sqs_queue_url'] ?? "the BE's default")."\n";
        foreach ($t + ['SAMPLING_REVIEW' => $launcher] as $code => $task) {
            printf("  %-16s %s  id=%-4d uid=%s\n", $code, $task->task_type, $task->id, $task->task_uid);
        }
    });

    echo "organization {$org->code} ({$org->id}) · database {$database}".($tenant ? " (tenant {$tenant->id})" : ' (shared)')."\n";
} finally {
    if ($tenant) {
        tenancy()->end();
    }
}

/** The settings every task starts from, as Orion's task form saves them. */
function baseTaskSettings(): array
{
    return [
        'use_aws_sqs_as_task_queue' => 0,
        'aws_sqs_queue_url' => null,
        'cluster_filter_option' => 0,
        'cluster_filter_tasks' => null,
        'cluster_enable_qa_team_selection' => 0,
        'cluster_imt_filter_option' => 0,
        'cluster_filter_imt_tasks' => null,
        'cluster_zip_files' => 0,
        'cluster_labels' => null,
        'enable_task_process_list_colouring' => 0,
        'task_process_list_colour_condition' => null,
        'qa_cluster_email_address' => null,
        'task_remarks_to_show_in_processing_page' => [],
        'auto_create_cluster_condition' => [
            'auto_cluster_level' => 'NA',
            'auto_cluster_label' => null,
            'condition_type' => null,
            'metadata_conditions' => null,
            'file_order' => null,
            'file_group_job' => 0,
            'file_group_priority' => 0,
        ],
        'job_compile_use_batch_compile_files' => 0,
        'qa_cluster_dynamic_name_change' => 0,
        'supporting_files_to_upload_by_app_launcher' => null,
        'imt_allocation_set_metadata' => [],
        'imt_allocation_set_metadata_optional' => [],
        'meta_data_in_imt_allocation_option' => '',
        'auto_task_file_order' => null,
    ];
}

/** Deletes the workflow and its tasks; its files, jobs, clusters and batches too, but only when purging. */
function removeWorkflow(int $projectId, string $code, bool $purge): void
{
    $existing = Workflow::where('project_id', $projectId)->where('code', $code)->first();
    if (! $existing) {
        return;
    }
    $ids = Task::where('workflow_id', $existing->id)->pluck('id');
    if (DB::table('file_tasks')->whereIn('task_id', $ids)->exists()) {
        if (! $purge) {
            throw new RuntimeException("{$code} already has files. Re-run with Y23CP_PURGE=1 to delete them (demo data only).");
        }
        $fileIds = DB::table('files')->where('workflow_id', $existing->id)->pluck('id');
        $jobIds = DB::table('jobs')->where('workflow_id', $existing->id)->pluck('id');
        $clusterIds = DB::table('qa_clusters')->where('workflow_id', $existing->id)->pluck('id');
        $batchIds = DB::table('sampling_batches')->where('workflow_id', $existing->id)->pluck('id');
        $delete = function (string $table, string $column, $values) {
            if (Schema::hasTable($table)) {
                DB::table($table)->whereIn($column, $values)->delete();
            }
        };
        foreach (['qa_cluster_files', 'qa_cluster_selected_files', 'qa_cluster_rework_completed_files', 'qa_cluster_instances'] as $table) {
            $delete($table, 'qa_cluster_id', $clusterIds);
        }
        $delete('qa_clusters', 'id', $clusterIds);
        $delete('sampling_batch_files', 'sampling_batch_id', $batchIds);
        $delete('sampling_batches', 'id', $batchIds);
        foreach (['file_task_users', 'file_tasks', 'file_logs', 'file_meta_data_audit', 'back_to_queue', 'batch_task_files',
            'batch_task_files_flow_backed', 'qa_cluster_qa_picked_files', 'qa_cluster_instance_rework_file_completed',
            'supporting_files', 'task_app_failures', 'file_task_output_replaces'] as $table) {
            $delete($table, 'file_id', $fileIds);
        }
        $delete('batch_tasks', 'job_id', $jobIds);
        $delete('files', 'id', $fileIds);
        $delete('batches', 'job_id', $jobIds);
        $delete('job_logs', 'job_id', $jobIds);
        $delete('jobs', 'id', $jobIds);
        echo "purged {$fileIds->count()} file(s), {$jobIds->count()} job(s) from {$code}\n";
    }
    DB::table('user_task_allocation')->where('workflow_id', $existing->id)->delete();
    // Orion caches workflows by code and tasks by id and uid; drop what pointed at the old rows.
    Cache::forget('wf_'.$code);
    Cache::forget('wf_id_'.$existing->id);
    foreach (Task::whereIn('id', $ids)->get(['id', 'task_uid']) as $old) {
        foreach (['task_id_'.$old->id, 'task_uid_'.$old->task_uid, 'task_uid_wn_'.$old->task_uid] as $key) {
            Cache::forget($key);
        }
        SamplingBatchService::forgetConfig($old->id);
    }
    DB::table('task_next_tasks')->whereIn('task_id', $ids)->delete();
    SamplingBatchConfig::whereIn('task_id', $ids)->delete();
    Task::whereIn('id', $ids)->delete();
    $existing->delete();
}

/** Adds a screen to a Web App's registry row if it is missing: Orion only launches declared screens. */
function ensureWebAppScreen(string $appCode, string $key, string $label): void
{
    $row = DB::table('web_apps')->where('code', $appCode)->first();
    $screens = json_decode($row->screens ?? '[]', true) ?: [];
    if (! collect($screens)->contains('key', $key)) {
        $screens[] = ['key' => $key, 'label' => $label];
        DB::table('web_apps')->where('code', $appCode)->update(['screens' => json_encode($screens)]);
    }
}
