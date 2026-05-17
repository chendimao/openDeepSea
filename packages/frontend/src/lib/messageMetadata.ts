import type {
  CollaborationDecision,
  CollaborationIntent,
  CollaborationMode,
  CollaborationProblemArea,
  CollaborationStage,
  MessageAttachmentMetadata,
  MessageMetadata,
  TaskCreatedFrom,
  TaskEventType,
} from './types';

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
const collaborationIntents = new Set<CollaborationIntent>(['question', 'analysis', 'implementation']);
const collaborationModes = new Set<CollaborationMode>(['chat_collaboration', 'formal_workflow']);
const collaborationProblemAreas = new Set<CollaborationProblemArea>(['frontend', 'backend', 'fullstack', 'unknown']);
const collaborationStages = new Set<CollaborationStage>(['execute', 'review', 'acceptance', 'summary']);

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
    const collaboration = sanitizeCollaborationDecisionMetadata(parsed);
    return { attachments, ...taskEvent, ...collaboration };
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

function sanitizeCollaborationDecisionMetadata(value: Record<string, unknown>) {
  const eventType = typeof value.event_type === 'string' ? value.event_type : undefined;
  const decision = eventType === 'collaboration_decision'
    ? sanitizeCollaborationDecision(value.collaboration_decision)
    : null;
  if (!decision) return {};

  return {
    source_message_id: typeof value.source_message_id === 'string' ? value.source_message_id : undefined,
    fallback_agent_id: typeof value.fallback_agent_id === 'string' ? value.fallback_agent_id : undefined,
    collaboration_decision: decision,
  };
}

function sanitizeCollaborationDecision(value: unknown): CollaborationDecision | null {
  if (!isRecord(value)) return null;
  if (
    !isCollaborationIntent(value.intent) ||
    !isCollaborationMode(value.recommendedMode) ||
    !isCollaborationProblemArea(value.problemArea) ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    typeof value.rationale !== 'string' ||
    !value.rationale.trim() ||
    typeof value.needsUserChoice !== 'boolean'
  ) {
    return null;
  }

  const proposedAgents = sanitizeProposedAgents(value.proposedAgents);
  const stages = sanitizeCollaborationStages(value.stages);
  if (!proposedAgents || !stages) return null;

  return {
    intent: value.intent,
    recommendedMode: value.recommendedMode,
    problemArea: value.problemArea,
    summary: value.summary,
    rationale: value.rationale,
    needsUserChoice: value.needsUserChoice,
    proposedAgents,
    stages,
  };
}

function sanitizeProposedAgents(value: unknown): CollaborationDecision['proposedAgents'] | null {
  if (!isRecord(value)) return null;
  const executors = sanitizeStringArray(value.executors);
  const reviewers = sanitizeStringArray(value.reviewers);
  const testers = sanitizeStringArray(value.testers);
  const acceptors = sanitizeStringArray(value.acceptors);
  if (!executors || !reviewers || !testers || !acceptors) return null;
  return { executors, reviewers, testers, acceptors };
}

function sanitizeCollaborationStages(value: unknown): CollaborationDecision['stages'] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const stages = value.map((stage) => {
    if (!isRecord(stage)) return null;
    if (!isCollaborationStage(stage.stage) || typeof stage.parallel !== 'boolean') return null;
    const agentIds = sanitizeStringArray(stage.agentIds);
    if (!agentIds || typeof stage.goal !== 'string' || !stage.goal.trim()) return null;
    return {
      stage: stage.stage,
      agentIds,
      parallel: stage.parallel,
      goal: stage.goal,
    };
  });
  if (stages.some((stage) => stage === null)) return null;
  return stages as CollaborationDecision['stages'];
}

function sanitizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length === value.length ? strings : null;
}

function isCollaborationIntent(value: unknown): value is CollaborationIntent {
  return typeof value === 'string' && collaborationIntents.has(value as CollaborationIntent);
}

function isCollaborationMode(value: unknown): value is CollaborationMode {
  return typeof value === 'string' && collaborationModes.has(value as CollaborationMode);
}

function isCollaborationProblemArea(value: unknown): value is CollaborationProblemArea {
  return typeof value === 'string' && collaborationProblemAreas.has(value as CollaborationProblemArea);
}

function isCollaborationStage(value: unknown): value is CollaborationStage {
  return typeof value === 'string' && collaborationStages.has(value as CollaborationStage);
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
