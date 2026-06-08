import type { SessionToolDefinition } from '../acp/types.js';
import type { Session } from '../types.js';
import {
  imageProviderProfileRepo,
  type ImageProviderProfileRepository,
} from './provider-profiles.js';
import {
  imageGenerationService,
  type ImageGenerationService,
} from './service.js';
import type {
  ImageGenerationStatus,
  ImageGenerationWorkflow,
} from './types.js';

const DEFAULT_IMAGE_COUNT = 1;
const DEFAULT_IMAGE_QUALITY = 'auto';
const DEFAULT_IMAGE_SIZE = 'auto';

export interface GenerateImageToolInput {
  project_id: string;
  session_id?: string | null;
  room_id?: string | null;
  task_id?: string | null;
  prompt: string;
  workflow: ImageGenerationWorkflow;
  source_file_ids?: string[];
  count?: number;
  size?: string;
  quality?: string;
  provider_profile_id?: string | null;
}

export interface GenerateImageToolOutput {
  job_id: string;
  status: ImageGenerationStatus;
  outputs: Array<{
    file_id: string;
    resource_id: string;
    url: string;
    slot: number;
  }>;
  error: string | null;
}

export interface GenerateImageToolDeps {
  service?: ImageGenerationService;
  profileRepo?: Pick<ImageProviderProfileRepository, 'getActive' | 'getForProject'>;
  onResult?: (result: GenerateImageToolOutput) => void | Promise<void>;
}

export const generateImageToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['project_id', 'prompt', 'workflow'],
  properties: {
    project_id: { type: 'string', minLength: 1 },
    session_id: { type: ['string', 'null'] },
    room_id: { type: ['string', 'null'] },
    task_id: { type: ['string', 'null'] },
    prompt: { type: 'string', minLength: 1 },
    workflow: { type: 'string', enum: ['generate', 'image-to-image'] },
    source_file_ids: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      default: [],
    },
    count: { type: 'integer', minimum: 1, maximum: 6, default: DEFAULT_IMAGE_COUNT },
    size: { type: 'string', default: DEFAULT_IMAGE_SIZE },
    quality: { type: 'string', default: DEFAULT_IMAGE_QUALITY },
    provider_profile_id: { type: ['string', 'null'] },
  },
} satisfies Record<string, unknown>;

export const generateImageSessionToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'workflow'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    workflow: { type: 'string', enum: ['generate', 'image-to-image'] },
    source_file_ids: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      default: [],
    },
    count: { type: 'integer', minimum: 1, maximum: 6, default: DEFAULT_IMAGE_COUNT },
    size: { type: 'string', default: DEFAULT_IMAGE_SIZE },
    quality: { type: 'string', default: DEFAULT_IMAGE_QUALITY },
    provider_profile_id: { type: ['string', 'null'] },
  },
} satisfies Record<string, unknown>;

export async function runGenerateImageTool(
  input: GenerateImageToolInput,
  deps: GenerateImageToolDeps = {},
): Promise<GenerateImageToolOutput> {
  const normalized = normalizeGenerateImageToolInput(input);
  const profileId = resolveProviderProfileId(normalized, deps);
  const service = deps.service ?? imageGenerationService;

  const created = await service.createJob({
    project_id: normalized.project_id,
    session_id: normalized.session_id,
    room_id: normalized.room_id,
    source_task_id: normalized.task_id,
    provider_profile_id: profileId,
    workflow: normalized.workflow,
    prompt: normalized.prompt,
    source_file_ids: normalized.source_file_ids,
    count: normalized.count,
    size: normalized.size,
    quality: normalized.quality,
    source_agent_id: 'agent-tool',
  });
  const completed = await service.waitForCompletion(created.job.id);

  return {
    job_id: completed.job.id,
    status: completed.job.status,
    outputs: completed.outputs.map((output) => ({
      file_id: output.file_id,
      resource_id: `file:${output.file_id}`,
      url: output.url,
      slot: output.slot,
    })),
    error: completed.job.error,
  };
}

export function createGenerateImageSessionTool(
  session: Pick<Session, 'id' | 'project_id'>,
  deps: GenerateImageToolDeps = {},
): SessionToolDefinition {
  return {
    name: 'generate_image',
    description: 'Generate text-to-image or image-to-image outputs and save them as project resources.',
    input_schema: generateImageSessionToolInputSchema,
    execute: async (input) => {
      const result = await runGenerateImageTool({
        ...coerceToolRecord(input),
        project_id: session.project_id,
        session_id: session.id,
      }, deps);
      await deps.onResult?.(result);
      return result;
    },
  };
}

function normalizeGenerateImageToolInput(input: GenerateImageToolInput): Required<GenerateImageToolInput> {
  return {
    project_id: requireString(input.project_id, 'project_id'),
    session_id: optionalString(input.session_id),
    room_id: optionalString(input.room_id),
    task_id: optionalString(input.task_id),
    prompt: requireString(input.prompt, 'prompt'),
    workflow: normalizeWorkflow(input.workflow),
    source_file_ids: normalizeSourceFileIds(input.source_file_ids),
    count: normalizeCount(input.count),
    size: optionalString(input.size) ?? DEFAULT_IMAGE_SIZE,
    quality: optionalString(input.quality) ?? DEFAULT_IMAGE_QUALITY,
    provider_profile_id: optionalString(input.provider_profile_id),
  };
}

function resolveProviderProfileId(input: Required<GenerateImageToolInput>, deps: GenerateImageToolDeps): string {
  const profileRepo = deps.profileRepo ?? imageProviderProfileRepo;
  if (input.provider_profile_id) {
    const profile = profileRepo.getForProject(input.project_id, input.provider_profile_id);
    if (!profile) throw new Error('image provider profile not found');
    return profile.id;
  }

  const activeProfile = profileRepo.getActive(input.project_id);
  if (!activeProfile) throw new Error('active image provider profile not found');
  return activeProfile.id;
}

function coerceToolRecord(input: Record<string, unknown>): GenerateImageToolInput {
  return {
    project_id: optionalString(input['project_id']) ?? '',
    session_id: optionalString(input['session_id']),
    room_id: optionalString(input['room_id']),
    task_id: optionalString(input['task_id']),
    prompt: typeof input['prompt'] === 'string' ? input['prompt'] : '',
    workflow: (typeof input['workflow'] === 'string' ? input['workflow'] : '') as ImageGenerationWorkflow,
    source_file_ids: Array.isArray(input['source_file_ids'])
      ? input['source_file_ids'].filter((item): item is string => typeof item === 'string')
      : undefined,
    count: typeof input['count'] === 'number' ? input['count'] : undefined,
    size: typeof input['size'] === 'string' ? input['size'] : undefined,
    quality: typeof input['quality'] === 'string' ? input['quality'] : undefined,
    provider_profile_id: optionalString(input['provider_profile_id']),
  };
}

function requireString(value: string | null | undefined, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`generate_image ${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeWorkflow(value: ImageGenerationWorkflow): ImageGenerationWorkflow {
  if (value === 'generate' || value === 'image-to-image') return value;
  throw new Error('generate_image workflow must be generate or image-to-image');
}

function normalizeSourceFileIds(value: string[] | undefined): string[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error('generate_image source_file_ids must be an array');
  return value.map((item) => requireString(item, 'source_file_ids item'));
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_IMAGE_COUNT;
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new Error('generate_image count must be an integer between 1 and 6');
  }
  return value;
}
