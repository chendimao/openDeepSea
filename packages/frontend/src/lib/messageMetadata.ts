import type {
  AcpBackend,
  CollaborationDecision,
  CollaborationIntent,
  CollaborationMode,
  CollaborationProblemArea,
  CollaborationStage,
  AgentTimelineEvent,
  AgentTimelineEventStatus,
  AgentTimelineEventType,
  AgentTimelinePayload,
  MessageTrace,
  MessageTraceCommand,
  MessageTraceThinking,
  MessageTraceToolCall,
  MessageAttachmentMetadata,
  MessageIntent,
  MessageIntentResult,
  MessageIntentSource,
  MessageIntentSuggestedAction,
  MessageMetadata,
  MessageReplyMetadata,
  PlannerDecision,
  PlannerDecisionStep,
  PlannerExecutionMode,
  TaskExecutionIntent,
  TaskReadinessMetadata,
  TaskCreatedFrom,
  TaskEventType,
} from './types';

const messageAttachmentUrlPrefix = '/uploads/messages/';
const projectFileAttachmentUrlPrefix = '/uploads/files/';
const taskEventTypes = new Set<TaskEventType>([
  'message_routed',
  'message_route_uncertain',
  'plan_proposed',
  'task_created',
  'task_updated',
  'task_status_changed',
  'task_deleted',
  'workflow_started',
  'workflow_stage_changed',
  'workflow_plan_ready',
  'workflow_assignment_created',
  'workflow_blocked',
  'workflow_recovery_decided',
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
const plannerExecutionModes = new Set<PlannerExecutionMode>(['pause_after_suggestion', 'auto_continue', 'dispatch_next']);
const plannerDecisionStatuses = new Set<PlannerDecision['status']>(['suggested', 'dispatching', 'completed', 'blocked', 'needs_fix']);
const acpBackends = new Set<AcpBackend>(['claudecode', 'opencode', 'codex']);
const taskExecutionIntents = new Set<TaskExecutionIntent>([
  'analysis_only',
  'planning_only',
  'documentation_only',
  'implementation',
  'debug_fix',
  'review_only',
]);
const messageIntents = new Set<MessageIntent>(['chat', 'light_task', 'debugger', 'brainstorming', 'workflow']);
const messageIntentSources = new Set<MessageIntentSource>(['rule', 'classifier']);
const messageIntentSuggestedActions = new Set<MessageIntentSuggestedAction>([
  'reply_in_chat',
  'create_light_task',
  'enter_debugger',
  'start_brainstorming',
  'start_workflow',
  'create_task',
  'ask_user',
]);

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
    const taskReadiness = sanitizeTaskReadinessMetadata(parsed);
    const plannerDecision = sanitizePlannerDecisionMetadata(parsed);
    const intentResult = sanitizeIntentResultMetadata(parsed);
    const trace = sanitizeTraceMetadata(parsed);
    const acp = sanitizeAcpMetadata(parsed);
    const reply = sanitizeReplyMetadata(parsed);
    return {
      attachments,
      ...reply,
      ...intentResult,
      ...taskEvent,
      ...collaboration,
      ...taskReadiness,
      ...plannerDecision,
      ...trace,
      ...acp,
    };
  } catch {
    return createEmptyMessageMetadata();
  }
}

function sanitizeReplyMetadata(value: Record<string, unknown>) {
  const reply = sanitizeReply(value.reply_to);
  return reply ? { reply_to: reply } : {};
}

function sanitizeReply(value: unknown): MessageReplyMetadata | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.message_id !== 'string' ||
    !value.message_id.trim() ||
    !isSenderType(value.sender_type) ||
    typeof value.sender_id !== 'string' ||
    !value.sender_id.trim() ||
    typeof value.excerpt !== 'string' ||
    !value.excerpt.trim()
  ) {
    return null;
  }

  return {
    message_id: value.message_id,
    sender_type: value.sender_type,
    sender_id: value.sender_id,
    sender_name: typeof value.sender_name === 'string' ? value.sender_name : null,
    excerpt: value.excerpt.slice(0, 240),
  };
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
    message_id: typeof value.message_id === 'string' ? value.message_id : undefined,
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

function sanitizeTaskReadinessMetadata(value: Record<string, unknown>) {
  const readiness = sanitizeTaskReadiness(value.task_readiness);
  return readiness ? { task_readiness: readiness } : {};
}

function sanitizeIntentResultMetadata(value: Record<string, unknown>) {
  const intentResult = sanitizeIntentResult(value.intent_result);
  return intentResult ? { intent_result: intentResult } : {};
}

