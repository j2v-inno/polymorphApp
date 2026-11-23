import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workerConfig } from '../config.js';
import { buildZip } from '../zip.js';
import { withExtension, type Handler } from './types.js';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Packages the approved XML with a manifest, drops the zip where the client would collect it, and outputs it. */
export const transmission: Handler = {
  kind: 'process',
  // The approved XML: MARKUP_REVIEW's latest output, including files that came back from rework.
  inputFrom: process.env.TRANSMISSION_SOURCE_TASK ?? 'MARKUP_REVIEW',
  async run({ msg, input }) {
    const sentAt = new Date();
    const manifest = {
      project: msg.project_code,
      workflow: msg.workflow_code,
      file_id: msg.file_id,
      file_name: input.fileName,
      job_metadata: msg.job_metadata,
      file_metadata: msg.file_metadata,
      sha256: sha256(input.bytes),
      bytes: input.bytes.length,
      packaged_at: sentAt.toISOString(),
    };
    const zip = buildZip(
      [
        { name: input.fileName, data: input.bytes },
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      ],
      sentAt,
    );
    const zipName = withExtension(input.fileName, 'zip');
    const dir = path.resolve(workerConfig.transmissionDir, msg.project_code, msg.workflow_code);
    await mkdir(dir, { recursive: true });
    const dropPath = path.join(dir, zipName);
    await writeFile(dropPath, zip);

    return {
      output: { bytes: zip, fileName: zipName, contentType: 'application/zip' },
      metaData: { transmitted_at: sentAt.toISOString(), package_sha256: sha256(zip), package_bytes: zip.length },
    };
  },
};
