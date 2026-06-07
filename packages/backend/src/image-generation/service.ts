import { readFile } from 'node:fs/promises';
import { fileRepo } from '../repos/files.js';
import type { ProjectFile } from '../types.js';
import type {
  ImageGenerationJob,
  ImageGenerationJobCreateInput,
  ImageGenerationOutput,
  ImageGenerationWsEvent,
  ImageGenerationWorkflow,
  ImageProviderProfileWithSecret,
} from './types.js';
import { imageGenerationJobRepo, type ImageGenerationJobRepository } from './jobs.js';
import {
  type ImageGenerationRuntimeImage,
  type ImageGenerationRuntimeResponse,
  type ImageGenerationRuntimeSourceImage,
  requestOpenAICompatibleImageEdit,
  requestOpenAICompatibleImageGeneration,
} from './openai-compatible.js';
import { persistImageGenerationOutput } from './outputs.js';
import {
  imageProviderProfileRepo,
  type ImageProviderProfileRepository,
} from './provider-profiles.js';
import { ImageGenerationQueue } from './queue.js';

const DEFAULT_WAIT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const CANCELED_MESSAGE = '用户取消图片生成任务。';
const MIN_IMAGE_COUNT = 1;
const MAX_IMAGE_COUNT = 6;

export interface ImageGenerationCreateJobInput extends ImageGenerationJobCreateInput {
  source_file_ids?: string[];
}

export interface ImageGenerationServiceRuntimeRequest {
  jobId: string;
  profileId: string;
  workflow: ImageGenerationWorkflow;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  count: number;
  quality: string;
  size: string;
  signal: AbortSignal;
  sourceImages: ImageGenerationRuntimeSourceImage[];
}

export type ImageGenerationRuntimeAdapter = (
  request: ImageGenerationServiceRuntimeRequest,
) => Promise<ImageGenerationRuntimeResponse>;

export interface ImageGenerationServiceDeps {
  jobRepo?: ImageGenerationJobRepository;
  profileRepo?: ImageProviderProfileRepository;
  runtime?: ImageGenerationRuntimeAdapter;
  persistOutput?: typeof persistImageGenerationOutput;
  publishEvent?: (event: ImageGenerationWsEvent) => void;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

export interface ImageGenerationService {
  createJob(input: ImageGenerationCreateJobInput): Promise<{
    job: ImageGenerationJob;
    outputs: ImageGenerationOutput[];
  }>;
  enqueue(jobId: string): void;
  cancelJob(jobId: string): Promise<{ job: ImageGenerationJob }>;
  cancelProjectJob(projectId: string, jobId: string): Promise<{ job: ImageGenerationJob }>;
  retryJob(jobId: string): Promise<{ job: ImageGenerationJob }>;
  retryProjectJob(projectId: string, jobId: string): Promise<{ job: ImageGenerationJob }>;
  runJob(jobId: string, signal: AbortSignal): Promise<void>;
  waitForCompletion(jobId: string): Promise<{
    job: ImageGenerationJob;
    outputs: ImageGenerationOutput[];
  }>;
  waitForProjectJobCompletion(projectId: string, jobId: string): Promise<{
    job: ImageGenerationJob;
    outputs: ImageGenerationOutput[];
  }>;
  snapshot(): ReturnType<ImageGenerationQueue['snapshot']>;
}

export function createImageGenerationService(deps: ImageGenerationServiceDeps = {}): ImageGenerationService {
  const queue = new ImageGenerationQueue((jobId, signal) => runJob(jobId, signal, deps));

  return {
    createJob: (input) => createJob(input, queue, deps),
    enqueue: (jobId) => queue.enqueue(jobId),
    cancelJob: (jobId) => cancelJob(jobId, queue, deps),
    cancelProjectJob: (projectId, jobId) => cancelProjectJob(projectId, jobId, queue, deps),
    retryJob: (jobId) => retryJob(jobId, queue, deps),
    retryProjectJob: (projectId, jobId) => retryProjectJob(projectId, jobId, queue, deps),
    runJob: (jobId, signal) => runJob(jobId, signal, deps),
    waitForCompletion: (jobId) => waitForCompletion(jobId, deps),
    waitForProjectJobCompletion: (projectId, jobId) => waitForProjectJobCompletion(projectId, jobId, deps),
    snapshot: () => queue.snapshot(),
  };
}

export const imageGenerationService = createImageGenerationService();

async function createJob(
  input: ImageGenerationCreateJobInput,
  queue: ImageGenerationQueue,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob; outputs: ImageGenerationOutput[] }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  assertValidImageCount(input.count);
  const sourceFiles = resolveSourceFiles(input);
  const { source_file_ids: _sourceFileIds, ...jobInput } = input;
  const job = jobRepo.create(jobInput);
  sourceFiles.forEach((file, index) => {
    jobRepo.addSourceImage({
      job_id: job.id,
      file_id: file.id,
      slot: index + 1,
      url: file.url,
    });
  });
  publishJobEvent(deps, 'image_job:created', job);
  queue.enqueue(job.id);
  return { job, outputs: jobRepo.listOutputs(job.id) };
}

