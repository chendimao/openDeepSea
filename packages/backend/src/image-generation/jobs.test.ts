import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  ImageGenerationJobCreateInput,
  ImageProviderProfile,
} from './types.js';
import type { Project, ProjectFile } from '../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-jobs-')), 'test.db');

const { db, now } = await import('../db.js');
const { fileRepo } = await import('../repos/files.js');
const { projectRepo } = await import('../repos/projects.js');
const { imageGenerationJobRepo } = await import('./jobs.js');
const { createImageGenerationService } = await import('./service.js');

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

test('image job repo creates queued jobs and lists them by project and status', () => {
  const project = createProjectForTest('jobs-list');
  const otherProject = createProjectForTest('jobs-list-other');
  const profile = createImageProviderProfileForTest(project.id);
  const otherProfile = createImageProviderProfileForTest(otherProject.id);
  const sessionId = createSessionForTest(project.id);

  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, {
    session_id: sessionId,
    source_agent_id: 'agent-1',
  }));
  imageGenerationJobRepo.create(createJobInput(otherProject.id, otherProfile.id));

  assert.equal(job.project_id, project.id);
  assert.equal(job.session_id, sessionId);
  assert.equal(job.source_agent_id, 'agent-1');
  assert.equal(job.source_task_id, null);
  assert.equal(job.status, 'queued');
  assert.equal(job.message, null);
  assert.equal(job.error, null);
  assert.equal(job.started_at, null);
  assert.equal(job.completed_at, null);
  assert.deepEqual(imageGenerationJobRepo.get(job.id), job);

  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id).map((row) => row.id), [job.id]);
  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id, { status: 'queued' }).map((row) => row.id), [job.id]);
  assert.deepEqual(imageGenerationJobRepo.listByProject(otherProject.id).map((row) => row.project_id), [otherProject.id]);

  const running = imageGenerationJobRepo.markRunning(job.id);

  assert.equal(running.status, 'running');
  assert.notEqual(running.started_at, null);
  assert.deepEqual(running, imageGenerationJobRepo.get(job.id));
  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id, { status: 'queued' }), []);
  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id, { status: 'running' }).map((row) => row.id), [job.id]);
  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id, { sessionId }).map((row) => row.id), [job.id]);
});

test('image job repo rejects provider profiles from another project', () => {
  const project = createProjectForTest('provider-boundary');
  const otherProject = createProjectForTest('provider-boundary-other');
  const otherProfile = createImageProviderProfileForTest(otherProject.id);

  assert.throws(
    () => imageGenerationJobRepo.create(createJobInput(project.id, otherProfile.id)),
    /provider profile project mismatch/,
  );
});

test('image job repo status transitions return latest rows and throw when missing', () => {
  const { project, profile } = createJobFixture('status');
  const runningJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));

  const running = imageGenerationJobRepo.markRunning(runningJob.id);
  assert.equal(running.status, 'running');
  assert.notEqual(running.started_at, null);
  assert.equal(running.completed_at, null);
  assert.deepEqual(running, imageGenerationJobRepo.get(runningJob.id));

  const canceling = imageGenerationJobRepo.markCanceling(runningJob.id);
  assert.equal(canceling.status, 'canceling');
  assert.deepEqual(canceling, imageGenerationJobRepo.get(runningJob.id));

  const canceled = imageGenerationJobRepo.markCanceled(runningJob.id, '用户取消');
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.message, '用户取消');
  assert.equal(canceled.error, null);
  assert.notEqual(canceled.completed_at, null);
  assert.deepEqual(canceled, imageGenerationJobRepo.get(runningJob.id));

  const failedJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const failed = imageGenerationJobRepo.markFailed(failedJob.id, 'provider error');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'provider error');
  assert.notEqual(failed.completed_at, null);
  assert.deepEqual(failed, imageGenerationJobRepo.get(failedJob.id));

  const completedJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const completed = imageGenerationJobRepo.markCompleted(completedJob.id, null);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.message, null);
  assert.equal(completed.error, null);
  assert.notEqual(completed.completed_at, null);
  assert.deepEqual(completed, imageGenerationJobRepo.get(completedJob.id));

  assert.throws(() => imageGenerationJobRepo.markRunning('missing-job'), /image generation job not found/);
  assert.throws(() => imageGenerationJobRepo.markCompleted('missing-job', null), /image generation job not found/);
});