function sanitizePlannerDecisionMetadata(value: Record<string, unknown>) {
  const decision = sanitizePlannerDecision(value.planner_decision);
  if (!decision) return {};
  return {
    ...(typeof value.source_message_id === 'string' ? { source_message_id: value.source_message_id } : {}),
    planner_decision: decision,
  };
}

function sanitizeTraceMetadata(value: Record<string, unknown>) {
  const trace = sanitizeTrace(value.trace);
  return trace ? { trace } : {};
}

function sanitizeAcpMetadata(value: Record<string, unknown>) {
  return {
    ...(typeof value.acp_enabled === 'boolean' ? { acp_enabled: value.acp_enabled } : {}),
    ...(isAcpBackend(value.acp_backend) || value.acp_backend === null ? { acp_backend: value.acp_backend } : {}),
    ...(typeof value.acp_session_id === 'string' || value.acp_session_id === null
      ? { acp_session_id: value.acp_session_id }
      : {}),
    ...(typeof value.internal === 'boolean' ? { internal: value.internal } : {}),
  };
}

function sanitizeIntentResult(value: unknown): MessageIntentResult | null {
  if (!isRecord(value)) return null;
  const suggestedAction = sanitizeIntentSuggestedAction(value);
  if (
    !isMessageIntent(value.intent) ||
    !isMessageIntentSource(value.source) ||
    !suggestedAction ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.reason !== 'string' ||
    !value.reason.trim()
  ) {
    return null;
  }

  const signals = sanitizeIntentSignals(value.signals);
  return {
    intent: value.intent,
    source: value.source,
    suggestedAction,
    confidence: value.confidence,
    reason: value.reason,
    ...(signals.length > 0 ? { signals } : {}),
  };
}

function sanitizeIntentSuggestedAction(value: Record<string, unknown>): MessageIntentSuggestedAction | null {
  const action = typeof value.suggestedAction === 'string'
    ? value.suggestedAction
    : typeof value.suggested_action === 'string'
      ? value.suggested_action
      : null;
  return isMessageIntentSuggestedAction(action) ? action : null;
}

function sanitizeIntentSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function sanitizePlannerDecision(value: unknown): PlannerDecision | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    typeof value.awaiting_user_confirmation !== 'boolean'
  ) {
    return null;
  }

  const nextSteps = sanitizePlannerDecisionSteps(value.next_steps);
  if (!nextSteps) return null;

  const mode: PlannerExecutionMode = isPlannerExecutionMode(value.mode)
    ? value.mode
    : 'pause_after_suggestion';
  const status: PlannerDecision['status'] = isPlannerDecisionStatus(value.status)
    ? value.status
    : 'suggested';

  return {
    mode,
    status,
    summary: value.summary,
    next_steps: nextSteps,
    awaiting_user_confirmation: value.awaiting_user_confirmation,
  };
}

function sanitizePlannerDecisionSteps(value: unknown): PlannerDecisionStep[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  const steps = value.map((step) => {
    if (!isRecord(step)) return null;
    if (
      typeof step.agent_id !== 'string' ||
      !step.agent_id.trim() ||
      typeof step.goal !== 'string' ||
      !step.goal.trim()
    ) {
      return null;
    }
    return {
      agent_id: step.agent_id,
      goal: step.goal,
    };
  });
  if (steps.some((step) => step === null)) return null;
  return steps as PlannerDecisionStep[];
}

function sanitizeTrace(value: unknown): MessageTrace | null {
  if (!isRecord(value)) return null;
  const trace: MessageTrace = {};
  const thinking = sanitizeTraceThinking(value.thinking);
  const toolCalls = sanitizeTraceToolCalls(value.tool_calls);
  const commands = sanitizeTraceCommands(value.commands);
  const events = sanitizeTraceEvents(value.events);
  if (thinking) trace.thinking = thinking;
  if (toolCalls) trace.tool_calls = toolCalls;
  if (commands) trace.commands = commands;
  if (events) trace.events = events;
  return trace.thinking || trace.tool_calls || trace.commands || trace.events ? trace : null;
}

function sanitizeTraceThinking(value: unknown): MessageTraceThinking[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.text !== 'string' || !entry.text.trim()) return null;
    return { text: entry.text };
  });
  const validEntries = entries.filter((entry): entry is MessageTraceThinking => entry !== null);
  return validEntries.length === entries.length && validEntries.length > 0 ? validEntries : null;
}

function sanitizeTraceToolCalls(value: unknown): MessageTraceToolCall[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      typeof entry.input !== 'string'
    ) {
      return null;
    }
    return {
      name: entry.name,
      input: entry.input,
      ...(typeof entry.output === 'string' ? { output: entry.output } : {}),
    };
  });
  const validEntries = entries.filter((entry): entry is MessageTraceToolCall => entry !== null);
  return validEntries.length === entries.length && validEntries.length > 0 ? validEntries : null;
}

