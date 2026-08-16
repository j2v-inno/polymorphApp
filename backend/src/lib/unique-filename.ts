import { randomBytes } from 'node:crypto';

/**
 * uw-be's register-file/register-job-batch-file both reject a file_name that
 * already exists within the same job (`File name already exists in this
 * project.`, TaskProcessController.php:573,1135) — hit repeatedly once a PDF
 * gets re-uploaded/re-split under the same name (e.g. retrying a partially
 * failed split within the same job_id). The uw-be-computed S3 upload path is
 * always derived from this same file_name, so making it unique here also
 * makes the MinIO object key unique — one fix point covers both.
 */
export function withUniqueSuffix(fileName: string): string {
  const token = randomBytes(4).toString('hex');
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `${fileName}-${token}`;
  return `${fileName.slice(0, dot)}-${token}${fileName.slice(dot)}`;
}
