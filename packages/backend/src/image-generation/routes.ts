import { Router, type Response as ExpressResponse } from 'express';
import { z } from 'zod';
import { listImageProviderModels } from './provider-models.js';
import { imageProviderProfileRepo } from './provider-profiles.js';
import { imageGenerationJobRepo } from './jobs.js';
import { imagePromptPresetRepo } from './prompt-presets.js';
import {
  imageGenerationService,
  type ImageGenerationService,
} from './service.js';
import type { ImageGenerationJob, ImageGenerationStatus } from './types.js';
import { messageRepo } from '../repos/messages.js';
import { projectRepo } from '../repos/projects.js';
import { roomRepo } from '../repos/rooms.js';
import { sessionRepo } from '../repos/sessions.js';
import { taskRepo } from '../repos/tasks.js';

type ModelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ImageGenerationRouteDeps {
  service?: ImageGenerationService;
  modelFetch?: ModelFetch;
}

let routeDeps: ImageGenerationRouteDeps = {};

export function setImageGenerationRouteDeps(deps: ImageGenerationRouteDeps): void {
  routeDeps = deps;
}

export const imageGenerationRouter = Router();

const providerProfileSchema = z.object({
  name: z.string(),
  base_url: z.string(),
  api_key: z.string().nullable().optional(),
  model: z.string(),
  compat_profile_id: z.enum(['openai', 'openai-sdk', 'images-edits', 'chat-completions']).optional(),
  supports_count_parameter: z.boolean().optional(),
});

const providerModelsSchema = z.object({
  profile_id: z.string().min(1),
});

const imageJobCreateSchema = z.object({
  room_id: z.string().min(1).nullable().optional(),
  session_id: z.string().min(1).nullable().optional(),
  source_message_id: z.string().min(1).nullable().optional(),
  source_agent_id: z.string().min(1).nullable().optional(),
  source_task_id: z.string().min(1).nullable().optional(),
  provider_profile_id: z.string().min(1).nullable().optional(),
  workflow: z.enum(['generate', 'image-to-image']),
  prompt: z.string().trim().min(1).max(8000),
  count: z.number().int().min(1).max(6),
  quality: z.string().trim().min(1).optional().default('auto'),
  size: z.string().trim().min(1).optional().default('auto'),
  source_file_ids: z.array(z.string().min(1)).optional().default([]),
});

const imageJobListQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'canceling', 'completed', 'failed', 'canceled']).optional(),
  sessionId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
});

const imageJobGroupQuerySchema = z.object({
  groupBy: z.enum(['prompt', 'task', 'session']).default('prompt'),
});

const imagePromptPresetListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
});

const imagePromptPresetSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000),
});

imageGenerationRouter.get('/projects/:projectId/image-provider-profiles', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  res.json(imageProviderProfileRepo.list(projectId));
});

