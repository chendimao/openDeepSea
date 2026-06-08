import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ImageGenerationJob, ImageGenerationOutput } from './types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-routes-')), 'test.db');

const { db, now } = await import('../db.js');
const { fileRepo } = await import('../repos/files.js');
const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { sessionMessageRepo, sessionRepo } = await import('../repos/sessions.js');
const { taskRepo } = await import('../repos/tasks.js');
const { router } = await import('../routes.js');
const { buildProjectFileUploadDir } = await import('../uploads.js');
const { imageGenerationJobRepo } = await import('./jobs.js');
const { imageProviderProfileRepo } = await import('./provider-profiles.js');
const { createImageGenerationService } = await import('./service.js');
const { setImageGenerationRouteDeps } = await import('./routes.js');

const app = express();
app.use(express.json());
app.use('/api', router);

test('image provider profile routes create list update activate and delete safe profiles', async () => {
  const project = createProjectForTest('profiles');

  const createRes = await request(`/api/projects/${project.id}/image-provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'SCimage',
      base_url: 'https://api.example.test',
      api_key: 'secret-key',
      model: 'gpt-image-2',
      compat_profile_id: 'images-edits',
      supports_count_parameter: false,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as Record<string, unknown>;
  assert.equal(created.project_id, project.id);
  assert.equal(created.has_api_key, 1);
  assert.equal(created.supports_count_parameter, 0);
  assert.equal(Object.hasOwn(created, 'api_key'), false);

  const secondRes = await request(`/api/projects/${project.id}/image-provider-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Backup',
      base_url: 'https://backup.example.test/v1',
      api_key: 'backup-secret',
      model: 'gpt-image-backup',
      compat_profile_id: 'openai',
      supports_count_parameter: true,
    }),
  });
  assert.equal(secondRes.status, 201);
  const second = await secondRes.json() as { id: string };

  const patchRes = await request(`/api/projects/${project.id}/image-provider-profiles/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'SCimage Primary',
      base_url: 'https://api.example.test/v1',
      api_key: '',
      model: 'gpt-image-primary',
      compat_profile_id: 'images-edits',
      supports_count_parameter: false,
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as Record<string, unknown>;
  assert.equal(patched.name, 'SCimage Primary');
  assert.equal(patched.has_api_key, 1);
  assert.equal(Object.hasOwn(patched, 'api_key'), false);

  const activateRes = await request(`/api/projects/${project.id}/image-provider-profiles/${second.id}/activate`, {
    method: 'POST',
  });
  assert.equal(activateRes.status, 200);
  assert.equal((await activateRes.json() as { id: string; active: number }).active, 1);

  const listRes = await request(`/api/projects/${project.id}/image-provider-profiles`);
  assert.equal(listRes.status, 200);
  const profiles = await listRes.json() as Array<Record<string, unknown>>;
  assert.deepEqual(profiles.map((profile) => profile.id), [second.id, created.id]);
  assert.equal(profiles.some((profile) => Object.hasOwn(profile, 'api_key')), false);

  const deleteRes = await request(`/api/projects/${project.id}/image-provider-profiles/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteRes.status, 200);
  assert.equal((await deleteRes.json() as { id: string; deleted_at: number | null }).deleted_at !== null, true);

  const missingProjectRes = await request('/api/projects/missing-project/image-provider-profiles');
  assert.equal(missingProjectRes.status, 404);
});

