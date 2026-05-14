import multer from 'multer';
import { mkdir, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import type { MessageAttachmentMetadata } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export const MAX_MESSAGE_FILES = 5;
export const MAX_MESSAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const messageUploadDir = join(__dirname, '..', 'data', 'uploads', 'messages');
export const messageUploadRoute = '/uploads/messages';

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
    destination: (_req, _file, callback) => {
      callback(null, messageUploadDir);
    },
    filename: (_req, file, callback) => {
      callback(null, safeUploadFileName(file.originalname));
    },
  }),
  limits: {
    files: MAX_MESSAGE_FILES,
    fileSize: MAX_MESSAGE_FILE_SIZE_BYTES,
  },
});

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

export async function cleanupUploadedFiles(files: Express.Multer.File[]): Promise<void> {
  await Promise.allSettled(files.map((file) => unlink(file.path)));
}
