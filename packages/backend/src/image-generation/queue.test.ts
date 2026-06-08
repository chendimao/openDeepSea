import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebSocket } from 'ws';
import type { ImageGenerationJobCreateInput, ImageProviderProfileInput } from './types.js';
import type { ImageGenerationRuntimeResponse } from './openai-compatible.js';
import type { Project } from '../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-queue-')), 'test.db');

const { db, now } = await import('../db.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { sessionRepo } = await import('../repos/sessions.js');
const { imageGenerationJobRepo } = await import('./jobs.js');
const { imageProviderProfileRepo } = await import('./provider-profiles.js');
const { createImageGenerationService } = await import('./service.js');
const { wsHub } = await import('../ws-hub.js');

test('image generation queue runs one job at a time', async () => {
  const { project, profile } = createFixture('serial');
  const first = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'first' }));
  const second = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'second' }));
  const startedJobIds: string[] = [];
  let resolveFirstStarted: () => void = () => {};
  let releaseFirstJob: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirstJob = resolve;
  });

  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      startedJobIds.push(request.jobId);
      if (request.jobId === first.id) {
        resolveFirstStarted();
        await firstCanFinish;
      }
      return imageResponse(`png-${request.jobId}`);
    },
  });

  service.enqueue(first.id);
  service.enqueue(second.id);

  await firstStarted;
  assert.equal(imageGenerationJobRepo.get(first.id)?.status, 'running');
  assert.equal(imageGenerationJobRepo.get(second.id)?.status, 'queued');
  assert.deepEqual(startedJobIds, [first.id]);

  releaseFirstJob();
  const secondResult = await service.waitForCompletion(second.id);

  assert.equal(imageGenerationJobRepo.get(first.id)?.status, 'completed');
  assert.equal(secondResult.job.status, 'completed');
  assert.deepEqual(startedJobIds, [first.id, second.id]);
  assert.equal(imageGenerationJobRepo.listOutputs(first.id).length, 1);
  assert.equal(secondResult.outputs.length, 1);
});

test('image generation queue cancels queued jobs without running provider runtime', async () => {
  const { project, profile } = createFixture('cancel-queued');
  const first = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'first' }));
  const second = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'second' }));
  const startedJobIds: string[] = [];
  let resolveFirstStarted: () => void = () => {};
  let releaseFirstJob: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirstJob = resolve;
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async (request) => {
      startedJobIds.push(request.jobId);
      if (request.jobId === first.id) {
        resolveFirstStarted();
        await firstCanFinish;
      }
      return imageResponse(`png-${request.jobId}`);
    },
  });

  service.enqueue(first.id);
  service.enqueue(second.id);
  await firstStarted;

  const canceled = await service.cancelJob(second.id);

  assert.equal(canceled.job.status, 'canceled');
  assert.match(canceled.job.message ?? '', /取消/);
  assert.deepEqual(startedJobIds, [first.id]);
  assert.deepEqual(imageGenerationJobRepo.listOutputs(second.id), []);

  releaseFirstJob();
  await service.waitForCompletion(first.id);
  assert.deepEqual(startedJobIds, [first.id]);
});

test('image generation queue aborts running jobs when canceled', async () => {
  const { project, profile } = createFixture('cancel-running');
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const eventTypes: string[] = [];
  let resolveStarted: () => void = () => {};
  let resolveAborted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    publishEvent: (event) => {
      eventTypes.push(event.type);
    },
    runtime: async (request) => {
      resolveStarted();
      request.signal.addEventListener('abort', resolveAborted, { once: true });
      await aborted;
      const error = new Error('aborted by test');
      error.name = 'AbortError';
      throw error;
    },
  });

  service.enqueue(job.id);
  await started;
  const canceling = await service.cancelJob(job.id);
  const result = await service.waitForCompletion(job.id);

  assert.equal(canceling.job.status, 'canceling');
  assert.equal(result.job.status, 'canceled');
  assert.match(result.job.message ?? '', /取消/);
  assert.equal(result.job.error, null);
  assert.deepEqual(result.outputs, []);
  assert.deepEqual(eventTypes, [
    'image_job:updated',
    'image_job:updated',
    'image_job:canceled',
  ]);
});

test('image generation service rejects canceling running jobs not managed by its queue', async () => {
  const { project, profile } = createFixture('cancel-unmanaged-running');
  const job = imageGenerationJobRepo.markRunning(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id)).id,
  );
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 50,
    runtime: async () => imageResponse('unused'),
  });

  await assert.rejects(service.cancelJob(job.id), /not managed by the image generation queue/);
  assert.equal(imageGenerationJobRepo.get(job.id)?.status, 'running');
});