async function cancelJob(
  jobId: string,
  queue: ImageGenerationQueue,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  const job = requireJob(jobRepo, jobId);

  if (job.status === 'queued') {
    queue.cancel(jobId);
    const canceled = jobRepo.markCanceled(jobId, CANCELED_MESSAGE);
    publishJobEvent(deps, 'image_job:canceled', canceled);
    return { job: canceled };
  }

  if (job.status === 'running' || job.status === 'canceling') {
    if (!queue.isRunning(jobId)) {
      throw new Error('image generation running job is not managed by the image generation queue');
    }
    const canceling = job.status === 'canceling' ? job : jobRepo.markCanceling(jobId);
    publishJobEvent(deps, 'image_job:updated', canceling);
    queue.cancel(jobId);
    return { job: canceling };
  }

  return { job };
}

async function cancelProjectJob(
  projectId: string,
  jobId: string,
  queue: ImageGenerationQueue,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  requireProjectJob(jobRepo, projectId, jobId);
  return cancelJob(jobId, queue, deps);
}

async function retryJob(
  jobId: string,
  queue: ImageGenerationQueue,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  const sourceJob = requireJob(jobRepo, jobId);
  if (!['completed', 'failed', 'canceled'].includes(sourceJob.status)) {
    throw new Error('image generation job is not retryable');
  }
  assertValidImageCount(sourceJob.count);

  const retried = jobRepo.create({
    project_id: sourceJob.project_id,
    room_id: sourceJob.room_id,
    session_id: sourceJob.session_id,
    source_message_id: sourceJob.source_message_id,
    source_agent_id: sourceJob.source_agent_id,
    source_task_id: sourceJob.source_task_id,
    provider_profile_id: sourceJob.provider_profile_id,
    workflow: sourceJob.workflow,
    prompt: sourceJob.prompt,
    count: sourceJob.count,
    quality: sourceJob.quality,
    size: sourceJob.size,
  });

  for (const source of jobRepo.listSourceImages(sourceJob.id)) {
    jobRepo.addSourceImage({
      job_id: retried.id,
      file_id: source.file_id,
      slot: source.slot,
      url: source.url,
      origin_job_id: source.origin_job_id,
      origin_output_id: source.origin_output_id,
    });
  }

  publishJobEvent(deps, 'image_job:created', retried);
  queue.enqueue(retried.id);
  return { job: retried };
}

async function retryProjectJob(
  projectId: string,
  jobId: string,
  queue: ImageGenerationQueue,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  requireProjectJob(jobRepo, projectId, jobId);
  return retryJob(jobId, queue, deps);
}

async function runJob(jobId: string, signal: AbortSignal, deps: ImageGenerationServiceDeps): Promise<void> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  let job = requireJob(jobRepo, jobId);
  if (job.status !== 'queued') return;

  let profile: ImageProviderProfileWithSecret | undefined;
  try {
    throwIfAborted(signal);
    assertValidImageCount(job.count);
    const running = jobRepo.markRunningIfQueued(jobId);
    if (!running) return;
    job = running;
    publishJobEvent(deps, 'image_job:updated', job);

    profile = requireProviderProfile(deps, job);
    const sourceImages = job.workflow === 'image-to-image' ? await loadRuntimeSourceImages(jobRepo, job) : [];
    const outputCount = await runProviderRequests({
      job,
      profile,
      signal,
      sourceImages,
      deps,
    });

    if (outputCount === 0) {
      throw new Error('图片生成未返回图片');
    }

    throwIfAborted(signal);
    const completed = jobRepo.markCompleted(jobId, `已生成 ${outputCount} 张图片。`);
    publishCompletedEvent(deps, completed, jobRepo.listOutputs(jobId));
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      const canceled = jobRepo.markCanceled(jobId, CANCELED_MESSAGE);
      publishJobEvent(deps, 'image_job:canceled', canceled);
      return;
    }

    const failed = jobRepo.markFailed(jobId, normalizeServiceError(error, profile?.api_key ?? ''));
    publishJobEvent(deps, 'image_job:failed', failed);
  }
}