test('image provider model route lists models through injected fetch without leaking credentials', async () => {
  const project = createProjectForTest('models');
  const profile = createActiveProfile(project.id);
  let authorizationHeader = '';
  setImageGenerationRouteDeps({
    modelFetch: async (_input, init) => {
      authorizationHeader = String(init?.headers instanceof Headers
        ? init.headers.get('authorization')
        : (init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return Response.json({
        data: [
          { id: 'gpt-image-2' },
          { id: 'text-only-model' },
        ],
      });
    },
  });

  const res = await request(`/api/projects/${project.id}/image-provider-profiles/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile_id: profile.id,
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(authorizationHeader, 'Bearer test-key');
  const payload = await res.json() as {
    normalized_base_url: string;
    models: Array<{ id: string; category: string }>;
    warning: string | null;
  };
  assert.equal(payload.normalized_base_url, 'https://models.example.test/v1');
  assert.deepEqual(payload.models, [
    { id: 'gpt-image-2', category: 'image' },
    { id: 'text-only-model', category: 'other' },
  ]);
  assert.equal(payload.warning, null);

  const arbitraryBaseUrlRes = await request(`/api/projects/${project.id}/image-provider-profiles/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: 'https://169.254.169.254/latest/meta-data',
      api_key: 'unsafe',
    }),
  });
  assert.equal(arbitraryBaseUrlRes.status, 400);
});

test('image job routes create list get cancel and retry project scoped jobs', async () => {
  const project = createProjectForTest('jobs');
  const profile = createActiveProfile(project.id);
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => ({
      images: [{ data: Buffer.from('png-route'), mimeType: 'image/png' }],
    }),
  });
  setImageGenerationRouteDeps({ service });

  const createRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
    }),
  });

  assert.equal(createRes.status, 202);
  const created = await createRes.json() as { job: ImageGenerationJob; outputs: ImageGenerationOutput[] };
  assert.equal(created.job.project_id, project.id);
  assert.equal(created.job.provider_profile_id, profile.id);
  assert.equal(created.job.status, 'queued');
  assert.deepEqual(created.outputs, []);

  const completed = await service.waitForProjectJobCompletion(project.id, created.job.id);
  assert.equal(completed.job.status, 'completed');
  assert.equal(completed.outputs.length, 1);

  const listRes = await request(`/api/projects/${project.id}/image-jobs?status=completed`);
  assert.equal(listRes.status, 200);
  const listPayload = await listRes.json() as { jobs: ImageGenerationJob[] };
  assert.deepEqual(listPayload.jobs.map((job) => job.id), [created.job.id]);

  const detailRes = await request(`/api/projects/${project.id}/image-jobs/${created.job.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as { job: ImageGenerationJob; outputs: ImageGenerationOutput[] };
  assert.equal(detail.job.id, created.job.id);
  assert.equal(detail.outputs.length, 1);

  const queued = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'cancel me' }));
  const cancelRes = await request(`/api/projects/${project.id}/image-jobs/${queued.id}/cancel`, { method: 'POST' });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json() as { job: ImageGenerationJob }).job.status, 'canceled');

  const retryRes = await request(`/api/projects/${project.id}/image-jobs/${completed.job.id}/retry`, {
    method: 'POST',
  });
  assert.equal(retryRes.status, 202);
  const retried = await retryRes.json() as { job: ImageGenerationJob };
  assert.notEqual(retried.job.id, completed.job.id);
  assert.equal(retried.job.prompt, completed.job.prompt);

  const deleteRes = await request(`/api/projects/${project.id}/image-jobs/${completed.job.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteRes.status, 405);
  assert.equal(imageGenerationJobRepo.get(completed.job.id)?.status, 'completed');
});

