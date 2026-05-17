import type { MessageAttachmentMetadata, MessageMetadata, TaskCreatedFrom, TaskEventType } from './types';

const messageAttachmentUrlPrefix = '/uploads/messages/';
const projectFileAttachmentUrlPrefix = '/uploads/files/';
const taskEventTypes = new Set<TaskEventType>([
  'plan_proposed',
  'task_created',
  'task_updated',
  'task_status_changed',
  'workflow_started',
  'workflow_stage_changed',
  'workflow_plan_ready',
  'workflow_assignment_created',
  'workflow_blocked',
  'workflow_completed',
  'workflow_cancelled',
  'workflow_failed',
  'workflow_memory_written',
]);
const taskOrigins = new Set<TaskCreatedFrom>(['manual', 'chat_plan', 'slash_command', 'workflow_assignment']);

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

    const taskEvent = sanitizeTaskEventMetadata(parsed);
    return { attachments, ...taskEvent };
  } catch {
    return createEmptyMessageMetadata();
  }
}

function sanitizeTaskEventMetadata(value: Record<string, unknown>) {
  const eventType = typeof value.event_type === 'string' && isTaskEventType(value.event_type)
    ? value.event_type
    : undefined;
  const origin = typeof value.origin === 'string' && isTaskOrigin(value.origin)
    ? value.origin
    : undefined;

  return {
    task_id: typeof value.task_id === 'string' ? value.task_id : undefined,
    task_title: typeof value.task_title === 'string' ? value.task_title : undefined,
    workflow_run_id: typeof value.workflow_run_id === 'string' ? value.workflow_run_id : undefined,
    workflow_step_id: typeof value.workflow_step_id === 'string' ? value.workflow_step_id : undefined,
    event_type: eventType,
    origin,
  };
}

function isTaskEventType(value: string): value is TaskEventType {
  return taskEventTypes.has(value as TaskEventType);
}

function isTaskOrigin(value: string): value is TaskCreatedFrom {
  return taskOrigins.has(value as TaskCreatedFrom);
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
    fileId: typeof value.fileId === 'string' ? value.fileId : undefined,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    url: safeUrl,
    isImage: value.isImage,
    deleted: typeof value.deleted === 'boolean' ? value.deleted : undefined,
  };
}

function sanitizeAttachmentUrl(url: string): string | null {
  if (!url.startsWith(messageAttachmentUrlPrefix) && !url.startsWith(projectFileAttachmentUrlPrefix)) return null;

  try {
    const origin = globalThis.location?.origin ?? 'http://localhost';
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return null;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.search || parsed.hash) return null;
    if (!isAllowedAttachmentPathname(parsed.pathname)) return null;
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

function isAllowedAttachmentPathname(pathname: string): boolean {
  if (pathname.startsWith(messageAttachmentUrlPrefix)) {
    const relativePath = pathname.slice(messageAttachmentUrlPrefix.length);
    return Boolean(relativePath) && !relativePath.includes('/');
  }

  if (pathname.startsWith(projectFileAttachmentUrlPrefix)) {
    const relativePath = pathname.slice(projectFileAttachmentUrlPrefix.length);
    const parts = relativePath.split('/');
    return parts.length === 2 && parts.every(Boolean);
  }

  return false;
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
