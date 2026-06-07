import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  ImageGenerationJob,
  ImageGenerationJobCreateInput,
  ImageGenerationOutput,
  ImageGenerationOutputCreateInput,
  ImageGenerationSourceImage,
  ImageGenerationSourceImageCreateInput,
  ImageGenerationStatus,
} from './types.js';

const JOB_NOT_FOUND_MESSAGE = 'image generation job not found';
const FILE_NOT_FOUND_MESSAGE = 'image generation file not found';
const RECOVER_INTERRUPTED_MESSAGE = '后端重启，图片生成任务已停止。';

export interface ImageGenerationJobRepository {
  create(input: ImageGenerationJobCreateInput): ImageGenerationJob;
  get(jobId: string): ImageGenerationJob | undefined;
  listByProject(
    projectId: string,
    filters?: { status?: ImageGenerationStatus; sessionId?: string; roomId?: string },
  ): ImageGenerationJob[];
  markRunning(jobId: string): ImageGenerationJob;
  markCanceling(jobId: string): ImageGenerationJob;
  markCanceled(jobId: string, message: string): ImageGenerationJob;
  markFailed(jobId: string, error: string): ImageGenerationJob;
  markCompleted(jobId: string, message: string | null): ImageGenerationJob;
  appendOutput(input: ImageGenerationOutputCreateInput): ImageGenerationOutput;
  listOutputs(jobId: string): ImageGenerationOutput[];
  addSourceImage(input: ImageGenerationSourceImageCreateInput): ImageGenerationSourceImage;
  listSourceImages(jobId: string): ImageGenerationSourceImage[];
  recoverInterruptedJobs(): number;
}

export const imageGenerationJobRepo: ImageGenerationJobRepository = {
  create,
  get,
  listByProject,
  markRunning,
  markCanceling,
  markCanceled,
  markFailed,
  markCompleted,
  appendOutput,
  listOutputs,
  addSourceImage,
  listSourceImages,
  recoverInterruptedJobs,
};

function create(input: ImageGenerationJobCreateInput): ImageGenerationJob {
  assertProviderProfileBelongsToProject(input.provider_profile_id, input.project_id);
  const id = nanoid(16);
  const timestamp = now();
  db.prepare(
    `INSERT INTO image_generation_jobs (
      id, project_id, room_id, session_id, source_message_id, source_agent_id, source_task_id,
      provider_profile_id, workflow, prompt, count, quality, size, status, message, error,
      created_at, started_at, completed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL, ?)`,
  ).run(
    id,
    input.project_id,
    input.room_id ?? null,
    input.session_id ?? null,
    input.source_message_id ?? null,
    input.source_agent_id ?? null,
    input.source_task_id ?? null,
    input.provider_profile_id,
    input.workflow,
    input.prompt,
    input.count,
    input.quality,
    input.size,
    timestamp,
    timestamp,
  );
  return requireJob(id);
}

function get(jobId: string): ImageGenerationJob | undefined {
  return db.prepare('SELECT * FROM image_generation_jobs WHERE id = ?').get(jobId) as
    | ImageGenerationJob
    | undefined;
}

