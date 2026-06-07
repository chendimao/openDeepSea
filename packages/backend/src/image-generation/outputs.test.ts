import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ImageGenerationJobCreateInput } from './types.js';
import type { ImageProviderProfile, ImageGenerationJob } from './types.js';
import type { Project } from '../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-outputs-')), 'test.db');

const { db, now } = await import('../db.js');
const { fileRepo } = await import('../repos/files.js');
const { projectRepo } = await import('../repos/projects.js');
const { buildProjectFileUploadDir } = await import('../uploads.js');
const { imageGenerationJobRepo } = await import('./jobs.js');
const { persistImageGenerationOutput } = await import('./outputs.js');

test('persist generated output writes project file and creates output record', async () => {
  const { project, job } = createJobFixture('persist');
  const imageData = Buffer.from('png-data');

  const result = await persistImageGenerationOutput({
    projectId: project.id,
    jobId: job.id,
    slot: 1,
    image: { data: imageData, mimeType: 'image/png' },
  });

  assert.equal(result.output.slot, 1);
  assert.equal(result.output.job_id, job.id);
  assert.equal(result.output.file_id, result.file.id);
  assert.equal(result.output.name, result.file.original_name);
  assert.equal(result.output.url, result.file.url);
  assert.equal(result.output.mime_type, 'image/png');
  assert.equal(result.output.size, imageData.byteLength);
  assert.equal(result.output.width, null);
  assert.equal(result.output.height, null);
  assert.equal(result.file.project_id, project.id);
  assert.equal(result.file.original_name, 'generated-image-1.png');
  assert.equal(result.file.mime_type, 'image/png');
  assert.equal(result.file.size, imageData.byteLength);
  assert.equal(result.file.uploaded_by_id, 'image-generation');
  assert.equal(result.file.uploaded_by_name, '图片生成');
  assert.equal(dirname(result.file.storage_path), buildProjectFileUploadDir(project.id));
  assert.equal((await readFile(result.file.storage_path)).equals(imageData), true);
  await access(result.file.storage_path, constants.F_OK);

  assert.deepEqual(fileRepo.get(result.file.id), result.file);
  assert.deepEqual(imageGenerationJobRepo.listOutputs(job.id), [result.output]);
});

function createJobFixture(name: string): { project: Project; profile: ImageProviderProfile; job: ImageGenerationJob } {
  const project = projectRepo.create({
    name: `image generation output ${name}`,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-image-generation-output-${name}-`)),
  });
  const profile = createImageProviderProfileForTest(project.id);
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  return { project, profile, job };
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
