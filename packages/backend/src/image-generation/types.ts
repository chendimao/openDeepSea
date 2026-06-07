export type ImageGenerationWorkflow = 'generate' | 'image-to-image';
export type ImageGenerationStatus = 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'canceled';
export type ImageProviderCompatProfileId = 'openai' | 'openai-sdk' | 'images-edits' | 'chat-completions';

export interface ImageProviderProfile {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  compat_profile_id: ImageProviderCompatProfileId;
  supports_count_parameter: 0 | 1;
  active: 0 | 1;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export type ImageProviderProfileWithSecret = ImageProviderProfile;

export type SafeImageProviderProfile = Omit<ImageProviderProfile, 'api_key'> & {
  has_api_key: 0 | 1;
};

export interface ImageProviderProfileInput {
  name: string;
  base_url: string;
  api_key?: string | null;
  model: string;
  compat_profile_id?: ImageProviderCompatProfileId;
  supports_count_parameter?: boolean;
}

export interface ImageGenerationJob {
  id: string;
  project_id: string;
  room_id: string | null;
  session_id: string | null;
  source_message_id: string | null;
  source_agent_id: string | null;
  source_task_id: string | null;
  provider_profile_id: string;
  workflow: ImageGenerationWorkflow;
  prompt: string;
  count: number;
  quality: string;
  size: string;
  status: ImageGenerationStatus;
  message: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface ImageGenerationOutput {
  id: string;
  job_id: string;
  file_id: string;
  slot: number;
  name: string;
  url: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface ImageGenerationSourceImage {
  id: string;
  job_id: string;
  file_id: string;
  slot: number;
  url: string;
  origin_job_id: string | null;
  origin_output_id: string | null;
  created_at: number;
}

export interface ImageGenerationJobCreateInput {
  project_id: string;
  room_id?: string | null;
  session_id?: string | null;
  source_message_id?: string | null;
  source_agent_id?: string | null;
  source_task_id?: string | null;
  provider_profile_id: string;
  workflow: ImageGenerationWorkflow;
  prompt: string;
  count: number;
  quality: string;
  size: string;
}

export interface ImageGenerationOutputCreateInput {
  job_id: string;
  file_id: string;
  slot: number;
  name: string;
  url: string;
  mime_type: string;
  size: number;
  width?: number | null;
  height?: number | null;
}

export interface ImageGenerationSourceImageCreateInput {
  job_id: string;
  file_id: string;
  slot: number;
  url: string;
  origin_job_id?: string | null;
  origin_output_id?: string | null;
}

export type ImageGenerationWsEvent =
  | {
      type: 'image_job:created';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
    }
  | {
      type: 'image_job:updated';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
    }
  | {
      type: 'image_job:output_added';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      jobId: string;
      output: ImageGenerationOutput;
    }
  | {
      type: 'image_job:completed';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
      outputs: ImageGenerationOutput[];
    }
  | {
      type: 'image_job:failed';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
    }
  | {
      type: 'image_job:canceled';
      projectId: string;
      sessionId?: string | null;
      roomId?: string | null;
      job: ImageGenerationJob;
    };
