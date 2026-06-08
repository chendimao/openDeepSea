import { fileRepo } from '../repos/files.js';
import type { ProjectFile } from '../types.js';
import { imageGenerationJobRepo, type ImageGenerationJobRepository } from './jobs.js';

export interface ImageSourceFile {
  slot: number;
  file: ProjectFile;
  origin_job_id: string | null;
  origin_output_id: string | null;
}

export interface ResolveImageSourceFilesDeps {
  jobRepo?: ImageGenerationJobRepository;
}

export function resolveImageSourceFiles(
  projectId: string,
  sourceFileIds: string[],
  deps: ResolveImageSourceFilesDeps = {},
): ImageSourceFile[] {
  const jobRepo = deps.jobRepo ?? imageGenerationJobRepo;
  return sourceFileIds.map((sourceFileId, index) => {
    const fileId = normalizeSourceFileId(sourceFileId);
    const file = fileRepo.get(fileId);
    if (!file || file.deleted_at !== null) {
      throw new Error('image generation source file not found');
    }
    if (file.project_id !== projectId) {
      throw new Error('image generation source file project mismatch');
    }
    if (!file.mime_type.toLowerCase().startsWith('image/')) {
      throw new Error('image generation source file must be an image');
    }

    const origin = jobRepo.findOutputByFileId(file.id);
    return {
      slot: index + 1,
      file,
      origin_job_id: origin?.job_id ?? null,
      origin_output_id: origin?.id ?? null,
    };
  });
}

function normalizeSourceFileId(fileId: string): string {
  return fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
}