function listByProject(
  projectId: string,
  filters: { status?: ImageGenerationStatus; sessionId?: string; roomId?: string } = {},
): ImageGenerationJob[] {
  const where = ['project_id = ?'];
  const args: Array<string> = [projectId];
  if (filters.status) {
    where.push('status = ?');
    args.push(filters.status);
  }
  if (filters.sessionId) {
    where.push('session_id = ?');
    args.push(filters.sessionId);
  }
  if (filters.roomId) {
    where.push('room_id = ?');
    args.push(filters.roomId);
  }
  return db
    .prepare(
      `SELECT *
       FROM image_generation_jobs
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(...args) as ImageGenerationJob[];
}

function markRunning(jobId: string): ImageGenerationJob {
  const timestamp = now();
  return updateJobStatus(
    jobId,
    `UPDATE image_generation_jobs
     SET status = 'running',
         started_at = COALESCE(started_at, ?),
         completed_at = NULL,
         message = NULL,
         error = NULL,
         updated_at = ?
     WHERE id = ?`,
    [timestamp, timestamp, jobId],
  );
}

function markCanceling(jobId: string): ImageGenerationJob {
  const timestamp = now();
  return updateJobStatus(
    jobId,
    `UPDATE image_generation_jobs
     SET status = 'canceling',
         updated_at = ?
     WHERE id = ?`,
    [timestamp, jobId],
  );
}

function markCanceled(jobId: string, message: string): ImageGenerationJob {
  const timestamp = now();
  return updateJobStatus(
    jobId,
    `UPDATE image_generation_jobs
     SET status = 'canceled',
         message = ?,
         error = NULL,
         completed_at = COALESCE(completed_at, ?),
         updated_at = ?
     WHERE id = ?`,
    [message, timestamp, timestamp, jobId],
  );
}

function markFailed(jobId: string, error: string): ImageGenerationJob {
  const timestamp = now();
  return updateJobStatus(
    jobId,
    `UPDATE image_generation_jobs
     SET status = 'failed',
         message = NULL,
         error = ?,
         completed_at = COALESCE(completed_at, ?),
         updated_at = ?
     WHERE id = ?`,
    [error, timestamp, timestamp, jobId],
  );
}

function markCompleted(jobId: string, message: string | null): ImageGenerationJob {
  const timestamp = now();
  return updateJobStatus(
    jobId,
    `UPDATE image_generation_jobs
     SET status = 'completed',
         message = ?,
         error = NULL,
         completed_at = COALESCE(completed_at, ?),
         updated_at = ?
     WHERE id = ?`,
    [message, timestamp, timestamp, jobId],
  );
}

function appendOutput(input: ImageGenerationOutputCreateInput): ImageGenerationOutput {
  const job = requireJob(input.job_id);
  assertFileBelongsToJobProject(input.file_id, job.project_id);
  const id = nanoid(16);
  db.prepare(
    `INSERT INTO image_generation_outputs (
      id, job_id, file_id, slot, name, url, mime_type, size, width, height, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.job_id,
    input.file_id,
    input.slot,
    input.name,
    input.url,
    input.mime_type,
    input.size,
    input.width ?? null,
    input.height ?? null,
    now(),
  );
  return db.prepare('SELECT * FROM image_generation_outputs WHERE id = ?').get(id) as ImageGenerationOutput;
}

function listOutputs(jobId: string): ImageGenerationOutput[] {
  return db
    .prepare(
      `SELECT *
       FROM image_generation_outputs
       WHERE job_id = ?
       ORDER BY slot ASC, created_at ASC`,
    )
    .all(jobId) as ImageGenerationOutput[];
}

function addSourceImage(input: ImageGenerationSourceImageCreateInput): ImageGenerationSourceImage {
  const job = requireJob(input.job_id);
  assertFileBelongsToJobProject(input.file_id, job.project_id);
  assertSourceImageLineageBelongsToProject(input, job.project_id);
  const id = nanoid(16);
  db.prepare(
    `INSERT INTO image_generation_source_images (
      id, job_id, file_id, slot, url, origin_job_id, origin_output_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.job_id,
    input.file_id,
    input.slot,
    input.url,
    input.origin_job_id ?? null,
    input.origin_output_id ?? null,
    now(),
  );
  return db
    .prepare('SELECT * FROM image_generation_source_images WHERE id = ?')
    .get(id) as ImageGenerationSourceImage;
}

function listSourceImages(jobId: string): ImageGenerationSourceImage[] {
  return db
    .prepare(
      `SELECT *
       FROM image_generation_source_images
       WHERE job_id = ?
       ORDER BY slot ASC, created_at ASC`,
    )
    .all(jobId) as ImageGenerationSourceImage[];
}

function recoverInterruptedJobs(): number {
  const timestamp = now();
  return db
    .prepare(
      `UPDATE image_generation_jobs
       SET status = 'canceled',
           message = ?,
           error = NULL,
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE status IN ('queued', 'running', 'canceling')`,
    )
    .run(RECOVER_INTERRUPTED_MESSAGE, timestamp, timestamp).changes;
}

function updateJobStatus(jobId: string, sql: string, args: Array<string | number | null>): ImageGenerationJob {
  const result = db.prepare(sql).run(...args);
  if (result.changes === 0) {
    throw new Error(JOB_NOT_FOUND_MESSAGE);
  }
  return requireJob(jobId);
}

function requireJob(jobId: string): ImageGenerationJob {
  const job = get(jobId);
  if (!job) {
    throw new Error(JOB_NOT_FOUND_MESSAGE);
  }
  return job;
}

function assertProviderProfileBelongsToProject(profileId: string, projectId: string): void {
  const profile = db
    .prepare(
      `SELECT project_id
       FROM image_provider_profiles
       WHERE id = ?
         AND deleted_at IS NULL`,
    )
    .get(profileId) as { project_id: string } | undefined;
  if (!profile) {
    throw new Error('image provider profile not found');
  }
  if (profile.project_id !== projectId) {
    throw new Error('image provider profile project mismatch');
  }
}

function assertFileBelongsToJobProject(fileId: string, projectId: string): void {
  const file = db
    .prepare(
      `SELECT project_id
       FROM files
       WHERE id = ?
         AND deleted_at IS NULL`,
    )
    .get(fileId) as { project_id: string } | undefined;
  if (!file) {
    throw new Error(FILE_NOT_FOUND_MESSAGE);
  }
  if (file.project_id !== projectId) {
    throw new Error('image generation file project mismatch');
  }
}

function assertSourceImageLineageBelongsToProject(
  input: ImageGenerationSourceImageCreateInput,
  projectId: string,
): void {
  if (input.origin_job_id) {
    const originJob = requireJob(input.origin_job_id);
    if (originJob.project_id !== projectId) {
      throw new Error('image generation origin job project mismatch');
    }
  }

  if (!input.origin_output_id) return;

  const originOutput = db
    .prepare(
      `SELECT image_generation_outputs.file_id, image_generation_outputs.job_id, image_generation_jobs.project_id
       FROM image_generation_outputs
       JOIN image_generation_jobs ON image_generation_jobs.id = image_generation_outputs.job_id
       WHERE image_generation_outputs.id = ?`,
    )
    .get(input.origin_output_id) as { file_id: string; job_id: string; project_id: string } | undefined;
  if (!originOutput) {
    throw new Error('image generation origin output not found');
  }
  if (originOutput.project_id !== projectId) {
    throw new Error('image generation origin output project mismatch');
  }
  if (input.origin_job_id && originOutput.job_id !== input.origin_job_id) {
    throw new Error('image generation origin output job mismatch');
  }
  if (originOutput.file_id !== input.file_id) {
    throw new Error('image generation origin output file mismatch');
  }
}
