import multer from 'multer';
import { mkdir, unlink } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import type { MessageAttachmentMetadata, ProjectFile } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const MAX_MESSAGE_FILES = 5;
export const MAX_MESSAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const messageUploadDir = join(__dirname, '..', 'data', 'uploads', 'messages');
export const messageUploadRoute = '/uploads/messages';
export const projectFileUploadRoot = join(__dirname, '..', 'data', 'uploads', 'files');
export const projectFileUploadRoute = '/uploads/files';

const allowedMessageUploadMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
  'application/octet-stream',
]);

export function safeUploadFileName(originalName: string): string {
  const extension = extname(originalName).slice(1).toLowerCase();
  const safeExtension = /^[a-z0-9]{1,12}$/i.test(extension) ? extension : 'bin';
  return `${Date.now()}-${nanoid(12)}.${safeExtension}`;
}

export async function ensureMessageUploadDir(): Promise<void> {
  await mkdir(messageUploadDir, { recursive: true });
}

export async function ensureProjectFileUploadRoot(): Promise<void> {
  await mkdir(projectFileUploadRoot, { recursive: true });
}

export function buildProjectFileUploadDir(projectId: string): string {
  const uploadRoot = resolve(projectFileUploadRoot);
  const uploadDir = resolve(uploadRoot, projectId);
  if (uploadDir !== uploadRoot && uploadDir.startsWith(`${uploadRoot}${sep}`)) {
    return uploadDir;
  }
  throw new Error('invalid project id for file upload path');
}

export async function ensureProjectFileUploadDir(projectId: string): Promise<string> {
  const uploadDir = buildProjectFileUploadDir(projectId);
  await mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

export function buildProjectFileUrl(projectId: string, storedName: string): string {
  return `${projectFileUploadRoute}/${encodeURIComponent(projectId)}/${encodeURIComponent(storedName)}`;
}

export const messageUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      try {
        await ensureMessageUploadDir();
        callback(null, messageUploadDir);
      } catch (err) {
        callback(err as Error, messageUploadDir);
      }
    },
    filename: (_req, file, callback) => {
      callback(null, safeUploadFileName(file.originalname));
    },
  }),
  limits: {
    files: MAX_MESSAGE_FILES,
    fileSize: MAX_MESSAGE_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    callback(null, isAllowedMessageUploadMimeType(file.mimetype));
  },
});

export const projectFileUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, callback) => {
      const projectId = String(req.params.projectId || '');
      try {
        callback(null, await ensureProjectFileUploadDir(projectId));
      } catch (err) {
        callback(err as Error, projectFileUploadRoot);
      }
    },
    filename: (_req, file, callback) => {
      callback(null, safeUploadFileName(file.originalname));
    },
  }),
  limits: {
    files: MAX_MESSAGE_FILES,
    fileSize: MAX_MESSAGE_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    callback(null, isAllowedMessageUploadMimeType(file.mimetype));
  },
});

export const roomProjectFileUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, callback) => {
      const projectId = String((req as { projectIdForUpload?: string }).projectIdForUpload || req.params.projectId || '');
      try {
        callback(null, await ensureProjectFileUploadDir(projectId));
      } catch (err) {
        callback(err as Error, projectFileUploadRoot);
      }
    },
    filename: (_req, file, callback) => {
      callback(null, safeUploadFileName(file.originalname));
    },
  }),
  limits: {
    files: MAX_MESSAGE_FILES,
    fileSize: MAX_MESSAGE_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    callback(null, isAllowedMessageUploadMimeType(file.mimetype));
  },
});

export function isAllowedMessageUploadMimeType(mimeType: string | undefined): boolean {
  return allowedMessageUploadMimeTypes.has(mimeType || 'application/octet-stream');
}

export function buildAttachmentMetadata(file: Express.Multer.File): MessageAttachmentMetadata {
  const mimeType = file.mimetype || 'application/octet-stream';
  return {
    id: nanoid(16),
    name: file.originalname,
    mimeType,
    size: file.size,
    url: `${messageUploadRoute}/${file.filename}`,
    isImage: mimeType.startsWith('image/'),
  };
}

export function buildAttachmentMetadataFromProjectFile(file: ProjectFile): MessageAttachmentMetadata {
  return {
    id: file.id,
    fileId: file.id,
    name: file.original_name,
    mimeType: file.mime_type,
    size: file.size,
    url: file.url,
    isImage: file.mime_type.startsWith('image/'),
    deleted: file.deleted_at !== null,
  };
}

export function buildProjectFileRecordInput(
  projectId: string,
  file: Express.Multer.File,
  uploader: { uploaded_by_id?: string | null; uploaded_by_name?: string | null } = {},
): Omit<ProjectFile, 'id' | 'created_at' | 'deleted_at'> {
  const mimeType = file.mimetype || 'application/octet-stream';
  return {
    project_id: projectId,
    original_name: file.originalname,
    stored_name: file.filename,
    mime_type: mimeType,
    size: file.size,
    url: buildProjectFileUrl(projectId, file.filename),
    storage_path: file.path,
    uploaded_by_id: uploader.uploaded_by_id ?? null,
    uploaded_by_name: uploader.uploaded_by_name ?? null,
  };
}

export async function cleanupUploadedFilesInDir(
  files: Express.Multer.File[] | undefined,
  rootDir: string
): Promise<void> {
  if (!files?.length) {
    return;
  }

  const uploadRoot = resolve(rootDir);
  await Promise.allSettled(
    files.map((file) => {
      const targetPath = typeof file.path === 'string' ? resolve(file.path) : '';
      const isInsideUploadRoot = targetPath === uploadRoot || targetPath.startsWith(`${uploadRoot}${sep}`);
      if (!isInsideUploadRoot) {
        return Promise.resolve();
      }
      return unlink(targetPath);
    })
  );
}

export async function cleanupUploadedFiles(files: Express.Multer.File[] | undefined): Promise<void> {
  await cleanupUploadedFilesInDir(files, messageUploadDir);
}

export async function cleanupProjectUploadedFiles(files: Express.Multer.File[] | undefined): Promise<void> {
  await cleanupUploadedFilesInDir(files, projectFileUploadRoot);
}
