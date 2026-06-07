import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-jobs-')), 'test.db');

const { db, now } = await import('../db.js');

test('image generation schema creates provider job output and source tables', () => {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'image_provider_profiles',
        'image_generation_jobs',
        'image_generation_outputs',
        'image_generation_source_images'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(tables.map((row) => row.name), [
    'image_generation_jobs',
    'image_generation_outputs',
    'image_generation_source_images',
    'image_provider_profiles',
  ]);
});

test('image generation schema exposes required columns indexes and foreign keys', () => {
  assertColumnNames('image_provider_profiles', [
    'id',
    'project_id',
    'name',
    'base_url',
    'api_key',
    'model',
    'compat_profile_id',
    'supports_count_parameter',
    'active',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  assertColumnNames('image_generation_jobs', [
    'id',
    'project_id',
    'room_id',
    'session_id',
    'source_message_id',
    'source_agent_id',
    'source_task_id',
    'provider_profile_id',
    'workflow',
    'prompt',
    'count',
    'quality',
    'size',
    'status',
    'message',
    'error',
    'created_at',
    'started_at',
    'completed_at',
    'updated_at',
  ]);
  assertColumnNames('image_generation_outputs', [
    'id',
    'job_id',
    'file_id',
    'slot',
    'name',
    'url',
    'mime_type',
    'size',
    'width',
    'height',
    'created_at',
  ]);
  assertColumnNames('image_generation_source_images', [
    'id',
    'job_id',
    'file_id',
    'slot',
    'url',
    'origin_job_id',
    'origin_output_id',
    'created_at',
  ]);

  assertIndexNames('image_provider_profiles', [
    'idx_image_provider_profiles_one_active',
    'idx_image_provider_profiles_project',
    'idx_image_provider_profiles_project_name',
  ]);
  assertIndexNames('image_generation_jobs', [
    'idx_image_generation_jobs_project',
    'idx_image_generation_jobs_room',
    'idx_image_generation_jobs_session',
  ]);
  assertIndexNames('image_generation_outputs', ['idx_image_generation_outputs_job']);
  assertIndexNames('image_generation_source_images', ['idx_image_generation_source_images_job']);

  assertForeignKeys('image_provider_profiles', ['project_id->projects.id:CASCADE']);
  assertForeignKeys('image_generation_jobs', [
    'project_id->projects.id:CASCADE',
    'provider_profile_id->image_provider_profiles.id:RESTRICT',
    'room_id->rooms.id:SET NULL',
    'session_id->sessions.id:SET NULL',
    'source_message_id->messages.id:SET NULL',
    'source_task_id->tasks.id:SET NULL',
  ]);
  assertForeignKeys('image_generation_outputs', [
    'file_id->files.id:CASCADE',
    'job_id->image_generation_jobs.id:CASCADE',
  ]);
  assertForeignKeys('image_generation_source_images', [
    'file_id->files.id:RESTRICT',
    'job_id->image_generation_jobs.id:CASCADE',
    'origin_job_id->image_generation_jobs.id:SET NULL',
    'origin_output_id->image_generation_outputs.id:SET NULL',
  ]);
});

test('image generation schema enforces workflow status and slot constraints', () => {
  const fixture = createSchemaFixture('constraint');

  assert.throws(
    () => insertJob({ ...fixture, jobId: 'job-invalid-workflow', workflow: 'paint' }),
    /CHECK constraint failed|constraint/i,
  );
  assert.throws(
    () => insertJob({ ...fixture, jobId: 'job-invalid-status', status: 'paused' }),
    /CHECK constraint failed|constraint/i,
  );

  insertJob({ ...fixture, jobId: 'job-slot' });
  insertOutput({ ...fixture, outputId: 'output-1', jobId: 'job-slot', slot: 1 });
  assert.throws(
    () => insertOutput({ ...fixture, outputId: 'output-duplicate', jobId: 'job-slot', slot: 1 }),
    /UNIQUE constraint failed|constraint/i,
  );
  insertSourceImage({ ...fixture, sourceImageId: 'source-1', jobId: 'job-slot', slot: 1 });
  assert.throws(
    () => insertSourceImage({ ...fixture, sourceImageId: 'source-duplicate', jobId: 'job-slot', slot: 1 }),
    /UNIQUE constraint failed|constraint/i,
  );
});

test('image generation schema supports queued running and canceling startup recovery candidates', () => {
  const fixture = createSchemaFixture('recovery');
  insertJob({ ...fixture, jobId: 'job-queued', status: 'queued' });
  insertJob({ ...fixture, jobId: 'job-running', status: 'running' });
  insertJob({ ...fixture, jobId: 'job-canceling', status: 'canceling' });
  insertJob({ ...fixture, jobId: 'job-completed', status: 'completed' });
  insertJob({ ...fixture, jobId: 'job-failed', status: 'failed' });

  const candidates = db.prepare(`
    SELECT id
    FROM image_generation_jobs
    WHERE project_id = ?
      AND status IN ('queued', 'running', 'canceling')
    ORDER BY id
  `).all(fixture.projectId) as Array<{ id: string }>;

  assert.deepEqual(candidates.map((row) => row.id), [
    'job-canceling',
    'job-queued',
    'job-running',
  ]);
});

function assertColumnNames(table: string, expected: string[]): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  assert.deepEqual(rows.map((row) => row.name), expected);
}

function assertIndexNames(table: string, expected: string[]): void {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
  const indexNames = rows
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_autoindex_'))
    .sort();
  assert.deepEqual(indexNames, expected);
}

function assertForeignKeys(table: string, expected: string[]): void {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }>;
  const keys = rows
    .map((row) => `${row.from}->${row.table}.${row.to}:${row.on_delete}`)
    .sort();
  assert.deepEqual(keys, expected);
}

