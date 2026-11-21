import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callUwbe, putRawBytes } from '../../uwbe-client/http.js';
import { workerConfig } from '../config.js';
import type { FileTaskMessage } from '../payload.js';
import { createQaClusterAutomatically, downloadFileTaskInput } from '../uwbe.js';
import { buildZip } from '../zip.js';
import type { Handler } from './types.js';

interface ClusterFile {
  file_id: number;
  file_name: string;
}

interface ClusterInstance {
  cluster_instance_id: number;
  cluster_name: string;
  cluster_files: ClusterFile[];
}

/**
 * Packages every cluster Orion has cut at this task: zips its files with a manifest, stores the zip and calls
 * update_cluster_instance, which marks the cluster QA-ready and moves its files on to the QA task.
 * Orion caches an empty answer for 5–10 minutes, so this only runs right after clusters were created.
 */
async function packageNewClusters(msg: FileTaskMessage): Promise<number> {
  let packaged = 0;
  for (let guard = 0; guard < 50; guard++) {
    const next = await callUwbe<{ instance_data: ClusterInstance }>('get-task-next-qa-cluster-with-start', {
      method: 'GET',
      query: { project_code: msg.project_code, task_uid: msg.task_uid },
    });
    if (!next.ok || !next.data?.instance_data) break;
    const cluster = next.data.instance_data;

    const entries = [];
    for (const file of cluster.cluster_files) {
      const input = await downloadFileTaskInput({ ...msg, file_id: file.file_id });
      entries.push({ name: input.fileName, data: input.bytes });
    }
    const manifest = {
      cluster: cluster.cluster_name,
      files: cluster.cluster_files.map((f) => ({ file_id: f.file_id, file_name: f.file_name })),
      packaged_at: new Date().toISOString(),
    };
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
    const zip = buildZip(entries);

    const target = await callUwbe<{ file_output_upload_url: string | null; file_s3_path: string }>('get-qa-cluster-n-prf-upload-url', {
      method: 'GET',
      query: { project_code: msg.project_code, task_uid: msg.task_uid, cluster_instance_id: cluster.cluster_instance_id, url_type: 'qa_cluster_zip' },
    });
    if (!target.ok || !target.data) throw new Error(`upload url for ${cluster.cluster_name}: ${target.error}`);
    if (target.data.file_output_upload_url) {
      await putRawBytes(target.data.file_output_upload_url, zip, 'application/zip');
    } else if (workerConfig.localStorageRoot) {
      // Local-disk Orion hands out no upload URL: write the zip where its storage would keep it.
      const dest = path.join(workerConfig.localStorageRoot, target.data.file_s3_path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, zip);
    } else {
      console.warn(`[worker] ${cluster.cluster_name}: no upload URL and no LOCAL_STORAGE_ROOT; the zip is not stored`);
    }

    const ready = await callUwbe('update_cluster_instance', {
      method: 'POST',
      body: {
        project_code: msg.project_code,
        task_uid: msg.task_uid,
        cluster_instance_id: cluster.cluster_instance_id,
        cluster_instance_name: path.basename(target.data.file_s3_path),
        s3_output_path: target.data.file_s3_path,
      },
    });
    if (!ready.ok) throw new Error(`update_cluster_instance ${cluster.cluster_name}: ${ready.error}`);
    console.log(`[worker] ${cluster.cluster_name}: ${cluster.cluster_files.length} files packaged, QA ready`);
    packaged++;
  }
  return packaged;
}

/**
 * Asks Orion to cut QA clusters from the files waiting here, then packages them for QA. The file is not
 * claimed: the cluster job only picks files that are still Yet to start at this task.
 */
export const qaCluster: Handler = {
  kind: 'trigger',
  async run(msg) {
    const result = await createQaClusterAutomatically(msg);
    if (!result.ok) throw new Error(`create-qa-cluster-automatically failed: ${result.error}`);
    await packageNewClusters(msg);
  },
};