function sanitizeTraceCommands(value: unknown): MessageTraceCommand[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.command !== 'string' || !entry.command.trim()) return null;
    return {
      command: entry.command,
      ...(typeof entry.output === 'string' ? { output: entry.output } : {}),
    };
  });
  const validEntries = entries.filter((entry): entry is MessageTraceCommand => entry !== null);
  return validEntries.length === entries.length && validEntries.length > 0 ? validEntries : null;
}

function sanitizeTraceEvents(value: unknown): AgentTimelineEvent[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map(sanitizeTraceEvent).filter((entry): entry is AgentTimelineEvent => entry !== null);
  return entries.length > 0 ? entries : null;
}

function sanitizeTraceEvent(value: unknown): AgentTimelineEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.message_id !== 'string' ||
    !value.message_id.trim() ||
    typeof value.run_id !== 'string' ||
    !value.run_id.trim() ||
    typeof value.agent_id !== 'string' ||
    !value.agent_id.trim() ||
    typeof value.seq !== 'number' ||
    !Number.isInteger(value.seq) ||
    value.seq < 0 ||
    !isAgentTimelineEventType(value.type) ||
    !isAgentTimelineEventStatus(value.status) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    !isRecord(value.payload) ||
    typeof value.created_at !== 'number' ||
    !Number.isFinite(value.created_at)
  ) {
    return null;
  }

  return {
    id: value.id,
    message_id: value.message_id,
    run_id: value.run_id,
    agent_id: value.agent_id,
    seq: value.seq,
    type: value.type,
    status: value.status,
    title: value.title,
    payload: value.payload as AgentTimelinePayload,
    ...(isRecord(value.raw) ? { raw: value.raw } : {}),
    created_at: value.created_at,
  };
}

function sanitizeTaskReadiness(value: unknown): TaskReadinessMetadata | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.ready !== 'boolean' ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    typeof value.description !== 'string' ||
    !value.description.trim() ||
    !isCollaborationMode(value.recommended_mode)
  ) {
    return null;
  }

  const missingQuestions = sanitizeStringArray(value.missing_questions);
  if (!missingQuestions) return null;

  return {
    ready: value.ready,
    confidence: value.confidence,
    title: value.title,
    description: value.description,
    missing_questions: missingQuestions,
    recommended_mode: value.recommended_mode,
    ...(isTaskExecutionIntent(value.execution_intent) ? { execution_intent: value.execution_intent } : {}),
    source_message_id: typeof value.source_message_id === 'string' ? value.source_message_id : undefined,
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

function isPlannerExecutionMode(value: unknown): value is PlannerExecutionMode {
  return typeof value === 'string' && plannerExecutionModes.has(value as PlannerExecutionMode);
}

function isPlannerDecisionStatus(value: unknown): value is PlannerDecision['status'] {
  return typeof value === 'string' && plannerDecisionStatuses.has(value as PlannerDecision['status']);
}

function isAcpBackend(value: unknown): value is AcpBackend {
  return typeof value === 'string' && acpBackends.has(value as AcpBackend);
}

function isTaskExecutionIntent(value: unknown): value is TaskExecutionIntent {
  return typeof value === 'string' && taskExecutionIntents.has(value as TaskExecutionIntent);
}

function isMessageIntent(value: unknown): value is MessageIntent {
  return typeof value === 'string' && messageIntents.has(value as MessageIntent);
}

function isMessageIntentSource(value: unknown): value is MessageIntentSource {
  return typeof value === 'string' && messageIntentSources.has(value as MessageIntentSource);
}

function isMessageIntentSuggestedAction(value: unknown): value is MessageIntentSuggestedAction {
  return typeof value === 'string' && messageIntentSuggestedActions.has(value as MessageIntentSuggestedAction);
}

function isTaskEventType(value: string): value is TaskEventType {
  return taskEventTypes.has(value as TaskEventType);
}

function isSenderType(value: unknown): value is MessageReplyMetadata['sender_type'] {
  return value === 'user' || value === 'agent' || value === 'system';
}

function isTaskOrigin(value: string): value is TaskCreatedFrom {
  return taskOrigins.has(value as TaskCreatedFrom);
}

function isAgentTimelineEventType(value: unknown): value is AgentTimelineEventType {
  return typeof value === 'string' && [
    'thinking',
    'assistant_message',
    'tool_call',
    'tool_result',
    'command',
    'command_output',
    'file_diff',
    'plan_update',
    'web_search',
    'permission_request',
    'error',
    'raw',
  ].includes(value);
}

function isAgentTimelineEventStatus(value: unknown): value is AgentTimelineEventStatus {
  return value === 'started' || value === 'delta' || value === 'completed' || value === 'failed';
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