test('image generation service rejects canceling unmanaged canceling jobs', async () => {
  const { project, profile } = createFixture('cancel-unmanaged-canceling');
  const job = imageGenerationJobRepo.markCanceling(
    imageGenerationJobRepo.markRunning(
      imageGenerationJobRepo.create(createJobInput(project.id, profile.id)).id,
    ).id,
  );
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 50,
    runtime: async () => imageResponse('unused'),
  });

  await assert.rejects(service.cancelJob(job.id), /not managed by the image generation queue/);
  assert.equal(imageGenerationJobRepo.get(job.id)?.status, 'canceling');
});

test('image generation service only runs queued jobs', async () => {
  const { project, profile } = createFixture('run-status-gate');
  const running = imageGenerationJobRepo.markRunning(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'running' })).id,
  );
  const canceling = imageGenerationJobRepo.markCanceling(
    imageGenerationJobRepo.markRunning(
      imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'canceling' })).id,
    ).id,
  );
  let runtimeCalls = 0;
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 50,
    runtime: async () => {
      runtimeCalls += 1;
      return imageResponse('unused');
    },
  });

  service.enqueue(running.id);
  service.enqueue(canceling.id);
  await service.runJob(running.id, new AbortController().signal);
  await service.runJob(canceling.id, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runtimeCalls, 0);
  assert.equal(imageGenerationJobRepo.get(running.id)?.status, 'running');
  assert.equal(imageGenerationJobRepo.get(canceling.id)?.status, 'canceling');
});

test('image generation service preserves partial outputs when count fallback fails', async () => {
  const { project, profile } = createFixture('partial', { supports_count_parameter: false });
  const job = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { count: 3 }));
  const requestedCounts: number[] = [];
  const eventTypes: string[] = [];
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    publishEvent: (event) => {
      eventTypes.push(event.type);
    },
    runtime: async (request) => {
      requestedCounts.push(request.count);
      if (requestedCounts.length === 2) {
        throw new Error('provider exploded');
      }
      return imageResponse('png-partial');
    },
  });

  service.enqueue(job.id);
  const result = await service.waitForCompletion(job.id);

  assert.equal(result.job.status, 'failed');
  assert.match(result.job.error ?? '', /provider exploded/);
  assert.deepEqual(requestedCounts, [1, 1]);
  assert.deepEqual(result.outputs.map((output) => output.slot), [1]);
  assert.equal(result.outputs[0]?.size, Buffer.byteLength('png-partial'));
  assert.deepEqual(eventTypes, [
    'image_job:updated',
    'image_job:output_added',
    'image_job:failed',
  ]);
});

test('image generation service validates count before creating or running jobs', async () => {
  const { project, profile } = createFixture('count-validation');
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => imageResponse('unused'),
  });

  await assert.rejects(
    service.createJob(createJobInput(project.id, profile.id, { count: 0 })),
    /count must be an integer between 1 and 6/,
  );
  await assert.rejects(
    service.createJob(createJobInput(project.id, profile.id, { count: 7 })),
    /count must be an integer between 1 and 6/,
  );
  await assert.rejects(
    service.createJob(createJobInput(project.id, profile.id, { count: 1.5 })),
    /count must be an integer between 1 and 6/,
  );
  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id), []);

  let runtimeCalls = 0;
  const invalidPersistedJob = imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { count: 7 }));
  const runningService = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => {
      runtimeCalls += 1;
      return imageResponse('unused');
    },
  });

  runningService.enqueue(invalidPersistedJob.id);
  const result = await runningService.waitForCompletion(invalidPersistedJob.id);

  assert.equal(result.job.status, 'failed');
  assert.match(result.job.error ?? '', /count must be an integer between 1 and 6/);
  assert.equal(runtimeCalls, 0);

  const invalidRetrySource = imageGenerationJobRepo.markFailed(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { count: 7 })).id,
    'failed before retry',
  );
  await assert.rejects(
    service.retryJob(invalidRetrySource.id),
    /count must be an integer between 1 and 6/,
  );
});

test('image generation service rejects session jobs outside the project before creating jobs', async () => {
  const { project, profile } = createFixture('session-project-boundary');
  const other = createFixture('session-project-boundary-other');
  const foreignSession = sessionRepo.create({
    project_id: other.project.id,
    title: 'Foreign Image Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: other.project.path,
  });
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => imageResponse('unused'),
  });

  await assert.rejects(
    service.createJob(createJobInput(project.id, profile.id, { session_id: foreignSession.id })),
    /session project mismatch/,
  );
  assert.deepEqual(imageGenerationJobRepo.listByProject(project.id), []);
});