async function waitForCompletion(
  jobId: string,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob; outputs: ImageGenerationOutput[] }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  const timeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const job = requireJob(jobRepo, jobId);
    if (isTerminalStatus(job.status)) {
      return { job, outputs: jobRepo.listOutputs(jobId) };
    }
    await sleep(pollIntervalMs);
  }

  throw new Error('image generation job wait timeout');
}

async function waitForProjectJobCompletion(
  projectId: string,
  jobId: string,
  deps: ImageGenerationServiceDeps,
): Promise<{ job: ImageGenerationJob; outputs: ImageGenerationOutput[] }> {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  requireProjectJob(jobRepo, projectId, jobId);
  return waitForCompletion(jobId, deps);
}

async function runProviderRequests(input: {
  job: ImageGenerationJob;
  profile: ImageProviderProfileWithSecret;
  signal: AbortSignal;
  sourceImages: ImageGenerationRuntimeSourceImage[];
  deps: ImageGenerationServiceDeps;
}): Promise<number> {
  const { job, profile, signal, sourceImages, deps } = input;
  const requestedCounts = profile.supports_count_parameter ? [job.count] : Array.from({ length: job.count }, () => 1);
  let outputCount = 0;

  for (const requestCount of requestedCounts) {
    throwIfAborted(signal);
    const response = await callRuntime({
      job,
      profile,
      count: requestCount,
      sourceImages,
      signal,
      deps,
    });

    for (const image of response.images) {
      throwIfAborted(signal);
      if (outputCount >= job.count) return outputCount;
      outputCount += 1;
      const { output } = await persistOutput(job, outputCount, image, deps);
      publishOutputEvent(deps, job, output);
    }
  }

  return outputCount;
}

async function callRuntime(input: {
  job: ImageGenerationJob;
  profile: ImageProviderProfileWithSecret;
  count: number;
  sourceImages: ImageGenerationRuntimeSourceImage[];
  signal: AbortSignal;
  deps: ImageGenerationServiceDeps;
}): Promise<ImageGenerationRuntimeResponse> {
  const { job, profile, count, sourceImages, signal, deps } = input;
  const request: ImageGenerationServiceRuntimeRequest = {
    jobId: job.id,
    profileId: profile.id,
    workflow: job.workflow,
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    model: profile.model,
    prompt: job.prompt,
    count,
    quality: job.quality,
    size: job.size,
    signal,
    sourceImages,
  };

  const runtime = deps.runtime ?? defaultRuntime;
  return runtime(request);
}

async function defaultRuntime(request: ImageGenerationServiceRuntimeRequest): Promise<ImageGenerationRuntimeResponse> {
  if (request.workflow === 'image-to-image') {
    return requestOpenAICompatibleImageEdit({
      baseUrl: request.baseUrl,
      apiKey: request.apiKey,
      model: request.model,
      prompt: request.prompt,
      count: request.count,
      quality: request.quality,
      size: request.size,
      signal: request.signal,
      sourceImages: request.sourceImages,
    });
  }

  return requestOpenAICompatibleImageGeneration({
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    model: request.model,
    prompt: request.prompt,
    count: request.count,
    quality: request.quality,
    size: request.size,
    signal: request.signal,
  });
}

async function persistOutput(
  job: ImageGenerationJob,
  slot: number,
  image: ImageGenerationRuntimeImage,
  deps: ImageGenerationServiceDeps,
): Promise<{ output: ImageGenerationOutput }> {
  const persist = deps.persistOutput ?? persistImageGenerationOutput;
  return persist({
    projectId: job.project_id,
    jobId: job.id,
    slot,
    image,
  });
}

async function loadRuntimeSourceImages(
  jobRepo: ImageGenerationJobRepository,
  job: ImageGenerationJob,
): Promise<ImageGenerationRuntimeSourceImage[]> {
  const sourceImages = jobRepo.listSourceImages(job.id);
  const runtimeImages: ImageGenerationRuntimeSourceImage[] = [];

  for (const sourceImage of sourceImages) {
    const file = fileRepo.get(sourceImage.file_id);
    if (!file || file.project_id !== job.project_id || file.deleted_at !== null) {
      throw new Error('image generation source image file not found');
    }
    runtimeImages.push({
      data: await readFile(file.storage_path),
      mimeType: file.mime_type,
      name: file.original_name,
    });
  }

  return runtimeImages;
}