imageGenerationRouter.post('/projects/:projectId/image-provider-profiles', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = providerProfileSchema.safeParse(req.body);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  try {
    res.status(201).json(imageProviderProfileRepo.create(projectId, parsed.data));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.patch('/projects/:projectId/image-provider-profiles/:profileId', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = providerProfileSchema.safeParse(req.body);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  try {
    res.json(imageProviderProfileRepo.update(projectId, req.params.profileId, parsed.data));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.delete('/projects/:projectId/image-provider-profiles/:profileId', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const deleted = imageProviderProfileRepo.softDelete(projectId, req.params.profileId);
  if (!deleted) return res.status(404).json({ error: 'provider profile not found' });
  res.json(deleted);
});

imageGenerationRouter.post('/projects/:projectId/image-provider-profiles/:profileId/activate', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;

  try {
    res.json(imageProviderProfileRepo.activate(projectId, req.params.profileId));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.post('/projects/:projectId/image-provider-profiles/models', async (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = providerModelsSchema.safeParse(req.body);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  try {
    const profile = imageProviderProfileRepo.getForProject(projectId, parsed.data.profile_id);
    if (!profile) {
      res.status(404).json({ error: 'image provider profile not found' });
      return;
    }
    res.json(await listImageProviderModels({
      baseUrl: profile.base_url,
      apiKey: profile.api_key,
      fetchImpl: routeDeps.modelFetch,
    }));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.get('/projects/:projectId/image-jobs', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = imageJobListQuerySchema.safeParse(req.query);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  res.json({
    jobs: imageGenerationJobRepo.listByProject(projectId, {
      status: parsed.data.status as ImageGenerationStatus | undefined,
      sessionId: parsed.data.sessionId,
      roomId: parsed.data.roomId,
    }),
  });
});

imageGenerationRouter.get('/projects/:projectId/image-jobs/groups', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = imageJobGroupQuerySchema.safeParse(req.query);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  res.json(imageGenerationJobRepo.listGroupsByProject(projectId, parsed.data.groupBy));
});

imageGenerationRouter.post('/projects/:projectId/image-jobs', async (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = imageJobCreateSchema.safeParse(req.body);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  try {
    assertRoomBelongsToProject(projectId, parsed.data.room_id ?? null);
    assertSessionBelongsToProject(projectId, parsed.data.session_id ?? null);
    assertSourceMessageBelongsToProject(projectId, parsed.data.source_message_id ?? null);
    assertSourceTaskBelongsToProject(projectId, parsed.data.source_task_id ?? null);
    const providerProfileId = resolveProviderProfileId(projectId, parsed.data.provider_profile_id ?? null);
    const result = await getService().createJob({
      project_id: projectId,
      room_id: parsed.data.room_id ?? null,
      session_id: parsed.data.session_id ?? null,
      source_message_id: parsed.data.source_message_id ?? null,
      source_agent_id: parsed.data.source_agent_id ?? null,
      source_task_id: parsed.data.source_task_id ?? null,
      provider_profile_id: providerProfileId,
      workflow: parsed.data.workflow,
      prompt: parsed.data.prompt,
      count: parsed.data.count,
      quality: parsed.data.quality,
      size: parsed.data.size,
      source_file_ids: parsed.data.source_file_ids,
    });
    res.status(202).json(result);
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.get('/projects/:projectId/image-jobs/:jobId', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const job = requireProjectJob(projectId, req.params.jobId, res);
  if (!job) return;

  res.json({
    job,
    outputs: imageGenerationJobRepo.listOutputs(job.id),
    source_images: imageGenerationJobRepo.listSourceImages(job.id),
  });
});

imageGenerationRouter.post('/projects/:projectId/image-jobs/:jobId/cancel', async (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;

  try {
    res.json(await getService().cancelProjectJob(projectId, req.params.jobId));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.post('/projects/:projectId/image-jobs/:jobId/retry', async (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;

  try {
    res.status(202).json(await getService().retryProjectJob(projectId, req.params.jobId));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.delete('/projects/:projectId/image-jobs/:jobId', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  res.status(405).json({ error: 'image generation job deletion is not supported' });
});

imageGenerationRouter.get('/projects/:projectId/image-prompt-presets', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = imagePromptPresetListQuerySchema.safeParse(req.query);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  res.json(imagePromptPresetRepo.list(projectId, { query: parsed.data.q }));
});

imageGenerationRouter.post('/projects/:projectId/image-prompt-presets', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const parsed = imagePromptPresetSchema.safeParse(req.body);
  if (!parsed.success) return respondValidationError(res, parsed.error);

  try {
    res.status(201).json(imagePromptPresetRepo.create(projectId, parsed.data));
  } catch (error) {
    respondImageGenerationError(res, error);
  }
});

imageGenerationRouter.delete('/projects/:projectId/image-prompt-presets/:presetId', (req, res) => {
  const projectId = requireProject(req.params.projectId, res);
  if (!projectId) return;
  const deleted = imagePromptPresetRepo.softDelete(projectId, req.params.presetId);
  if (!deleted) return res.status(404).json({ error: 'image prompt preset not found' });
  res.json(deleted);
});

function getService(): ImageGenerationService {
  return routeDeps.service ?? imageGenerationService;
}

function requireProject(projectId: string | undefined, res: ExpressResponse): string | null {
  if (!projectId || !projectRepo.get(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return null;
  }
  return projectId;
}

function requireProjectJob(
  projectId: string,
  jobId: string | undefined,
  res: ExpressResponse,
): ImageGenerationJob | null {
  const job = jobId ? imageGenerationJobRepo.get(jobId) : undefined;
  if (!job) {
    res.status(404).json({ error: 'image generation job not found' });
    return null;
  }
  if (job.project_id !== projectId) {
    res.status(404).json({ error: 'image generation job not found' });
    return null;
  }
  return job;
}

function assertRoomBelongsToProject(projectId: string, roomId: string | null): void {
  if (!roomId) return;
  const room = roomRepo.get(roomId);
  if (!room) throw new Error('room not found');
  if (room.project_id !== projectId) throw new Error('room project mismatch');
}

function assertSessionBelongsToProject(projectId: string, sessionId: string | null): void {
  if (!sessionId) return;
  const session = sessionRepo.get(sessionId);
  if (!session) throw new Error('session not found');
  if (session.project_id !== projectId) throw new Error('session project mismatch');
}

function assertSourceMessageBelongsToProject(projectId: string, messageId: string | null): void {
  if (!messageId) return;
  const message = messageRepo.get(messageId);
  if (!message) throw new Error('source message not found');
  const room = roomRepo.get(message.room_id);
  if (!room) throw new Error('source message not found');
  if (room.project_id !== projectId) throw new Error('source message project mismatch');
}

function assertSourceTaskBelongsToProject(projectId: string, taskId: string | null): void {
  if (!taskId) return;
  const task = taskRepo.get(taskId);
  if (!task) throw new Error('source task not found');
  if (task.project_id !== projectId) throw new Error('source task project mismatch');
}

function resolveProviderProfileId(projectId: string, profileId: string | null): string {
  if (profileId) {
    const profile = imageProviderProfileRepo.getForProject(projectId, profileId);
    if (!profile) throw new Error('image provider profile not found');
    return profile.id;
  }

  const activeProfile = imageProviderProfileRepo.getActive(projectId);
  if (!activeProfile) throw new Error('active image provider profile not found');
  return activeProfile.id;
}

function respondValidationError(res: ExpressResponse, error: z.ZodError): void {
  res.status(400).json({ error: error.flatten() });
}

function respondImageGenerationError(res: ExpressResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('project mismatch')) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (message.includes('not found')) {
    res.status(404).json({ error: message });
    return;
  }
  if (
    message.includes('not retryable') ||
    message.includes('still active') ||
    message.includes('not managed by the image generation queue')
  ) {
    res.status(409).json({ error: message });
    return;
  }
  res.status(400).json({ error: message || 'image generation request failed' });
}