test('image generation service project scoped methods reject cross project jobs', async () => {
  const { project, profile } = createFixture('project-boundary');
  const other = createFixture('project-boundary-other');
  const queued = imageGenerationJobRepo.create(createJobInput(project.id, profile.id));
  const failed = imageGenerationJobRepo.markFailed(
    imageGenerationJobRepo.create(createJobInput(project.id, profile.id, { prompt: 'failed' })).id,
    'provider failed',
  );
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 50,
    runtime: async () => imageResponse('unused'),
  });

  await assert.rejects(service.cancelProjectJob(other.project.id, queued.id), /project mismatch/);
  await assert.rejects(service.retryProjectJob(other.project.id, failed.id), /project mismatch/);
  await assert.rejects(service.waitForProjectJobCompletion(other.project.id, failed.id), /project mismatch/);
  assert.equal(imageGenerationJobRepo.get(queued.id)?.status, 'queued');
});

test('image generation service publishes lifecycle events', async () => {
  const { project, profile } = createFixture('events');
  const eventTypes: string[] = [];
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    publishEvent: (event) => {
      eventTypes.push(event.type);
    },
    runtime: async () => imageResponse('png-events'),
  });

  const created = await service.createJob(createJobInput(project.id, profile.id));
  const completed = await service.waitForCompletion(created.job.id);

  assert.equal(created.job.status, 'queued');
  assert.equal(completed.job.status, 'completed');
  assert.deepEqual(eventTypes, [
    'image_job:created',
    'image_job:updated',
    'image_job:output_added',
    'image_job:completed',
  ]);
});

test('image generation service broadcasts job events to project subscribers by default', async () => {
  const { project, profile } = createFixture('default-broadcast');
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;
  wsHub.subscribeProject(project.id, socket);
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => imageResponse('png-broadcast'),
  });

  const created = await service.createJob(createJobInput(project.id, profile.id));
  await service.waitForCompletion(created.job.id);

  assert.deepEqual(sent.map((payload) => JSON.parse(payload).type), [
    'image_job:created',
    'image_job:updated',
    'image_job:output_added',
    'image_job:completed',
  ]);
  wsHub.removeSocket(socket);
});

test('image generation service broadcasts one event per socket across project session and room subscriptions', async () => {
  const { project, profile } = createFixture('default-broadcast-dedupe');
  const room = roomRepo.create({
    project_id: project.id,
    name: 'Image broadcast dedupe room',
    ensureDefaultPlanner: false,
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Image broadcast dedupe session',
    workspace_path: project.path,
  });
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;
  wsHub.subscribeProject(project.id, socket);
  wsHub.subscribeSession(session.id, socket);
  wsHub.subscribe(room.id, socket);
  const service = createImageGenerationService({
    pollIntervalMs: 5,
    waitTimeoutMs: 1000,
    runtime: async () => imageResponse('png-broadcast-dedupe'),
  });

  const created = await service.createJob(createJobInput(project.id, profile.id, {
    session_id: session.id,
    room_id: room.id,
  }));
  await service.waitForCompletion(created.job.id);

  const eventTypes = sent.map((payload) => JSON.parse(payload).type as string);
  assert.deepEqual(eventTypes.filter((type) => type.startsWith('image_job:')), [
    'image_job:created',
    'image_job:updated',
    'image_job:output_added',
    'image_job:completed',
  ]);
  assert.equal(eventTypes.filter((type) => type === 'session_message:new').length, 1);
  wsHub.removeSocket(socket);
});

function createFixture(
  name: string,
  providerOverrides: Partial<ImageProviderProfileInput> = {},
): { project: Project; profile: { id: string } } {
  const project = projectRepo.create({
    name: `image generation queue ${name}`,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-image-generation-queue-${name}-`)),
  });
  const profile = imageProviderProfileRepo.create(project.id, {
    name: `Provider ${name} ${now()}`,
    base_url: 'https://api.example.test/v1',
    api_key: 'test-key',
    model: 'test-image-model',
    compat_profile_id: 'openai',
    supports_count_parameter: true,
    ...providerOverrides,
  });
  return { project, profile };
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

function imageResponse(data: string): ImageGenerationRuntimeResponse {
  return {
    images: [{ data: Buffer.from(data), mimeType: 'image/png' }],
  };
}