test('image job repo appends outputs and source images', () => {
  const { project, profile } = createJobFixture('relations');
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const outputFile = createProjectFileForTest(project.id, 'output.png', 'image/png', 3);

  const output = imageGenerationJobRepo.appendOutput({
    job_id: job.id,
    file_id: outputFile.id,
    slot: 1,
    name: outputFile.original_name,
    url: outputFile.url,
    mime_type: outputFile.mime_type,
    size: outputFile.size,
    width: 64,
    height: 32,
  });

  assert.equal(output.job_id, job.id);
  assert.equal(output.file_id, outputFile.id);
  assert.equal(output.slot, 1);
  assert.equal(output.width, 64);
  assert.equal(output.height, 32);
  assert.deepEqual(imageGenerationJobRepo.listOutputs(job.id), [output]);

  const source = imageGenerationJobRepo.addSourceImage({
    job_id: job.id,
    file_id: outputFile.id,
    slot: 1,
    url: outputFile.url,
    origin_job_id: job.id,
    origin_output_id: output.id,
  });

  assert.equal(source.job_id, job.id);
  assert.equal(source.file_id, outputFile.id);
  assert.equal(source.origin_job_id, job.id);
  assert.equal(source.origin_output_id, output.id);
  assert.deepEqual(imageGenerationJobRepo.listSourceImages(job.id), [source]);
});

test('image job repo rejects output and source files from another project', () => {
  const { project, profile } = createJobFixture('file-boundary');
  const otherProject = createProjectForTest('file-boundary-other');
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const otherFile = createProjectFileForTest(otherProject.id, 'other.png', 'image/png', 3);

  assert.throws(
    () =>
      imageGenerationJobRepo.appendOutput({
        job_id: job.id,
        file_id: otherFile.id,
        slot: 1,
        name: otherFile.original_name,
        url: otherFile.url,
        mime_type: otherFile.mime_type,
        size: otherFile.size,
      }),
    /file project mismatch/,
  );
  assert.throws(
    () =>
      imageGenerationJobRepo.addSourceImage({
        job_id: job.id,
        file_id: otherFile.id,
        slot: 1,
        url: otherFile.url,
      }),
    /file project mismatch/,
  );
});

test('image job repo rejects cross project and mismatched source image lineage', () => {
  const { project, profile } = createJobFixture('lineage-boundary');
  const otherProject = createProjectForTest('lineage-boundary-other');
  const otherProfile = createImageProviderProfileForTest(otherProject.id);
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const originJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'origin' }));
  const otherOriginJob = imageGenerationJobRepo.create(createJobInput(otherProject.id, otherProfile.id));
  const sourceFile = createProjectFileForTest(project.id, 'source.png', 'image/png', 5);
  const otherSourceFile = createProjectFileForTest(project.id, 'other-source.png', 'image/png', 5);
  const otherProjectSourceFile = createProjectFileForTest(otherProject.id, 'other-project-source.png', 'image/png', 5);
  const originOutput = imageGenerationJobRepo.appendOutput({
    job_id: originJob.id,
    file_id: sourceFile.id,
    slot: 1,
    name: sourceFile.original_name,
    url: sourceFile.url,
    mime_type: sourceFile.mime_type,
    size: sourceFile.size,
  });
  const otherOriginOutput = imageGenerationJobRepo.appendOutput({
    job_id: otherOriginJob.id,
    file_id: otherProjectSourceFile.id,
    slot: 1,
    name: otherProjectSourceFile.original_name,
    url: otherProjectSourceFile.url,
    mime_type: otherProjectSourceFile.mime_type,
    size: otherProjectSourceFile.size,
  });

  assert.throws(
    () =>
      imageGenerationJobRepo.addSourceImage({
        job_id: job.id,
        file_id: sourceFile.id,
        slot: 1,
        url: sourceFile.url,
        origin_job_id: originJob.id,
      }),
    /source image lineage requires both origin_job_id and origin_output_id/,
  );
  assert.throws(
    () =>
      imageGenerationJobRepo.addSourceImage({
        job_id: job.id,
        file_id: sourceFile.id,
        slot: 1,
        url: sourceFile.url,
        origin_output_id: originOutput.id,
      }),
    /source image lineage requires both origin_job_id and origin_output_id/,
  );
  assert.throws(
    () =>
      imageGenerationJobRepo.addSourceImage({
        job_id: job.id,
        file_id: sourceFile.id,
        slot: 1,
        url: sourceFile.url,
        origin_job_id: otherOriginJob.id,
        origin_output_id: otherOriginOutput.id,
      }),
    /origin job project mismatch/,
  );
  assert.throws(
    () =>
      imageGenerationJobRepo.addSourceImage({
        job_id: job.id,
        file_id: sourceFile.id,
        slot: 1,
        url: sourceFile.url,
        origin_job_id: job.id,
        origin_output_id: originOutput.id,
      }),
    /origin output job mismatch/,
  );
  assert.throws(
    () =>
      imageGenerationJobRepo.addSourceImage({
        job_id: job.id,
        file_id: otherSourceFile.id,
        slot: 1,
        url: otherSourceFile.url,
        origin_job_id: originJob.id,
        origin_output_id: originOutput.id,
      }),
    /origin output file mismatch/,
  );
});

