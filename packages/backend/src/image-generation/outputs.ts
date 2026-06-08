import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../db.js';
import { fileRepo } from '../repos/files.js';
import {
  buildProjectFileUrl,
  ensureProjectFileUploadDir,
  safeUploadFileName,
} from '../uploads.js';
import type { ProjectFile } from '../types.js';
import type { ImageGenerationOutput } from './types.js';
import { imageGenerationJobRepo } from './jobs.js';

export interface PersistImageGenerationOutputInput {
  projectId: string;
  jobId: string;
  slot: number;
  image: {
    data: Buffer | Uint8Array;
    mimeType: string;
    width?: number | null;
    height?: number | null;
  };
}

export async function persistImageGenerationOutput(input: PersistImageGenerationOutputInput): Promise<{
  file: ProjectFile;
  output: ImageGenerationOutput;
}> {
  const job = imageGenerationJobRepo.get(input.jobId);
  if (!job) throw new Error('image generation job not found');
  if (job.project_id !== input.projectId) {
    throw new Error('image generation job project mismatch');
  }

  const uploadDir = await ensureProjectFileUploadDir(input.projectId);
  const extension = extensionFromMimeType(input.image.mimeType);
  const storedName = safeUploadFileName(`image-${input.slot}.${extension}`);
  const storagePath = join(uploadDir, storedName);
  await writeFile(storagePath, input.image.data);

  try {
    return persistOutputRecord({
      input,
      extension,
      storedName,
      storagePath,
    });
  } catch (error) {
    await unlink(storagePath).catch(() => {});
    throw error;
  }
}

const persistOutputRecord = db.transaction((params: {
  input: PersistImageGenerationOutputInput;
  extension: string;
  storedName: string;
  storagePath: string;
}): {
  file: ProjectFile;
  output: ImageGenerationOutput;
} => {
  const { input, extension, storedName, storagePath } = params;
  const file = fileRepo.create({
    project_id: input.projectId,
    original_name: `generated-image-${input.slot}.${extension}`,
    stored_name: storedName,
    mime_type: input.image.mimeType,
    size: input.image.data.byteLength,
    url: buildProjectFileUrl(input.projectId, storedName),
    storage_path: storagePath,
    uploaded_by_id: 'image-generation',
    uploaded_by_name: '图片生成',
  });
  const output = imageGenerationJobRepo.appendOutput({
    job_id: input.jobId,
    file_id: file.id,
    slot: input.slot,
    name: file.original_name,
    url: file.url,
    mime_type: file.mime_type,
    size: file.size,
    width: input.image.width ?? null,
    height: input.image.height ?? null,
  });
  return { file, output };
});

export function extensionFromMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'image/bmp':
      return 'bmp';
    case 'image/tiff':
      return 'tiff';
    default:
      return 'bin';
  }
}