test('image job route validates project boundaries and image-to-image source files', async () => {
  const project = createProjectForTest('validation');
  const otherProject = createProjectForTest('validation-other');
  createActiveProfile(project.id);
  const otherRoom = roomRepo.create({ project_id: otherProject.id, name: 'Other Room' });
  const otherSession = sessionRepo.create({ project_id: otherProject.id, title: 'Other Session' });
  const sourceFile = await createProjectFileForTest(project.id, 'source.png', 'image/png', Buffer.from('source'));
  const textFile = await createProjectFileForTest(project.id, 'note.txt', 'text/plain', Buffer.from('text'));
  const otherFile = await createProjectFileForTest(otherProject.id, 'other.png', 'image/png', Buffer.from('other'));
  let capturedSourceCount = 0;
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      capturedSourceCount = request.sourceImages.length;
      return { images: [{ data: Buffer.from('png-edit'), mimeType: 'image/png' }] };
    },
  });
  setImageGenerationRouteDeps({ service });

  const missingSourceRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'image-to-image',
      prompt: 'edit apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      source_file_ids: [],
    }),
  });
  assert.equal(missingSourceRes.status, 400);

  const textSourceRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'image-to-image',
      prompt: 'edit apple',
      count: 1,
      source_file_ids: [textFile.id],
    }),
  });
  assert.equal(textSourceRes.status, 400);

  const crossFileRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'image-to-image',
      prompt: 'edit apple',
      count: 1,
      source_file_ids: [otherFile.id],
    }),
  });
  assert.equal(crossFileRes.status, 404);

  const roomMismatchRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      room_id: otherRoom.id,
    }),
  });
  assert.equal(roomMismatchRes.status, 404);

  const sessionMismatchRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      session_id: otherSession.id,
    }),
  });
  assert.equal(sessionMismatchRes.status, 404);

  const createRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'image-to-image',
      prompt: 'edit apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      source_file_ids: [`file:${sourceFile.id}`],
    }),
  });
  assert.equal(createRes.status, 202);
  const created = await createRes.json() as { job: ImageGenerationJob };
  const completed = await service.waitForProjectJobCompletion(project.id, created.job.id);
  assert.equal(completed.job.status, 'completed');
  assert.equal(capturedSourceCount, 1);
  assert.equal(imageGenerationJobRepo.listSourceImages(created.job.id)[0]?.file_id, sourceFile.id);
});

test('image job route records a session status message when created from a session', async () => {
  const project = createProjectForTest('session-job-message');
  const profile = createActiveProfile(project.id);
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Session Image Job',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => ({ images: [{ data: Buffer.from('session-image'), mimeType: 'image/png' }] }),
  });
  setImageGenerationRouteDeps({ service });

  const createRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: session.id,
      provider_profile_id: profile.id,
      workflow: 'generate',
      prompt: 'session apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
    }),
  });

  assert.equal(createRes.status, 202);
  const created = await createRes.json() as { job: ImageGenerationJob };
  const [message] = sessionMessageRepo.listBySession(session.id);
  assert.equal(message?.role, 'system');
  assert.equal(message?.sender_id, 'image-generation');
  assert.equal(message?.message_type, 'system');
  assert.match(message?.content ?? '', /session apple/);
  const metadata = JSON.parse(message?.metadata ?? '{}') as {
    image_generation_job_id?: string;
    attachments?: unknown[];
  };
  assert.equal(metadata.image_generation_job_id, created.job.id);
  assert.equal(metadata.attachments, undefined);
});

