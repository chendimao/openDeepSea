import multer from 'multer';
import { mkdir, unlink } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import type { MessageAttachmentMetadata } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const MAX_MESSAGE_FILES = 5;
export const MAX_MESSAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const messageUploadDir = join(__dirname, '..', 'data', 'uploads', 'messages');
export const messageUploadRoute = '/uploads/messages';

const allowedMessageUploadMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
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