function requireJob(jobRepo: ImageGenerationJobRepository, jobId: string): ImageGenerationJob {
  const job = jobRepo.get(jobId);
  if (!job) throw new Error('image generation job not found');
  return job;
}

function requireProjectJob(
  jobRepo: ImageGenerationJobRepository,
  projectId: string,
  jobId: string,
): ImageGenerationJob {
  const job = requireJob(jobRepo, jobId);
  if (job.project_id !== projectId) {
    throw new Error('image generation job project mismatch');
  }
  return job;
}

function requireProviderProfile(
  deps: ImageGenerationServiceDeps,
  job: ImageGenerationJob,
): ImageProviderProfileWithSecret {
  const profileRepo = deps.profileRepo ?? imageProviderProfileRepo;
  const profile = profileRepo.getForProject(job.project_id, job.provider_profile_id);
  if (!profile) throw new Error('image provider profile not found');
  return profile;
}

function publishJobEvent(
  deps: ImageGenerationServiceDeps,
  type: Extract<ImageGenerationWsEvent['type'], 'image_job:created' | 'image_job:updated' | 'image_job:failed' | 'image_job:canceled'>,
  job: ImageGenerationJob,
): void {
  publish(deps, {
    type,
    projectId: job.project_id,
    sessionId: job.session_id,
    roomId: job.room_id,
    job,
  } as ImageGenerationWsEvent);
}

function publishOutputEvent(
  deps: ImageGenerationServiceDeps,
  job: ImageGenerationJob,
  output: ImageGenerationOutput,
): void {
  publish(deps, {
    type: 'image_job:output_added',
    projectId: job.project_id,
    sessionId: job.session_id,
    roomId: job.room_id,
    jobId: job.id,
    output,
  });
}

function publishCompletedEvent(
  deps: ImageGenerationServiceDeps,
  job: ImageGenerationJob,
  outputs: ImageGenerationOutput[],
): void {
  publish(deps, {
    type: 'image_job:completed',
    projectId: job.project_id,
    sessionId: job.session_id,
    roomId: job.room_id,
    job,
    outputs,
  });
}

function publish(deps: ImageGenerationServiceDeps, event: ImageGenerationWsEvent): void {
  try {
    deps.publishEvent?.(event);
  } catch {
    // Event delivery must not corrupt durable job state.
  }
}

function isTerminalStatus(status: ImageGenerationJob['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function assertValidImageCount(count: number): void {
  if (!Number.isInteger(count) || count < MIN_IMAGE_COUNT || count > MAX_IMAGE_COUNT) {
    throw new Error(`image generation count must be an integer between ${MIN_IMAGE_COUNT} and ${MAX_IMAGE_COUNT}`);
  }
}

function resolveSourceFiles(input: ImageGenerationCreateJobInput): ProjectFile[] {
  const sourceFileIds = input.source_file_ids ?? [];
  if (input.workflow === 'image-to-image' && sourceFileIds.length === 0) {
    throw new Error('image-to-image workflow requires at least one source image');
  }
  if (input.workflow !== 'image-to-image' && sourceFileIds.length > 0) {
    throw new Error('source images are only supported for image-to-image workflow');
  }
  if (sourceFileIds.length === 0) return [];

  return sourceFileIds.map((fileId) => {
    const file = fileRepo.get(fileId);
    if (!file) throw new Error('image generation source file not found');
    if (file.deleted_at !== null) throw new Error('image generation source file not found');
    if (file.project_id !== input.project_id) {
      throw new Error('image generation source file project mismatch');
    }
    if (!file.mime_type.toLowerCase().startsWith('image/')) {
      throw new Error('image generation source file must be an image');
    }
    return file;
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('aborted');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeServiceError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw || '图片生成失败';
  if (apiKey) {
    message = message.split(apiKey).join('[REDACTED_CREDENTIAL]');
  }
  return message
    .replace(/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_CREDENTIAL]')
    .replace(/\bapi[_-]?key\s*=\s*[^&\s]+/gi, 'api_key=[REDACTED_CREDENTIAL]');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