test('image job routes hide cross project resources', async () => {
  const project = createProjectForTest('boundary');
  const otherProject = createProjectForTest('boundary-other');
  const profile = createActiveProfile(project.id);
  const otherProfile = createActiveProfile(otherProject.id);
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const otherJob = imageGenerationJobRepo.markFailed(
    imageGenerationJobRepo.create(createJobInput(otherProject.id, otherProfile.id)).id,
    'failed elsewhere',
  );
  const otherRoom = roomRepo.create({
    project_id: otherProject.id,
    name: 'Other boundary room',
    ensureDefaultPlanner: false,
  });
  const otherMessage = messageRepo.create({
    room_id: otherRoom.id,
    sender_type: 'user',
    sender_id: 'user',
    content: 'other project message',
  });
  const otherTask = taskRepo.create({
    project_id: otherProject.id,
    room_id: otherRoom.id,
    title: 'Other project task',
  });
  const otherFile = await createProjectFileForTest(otherProject.id, 'other-source.png', 'image/png', Buffer.from('other'));
  setImageGenerationRouteDeps({
    service: createImageGenerationService({
      pollIntervalMs: 5,
      waitTimeoutMs: 50,
      runtime: async () => ({ images: [{ data: Buffer.from('unused'), mimeType: 'image/png' }] }),
    }),
  });

  const detailRes = await request(`/api/projects/${project.id}/image-jobs/${otherJob.id}`);
  assert.equal(detailRes.status, 404);

  const cancelRes = await request(`/api/projects/${project.id}/image-jobs/${otherJob.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(cancelRes.status, 404);

  const retryRes = await request(`/api/projects/${project.id}/image-jobs/${otherJob.id}/retry`, {
    method: 'POST',
  });
  assert.equal(retryRes.status, 404);

  const sourceFileRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'image-to-image',
      prompt: 'edit apple',
      count: 1,
      source_file_ids: [otherFile.id],
    }),
  });
  assert.equal(sourceFileRes.status, 404);

  const sourceMessageRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'generate',
      prompt: 'apple from foreign message',
      count: 1,
      source_message_id: otherMessage.id,
    }),
  });
  assert.equal(sourceMessageRes.status, 404);

  const sourceTaskRes = await request(`/api/projects/${project.id}/image-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'generate',
      prompt: 'apple from foreign task',
      count: 1,
      source_task_id: otherTask.id,
    }),
  });
  assert.equal(sourceTaskRes.status, 404);
  assert.equal(imageGenerationJobRepo.get(job.id)?.status, 'queued');
});

test('image job routes group jobs by prompt', async () => {
  const project = createProjectForTest('groups');
  const otherProject = createProjectForTest('groups-other');
  const profile = createActiveProfile(project.id);
  const otherProfile = createActiveProfile(otherProject.id);
  const appleFirst = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'apple poster' }));
  const banana = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'banana poster' }));
  const appleLatest = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'apple poster' }));
  imageGenerationJobRepo.create(createJobInput(otherProject.id, otherProfile.id, { prompt: 'apple poster' }));
  imageGenerationJobRepo.markCompleted(appleFirst.id, 'done');
  imageGenerationJobRepo.markCompleted(banana.id, 'done');
  const latest = imageGenerationJobRepo.markCompleted(appleLatest.id, 'done');
  const latestUpdatedAt = latest.updated_at + 1000;
  db.prepare('UPDATE image_generation_jobs SET updated_at = ? WHERE id = ?').run(latestUpdatedAt, appleLatest.id);

  const response = await request(`/api/projects/${project.id}/image-jobs/groups?groupBy=prompt`);

  assert.equal(response.status, 200);
  const groups = await response.json() as Array<{
    key: string;
    label: string;
    count: number;
    latest_job_id: string;
    latest_updated_at: number;
  }>;
  assert.deepEqual(groups.map((group) => [group.key, group.count]), [
    ['apple poster', 2],
    ['banana poster', 1],
  ]);
  assert.equal(groups[0]?.label, 'apple poster');
  assert.equal(groups[0]?.latest_job_id, appleLatest.id);
  assert.equal(groups[0]?.latest_updated_at, latestUpdatedAt);

  const invalidResponse = await request(`/api/projects/${project.id}/image-jobs/groups?groupBy=provider`);
  assert.equal(invalidResponse.status, 400);
});