test('image-to-image job records origin output when source file comes from generated output', async () => {
  const { project, profile } = createJobFixture('lineage-service');
  const parentJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'parent image' }));
  const parentFile = createProjectFileForTest(project.id, 'parent-output.png', 'image/png', 7);
  writeFileSync(parentFile.storage_path, Buffer.from('parent-output'));
  const parentOutput = imageGenerationJobRepo.appendOutput({
    job_id: parentJob.id,
    file_id: parentFile.id,
    slot: 1,
    name: parentFile.original_name,
    url: parentFile.url,
    mime_type: parentFile.mime_type,
    size: parentFile.size,
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => ({
      images: [{ data: Buffer.from('child-output'), mimeType: 'image/png' }],
    }),
  });

  const created = await service.createJob({
    ...createJobInput(project.id, profile.id, {
      workflow: 'image-to-image',
      prompt: 'child variant',
    }),
    source_file_ids: [parentFile.id],
  });
  const [sourceImage] = imageGenerationJobRepo.listSourceImages(created.job.id);
  await service.waitForCompletion(created.job.id);

  assert.equal(sourceImage?.file_id, parentFile.id);
  assert.equal(sourceImage?.origin_job_id, parentJob.id);
  assert.equal(sourceImage?.origin_output_id, parentOutput.id);
});

test('batch output deletion preserves source image origin lineage', () => {
  const { project, profile } = createJobFixture('batch-delete-lineage');
  const parentJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'parent image' }));
  const parentFile = createProjectFileForTest(project.id, 'batch-parent-output.png', 'image/png', 7);
  writeFileSync(parentFile.storage_path, Buffer.from('parent-output'));
  const parentOutput = imageGenerationJobRepo.appendOutput({
    job_id: parentJob.id,
    file_id: parentFile.id,
    slot: 1,
    name: parentFile.original_name,
    url: parentFile.url,
    mime_type: parentFile.mime_type,
    size: parentFile.size,
  });
  const childJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, {
    workflow: 'image-to-image',
    prompt: 'child variant',
  }));
  imageGenerationJobRepo.addSourceImage({
    job_id: childJob.id,
    file_id: parentFile.id,
    slot: 1,
    url: parentFile.url,
    origin_job_id: parentJob.id,
    origin_output_id: parentOutput.id,
  });

  const deleted = imageGenerationJobRepo.deleteOutputsByProject(project.id, [parentOutput.id]);
  const [sourceAfterDelete] = imageGenerationJobRepo.listSourceImages(childJob.id);

  assert.deepEqual(deleted.map((output) => output.id), [parentOutput.id]);
  assert.equal(imageGenerationJobRepo.findOutputByFileId(parentFile.id)?.id, parentOutput.id);
  assert.deepEqual(imageGenerationJobRepo.listOutputs(parentJob.id), []);
  assert.notEqual(fileRepo.get(parentFile.id)?.deleted_at, null);
  assert.equal(sourceAfterDelete?.origin_job_id, parentJob.id);
  assert.equal(sourceAfterDelete?.origin_output_id, parentOutput.id);
});