function createSchemaFixture(suffix: string): { projectId: string; profileId: string; fileId: string } {
  const projectId = `project-${suffix}`;
  const profileId = `profile-${suffix}`;
  const fileId = `file-${suffix}`;
  const ts = now();
  db.prepare(`
    INSERT INTO projects (id, name, path, description, message_routing_mode, fallback_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'fallback_reply', 'planner', ?, ?)
  `).run(projectId, `Project ${suffix}`, mkdtempSync(join(tmpdir(), `opendeepsea-image-schema-${suffix}-`)), ts, ts);
  db.prepare(`
    INSERT INTO image_provider_profiles (
      id, project_id, name, base_url, api_key, model, compat_profile_id,
      supports_count_parameter, active, created_at, updated_at, deleted_at
    )
    VALUES (?, ?, ?, 'https://example.com/v1', 'secret', 'gpt-image-2', 'openai', 1, 1, ?, ?, NULL)
  `).run(profileId, projectId, `Provider ${suffix}`, ts, ts);
  db.prepare(`
    INSERT INTO files (
      id, project_id, original_name, stored_name, mime_type, size, url, storage_path,
      uploaded_by_id, uploaded_by_name, created_at, deleted_at
    )
    VALUES (?, ?, 'source.png', 'source.png', 'image/png', 3, '/uploads/source.png', '/tmp/source.png',
      'test', 'Test', ?, NULL)
  `).run(fileId, projectId, ts);
  return { projectId, profileId, fileId };
}

function insertJob(input: {
  projectId: string;
  profileId: string;
  jobId: string;
  workflow?: string;
  status?: string;
}): void {
  const ts = now();
  db.prepare(`
    INSERT INTO image_generation_jobs (
      id, project_id, room_id, session_id, source_message_id, source_agent_id, source_task_id,
      provider_profile_id, workflow, prompt, count, quality, size, status, message, error,
      created_at, started_at, completed_at, updated_at
    )
    VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 'apple', 1, 'auto', 'auto', ?, NULL, NULL, ?, NULL, NULL, ?)
  `).run(
    input.jobId,
    input.projectId,
    input.profileId,
    input.workflow ?? 'generate',
    input.status ?? 'queued',
    ts,
    ts,
  );
}

function insertOutput(input: {
  jobId: string;
  fileId: string;
  outputId: string;
  slot: number;
}): void {
  db.prepare(`
    INSERT INTO image_generation_outputs (
      id, job_id, file_id, slot, name, url, mime_type, size, width, height, created_at
    )
    VALUES (?, ?, ?, ?, 'generated.png', '/uploads/generated.png', 'image/png', 3, NULL, NULL, ?)
  `).run(input.outputId, input.jobId, input.fileId, input.slot, now());
}

function insertSourceImage(input: {
  jobId: string;
  fileId: string;
  sourceImageId: string;
  slot: number;
}): void {
  db.prepare(`
    INSERT INTO image_generation_source_images (
      id, job_id, file_id, slot, url, origin_job_id, origin_output_id, created_at
    )
    VALUES (?, ?, ?, ?, '/uploads/source.png', NULL, NULL, ?)
  `).run(input.sourceImageId, input.jobId, input.fileId, input.slot, now());
}