test('image prompt preset routes create search and delete project scoped presets', async () => {
  const project = createProjectForTest('prompt-presets');
  const otherProject = createProjectForTest('prompt-presets-other');

  const createRes = await request(`/api/projects/${project.id}/image-prompt-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '  海报模板  ',
      prompt: '  生成一张深海主题产品海报  ',
    }),
  });

  assert.equal(createRes.status, 201);
  const created = await createRes.json() as {
    id: string;
    project_id: string;
    title: string;
    prompt: string;
    deleted_at: number | null;
  };
  assert.equal(created.project_id, project.id);
  assert.equal(created.title, '海报模板');
  assert.equal(created.prompt, '生成一张深海主题产品海报');
  assert.equal(created.deleted_at, null);

  const searchRes = await request(`/api/projects/${project.id}/image-prompt-presets?q=深海`);
  assert.equal(searchRes.status, 200);
  const searched = await searchRes.json() as Array<{ id: string }>;
  assert.deepEqual(searched.map((preset) => preset.id), [created.id]);

  const crossProjectDeleteRes = await request(`/api/projects/${otherProject.id}/image-prompt-presets/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(crossProjectDeleteRes.status, 404);

  const deleteRes = await request(`/api/projects/${project.id}/image-prompt-presets/${created.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteRes.status, 200);
  const afterDeleteRes = await request(`/api/projects/${project.id}/image-prompt-presets`);
  const afterDelete = await afterDeleteRes.json() as Array<{ id: string }>;
  assert.deepEqual(afterDelete.map((preset) => preset.id), []);
});

test('image output batch routes create manifests and delete selected outputs', async () => {
  const project = createProjectForTest('output-batch');
  const profile = createActiveProfile(project.id);
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'batch poster' }));
  const outputFile = await createProjectFileForTest(project.id, 'batch.png', 'image/png', Buffer.from('batch'));
  const output = imageGenerationJobRepo.appendOutput({
    job_id: job.id,
    file_id: outputFile.id,
    slot: 1,
    name: outputFile.original_name,
    url: outputFile.url,
    mime_type: outputFile.mime_type,
    size: outputFile.size,
  });
  imageGenerationJobRepo.markCompleted(job.id, 'done');

  const manifestRes = await request(`/api/projects/${project.id}/image-outputs/batch/download-manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_ids: [output.id] }),
  });
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json() as {
    outputs: Array<{ id: string; name: string; url: string; file_id: string }>;
  };
  assert.deepEqual(manifest.outputs, [{
    id: output.id,
    name: output.name,
    url: output.url,
    file_id: output.file_id,
  }]);

  const deleteRes = await request(`/api/projects/${project.id}/image-outputs/batch/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_ids: [output.id] }),
  });
  assert.equal(deleteRes.status, 200);
  const deleted = await deleteRes.json() as { deleted_output_ids: string[] };
  assert.deepEqual(deleted.deleted_output_ids, [output.id]);
  assert.notEqual(fileRepo.get(outputFile.id)?.deleted_at, null);
  assert.deepEqual(imageGenerationJobRepo.listOutputs(job.id), []);
  await assert.rejects(access(outputFile.storage_path), /ENOENT/);
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    server.close();
  }
}

function createProjectForTest(name: string) {
  return projectRepo.create({
    name: `image generation route ${name}`,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-image-generation-route-${name}-`)),
  });
}

function createActiveProfile(projectId: string) {
  return imageProviderProfileRepo.create(projectId, {
    name: `Provider ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`,
    base_url: 'https://models.example.test/v1',
    api_key: 'test-key',
    model: 'test-image-model',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
  });
}

function createJobInput(
  projectId: string,
  profileId: string,
  overrides: Partial<Parameters<typeof imageGenerationJobRepo.create>[0]> = {},
): Parameters<typeof imageGenerationJobRepo.create>[0] {
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

async function createProjectFileForTest(
  projectId: string,
  name: string,
  mimeType: string,
  data: Buffer,
) {
  const uploadDir = buildProjectFileUploadDir(projectId);
  await mkdir(uploadDir, { recursive: true });
  const storagePath = join(uploadDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  await writeFile(storagePath, data);
  return fileRepo.create({
    project_id: projectId,
    original_name: name,
    stored_name: storagePath.split('/').pop() ?? name,
    mime_type: mimeType,
    size: data.byteLength,
    url: `/uploads/files/${projectId}/${storagePath.split('/').pop() ?? name}`,
    storage_path: storagePath,
    uploaded_by_id: 'test',
    uploaded_by_name: 'Test',
  });
}