test('image job repo recovers interrupted jobs as canceled', () => {
  imageGenerationJobRepo.recoverInterruptedJobs();
  const { project, profile } = createJobFixture('recover');
  const queued = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'queued' }));
  const running = imageGenerationJobRepo.markRunning(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'running' })).id,
  );
  const canceling = imageGenerationJobRepo.markCanceling(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'canceling' })).id,
  );
  const completed = imageGenerationJobRepo.markCompleted(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'completed' })).id,
    'done',
  );

  const recoveredCount = imageGenerationJobRepo.recoverInterruptedJobs();

  assert.equal(recoveredCount, 3);
  for (const jobId of [queued.id, running.id, canceling.id]) {
    const recovered = imageGenerationJobRepo.get(jobId);
    assert.equal(recovered?.status, 'canceled');
    assert.equal(recovered?.message, '后端重启，图片生成任务已停止。');
    assert.equal(recovered?.error, null);
    assert.notEqual(recovered?.completed_at, null);
  }
  assert.equal(imageGenerationJobRepo.get(completed.id)?.status, 'completed');
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

function createJobFixture(name: string): { project: Project; profile: ImageProviderProfile } {
  const project = createProjectForTest(name);
  return {
    project,
    profile: createImageProviderProfileForTest(project.id),
  };
}

function createProjectForTest(name: string): Project {
  return projectRepo.create({
    name: `image generation ${name}`,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-image-generation-${name}-`)),
  });
}

function createImageProviderProfileForTest(projectId: string): ImageProviderProfile {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = now();
  db.prepare(
    `INSERT INTO image_provider_profiles (
      id, project_id, name, base_url, api_key, model, compat_profile_id,
      supports_count_parameter, active, created_at, updated_at, deleted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    projectId,
    `Profile ${id}`,
    'https://api.example.test/v1',
    'test-key',
    'test-image-model',
    'openai',
    1,
    1,
    timestamp,
    timestamp,
  );
  return db.prepare('SELECT * FROM image_provider_profiles WHERE id = ?').get(id) as ImageProviderProfile;
}

function createSessionForTest(projectId: string): string {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = now();
  db.prepare(
    `INSERT INTO sessions (
      id, project_id, title, current_goal, mode, phase, status, provider, model, workspace_path,
      worktree_path, branch_name, forked_from_session_id, forked_from_history_record_id,
      latest_compaction_id, latest_context_manifest_id, closed_at, pinned_at, last_viewed_at,
      created_at, updated_at, archived_at
    )
    VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).run(id, projectId, `Session ${id}`, 'code', 'active', 'active', timestamp, timestamp);
  return id;
}

function createJobInput(
  projectId: string,
  profileId: string,
  overrides: Partial<ImageGenerationJobCreateInput> = {},
): ImageGenerationJobCreateInput {
  return {
    project_id: projectId,
    room_id: null,
    session_id: null,
    source_message_id: null,
    source_agent_id: null,
    source_task_id: null,
    provider_profile_id: profileId,
    workflow: 'generate',
    prompt: 'apple',
    count: 1,
    quality: 'auto',
    size: 'auto',
    ...overrides,
  };
}

function createProjectFileForTest(
  projectId: string,
  originalName: string,
  mimeType: string,
  size: number,
): ProjectFile {
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${originalName}`;
  return fileRepo.create({
    project_id: projectId,
    original_name: originalName,
    stored_name: storedName,
    mime_type: mimeType,
    size,
    url: `/uploads/files/${projectId}/${storedName}`,
    storage_path: join(tmpdir(), storedName),
    uploaded_by_id: 'test',
    uploaded_by_name: '测试',
  });
}
