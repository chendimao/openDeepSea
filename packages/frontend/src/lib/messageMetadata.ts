import type { MessageAttachmentMetadata, MessageMetadata } from './types';

const allowedAttachmentUrlPrefix = '/uploads/messages/';

function createEmptyMessageMetadata(): MessageMetadata {
  return { attachments: [] };
}

export function parseMessageMetadata(metadata: string | null): MessageMetadata {
  if (!metadata) return createEmptyMessageMetadata();

  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!isRecord(parsed)) return createEmptyMessageMetadata();

    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments
        .map(sanitizeMessageAttachmentMetadata)
        .filter((attachment): attachment is MessageAttachmentMetadata => attachment !== null)
      : [];

    return { attachments };
  } catch {
    return createEmptyMessageMetadata();
  }
}

function sanitizeMessageAttachmentMetadata(value: unknown): MessageAttachmentMetadata | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.url !== 'string' ||
    typeof value.isImage !== 'boolean'
  ) {
    return null;
  }
  const safeUrl = sanitizeAttachmentUrl(value.url);
  if (!safeUrl) return null;

  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    url: safeUrl,
    isImage: value.isImage,
  };
}

function sanitizeAttachmentUrl(url: string): string | null {
  if (!url.startsWith(allowedAttachmentUrlPrefix)) return null;

  try {
    const origin = globalThis.location?.origin ?? 'http://localhost';
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return null;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.search || parsed.hash) return null;
    if (!parsed.pathname.startsWith(allowedAttachmentUrlPrefix)) return null;
    const decodedPathname = safeDecodeURIComponent(parsed.pathname);
    if (decodedPathname.includes('/../') || decodedPathname.endsWith('/..')) return null;
    const hasTraversal = parsed.pathname
      .split('/')
      .some((segment) => {
        const decoded = safeDecodeURIComponent(segment);
        return decoded === '..' || decoded.includes('/') || decoded.includes('\\');
      });
    if (hasTraversal) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
