import { lstat } from 'node:fs/promises';
import { sessionEvidenceRepo } from './repos/session-evidence.js';
import { fileRepo } from './repos/files.js';
import { projectRepo } from './repos/projects.js';
import { settingsRepo } from './repos/settings.js';
import {
  DEFAULT_SESSION_AGENT_ID,
  sessionMessageRepo,
  sessionRepo,
} from './repos/sessions.js';
import { createContextManifest } from './session.routes.js';
import { buildKnowledgeAgentToolPrompt } from './knowledge-rag.js';
import { broadcastActiveSessionUpsert } from './session-active-broadcast.js';
import { buildSessionFileReferenceContext } from './session-file-reference-context.js';
import { buildSessionPlannerRuntimeSnapshot, resolveSessionPlannerRuntime } from './session-planner-runtime.js';
import { runSessionAgent } from './session-runtime.js';
import { wsHub } from './ws-hub.js';
import { getPlatformSkill } from './platform-skills/service.js';
import { isIgnoredWorkspacePath, normalizeWorkspacePath, resolveWorkspacePath } from './workspace-files.js';
import type { ImageGenerationJob, ImageGenerationOutput } from './image-generation/types.js';
import type { GenerateImageToolOutput } from './image-generation/tool.js';
import type { PlatformSkill } from './platform-skills/types.js';
import type {
  MessageAttachmentMetadata,
  PlatformSkillRef,
  ProjectFile,
  Session,
  SessionMessage,
  SessionMode,
} from './types.js';

const DEFAULT_SESSION_TITLE = 'New Session';
const AUTO_SESSION_TITLE_LIMIT = 25;
const MAX_SESSION_FILE_REFS = 12;
const MAX_PLATFORM_SKILL_REFS = 8;

type ResolvedPlatformSkillRef = PlatformSkillRef & {
  description: string | null;
};

export async function dispatchSessionUserMessage(input: {
  sessionId: string;
  content: string;
  senderId?: string;
  senderName?: string | null;
  mode?: SessionMode;
  agentId?: string | null;
  workspaceFileRefs?: string[];
  libraryFileRefs?: string[];
  platformSkillRefs?: PlatformSkillRef[];
}): Promise<SessionMessage> {
  const session = sessionRepo.get(input.sessionId);
  if (!session) throw new Error('session not found');
  const project = projectRepo.get(session.project_id);
  if (!project) throw new Error('project not found');
  const workspacePath = session.worktree_path ?? session.workspace_path ?? project.path;
  const workspaceFileRefs = await normalizeWorkspaceFileRefs(workspacePath, input.workspaceFileRefs);
  const libraryFileRefs = normalizeLibraryFileRefs(project.id, input.libraryFileRefs);
  const plannerRuntime = resolveSessionPlannerRuntime(session.project_id);
  const platformSkillRefs = await normalizePlatformSkillRefs(input.platformSkillRefs, plannerRuntime.backend);
  if (!hasUserMessagePayload(input.content, workspaceFileRefs, libraryFileRefs, platformSkillRefs)) {
    throw new Error('session message content or references are required');
  }
  const updatedSession = input.mode && input.mode !== session.mode
    ? sessionRepo.update(session.id, { mode: input.mode }) ?? session
    : session;
  const agentId = input.agentId?.trim() || DEFAULT_SESSION_AGENT_ID;
  const shouldRenameSession = shouldRenameFromFirstUserMessage(updatedSession);
  const message = sessionMessageRepo.create({
    session_id: updatedSession.id,
    role: 'user',
    sender_id: input.senderId ?? 'user',
    sender_name: input.senderName ?? null,
    content: input.content,
    metadata: buildUserMessageMetadata({ agentId, workspaceFileRefs, libraryFileRefs, platformSkillRefs }),
  });
  const runtimeSession = shouldRenameSession
    ? sessionRepo.update(updatedSession.id, { title: buildSessionTitleFromMessage(input.content) }) ?? updatedSession
    : updatedSession;
  if (runtimeSession.title !== updatedSession.title) {
    wsHub.broadcastSession(runtimeSession.id, {
      type: 'session:updated',
      sessionId: runtimeSession.id,
      session: runtimeSession,
    });
  }
  sessionEvidenceRepo.create({
    session_id: runtimeSession.id,
    event_type: 'message',
    source_message_id: message.id,
    title: 'User message',
    payload: { message_id: message.id, target_agent_id: agentId },
  });
  wsHub.broadcastSession(runtimeSession.id, {
    type: 'session_message:new',
    sessionId: runtimeSession.id,
    message,
  });
  broadcastActiveSessionUpsert(runtimeSession.id);
  const fileReferenceContext = await buildSessionFileReferenceContext({
    project,
    workspacePath,
    workspaceFileRefs,
    libraryFileRefs,
  });
  void runSessionAgent({
    sessionId: runtimeSession.id,
    agentId: plannerRuntime.agentId,
    prompt: buildRuntimePrompt(
      runtimeSession,
      message.content,
      fileReferenceContext.promptAddition,
      buildPlatformSkillsPrompt(platformSkillRefs),
      settingsRepo.getSystem().global_session_prompt,
    ),
    provider: plannerRuntime.backend,
    model: runtimeSession.model,
    permissionMode: plannerRuntime.permissionMode,
    runtimeProfileSnapshot: buildSessionPlannerRuntimeSnapshot(plannerRuntime),
    imagePaths: fileReferenceContext.imagePaths,
  }).catch((error) => {
    const event = sessionEvidenceRepo.create({
      session_id: runtimeSession.id,
      event_type: 'blocker',
      severity: 'error',
      title: 'Session runtime failed',
      summary: (error as Error).message,
    });
    wsHub.broadcastSession(runtimeSession.id, { type: 'session_evidence:new', sessionId: runtimeSession.id, event });
    broadcastActiveSessionUpsert(runtimeSession.id);
  });
  return message;
}

export function assertSessionCanReceiveImageGenerationJob(
  projectId: string,
  sessionId: string | null | undefined,
): void {
  if (!sessionId) return;
  const session = sessionRepo.get(sessionId);
  if (!session) throw new Error('session not found');
  if (session.project_id !== projectId) throw new Error('session project mismatch');
}

export function recordSessionImageGenerationJobMessage(input: {
  sessionId: string;
  job: ImageGenerationJob;
  outputs?: ImageGenerationOutput[];
}): SessionMessage {
  assertSessionCanReceiveImageGenerationJob(input.job.project_id, input.sessionId);
  if (input.job.session_id !== input.sessionId) {
    throw new Error('image generation job session mismatch');
  }
  const message = sessionMessageRepo.create({
    session_id: input.sessionId,
    role: 'system',
    sender_id: 'image-generation',
    sender_name: 'Image Generation',
    content: `图片生成任务已创建：${truncateImageGenerationPrompt(input.job.prompt)}`,
    message_type: 'system',
    metadata: buildImageGenerationJobMessageMetadata(input.job, input.outputs ?? []),
  });
  wsHub.broadcastSession(input.sessionId, {
    type: 'session_message:new',
    sessionId: input.sessionId,
    message,
  });
  broadcastActiveSessionUpsert(input.sessionId);
  return message;
}

export function recordSessionImageGenerationToolResultEvidence(input: {
  sessionId: string;
  sourceRunId?: string | null;
  result: GenerateImageToolOutput;
}) {
  const event = sessionEvidenceRepo.create({
    session_id: input.sessionId,
    event_type: 'tool_result',
    severity: imageToolEvidenceSeverity(input.result),
    source_run_id: input.sourceRunId ?? null,
    title: '图片生成结果',
    summary: imageToolEvidenceSummary(input.result),
    payload: {
      tool_name: 'generate_image',
      job_id: input.result.job_id,
      status: input.result.status,
      error: input.result.error,
      outputs: input.result.outputs,
    },
  });
  wsHub.broadcastSession(input.sessionId, {
    type: 'session_evidence:new',
    sessionId: input.sessionId,
    event,
  });
  broadcastActiveSessionUpsert(input.sessionId);
  return event;
}

function buildUserMessageMetadata(input: {
  agentId: string;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: ResolvedPlatformSkillRef[];
}): Record<string, unknown> {
  const attachments = buildLibraryAttachmentMetadata(input.libraryFileRefs);
  return {
    target_agent_id: input.agentId,
    ...(input.workspaceFileRefs.length > 0 ? { workspace_file_refs: input.workspaceFileRefs } : {}),
    ...(input.libraryFileRefs.length > 0 ? { library_file_refs: input.libraryFileRefs } : {}),
    ...(input.platformSkillRefs.length > 0
      ? {
          platform_skill_refs: input.platformSkillRefs.map(({ provider, name }) => ({ provider, name })),
        }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function buildImageGenerationJobMessageMetadata(
  job: ImageGenerationJob,
  outputs: ImageGenerationOutput[],
): Record<string, unknown> {
  const attachments = outputs.map((output) => ({
    id: output.file_id,
    fileId: output.file_id,
    name: output.name,
    mimeType: output.mime_type,
    size: output.size,
    url: output.url,
    isImage: output.mime_type.startsWith('image/'),
  }));
  return {
    image_generation_job_id: job.id,
    image_generation_status: job.status,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function truncateImageGenerationPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= 80) return normalized;
  return `${chars.slice(0, 80).join('').trimEnd()}...`;
}

function imageToolEvidenceSeverity(result: GenerateImageToolOutput): 'info' | 'warning' | 'error' {
  if (result.status === 'failed') return 'error';
  if (result.status === 'canceled') return 'warning';
  return 'info';
}

function imageToolEvidenceSummary(result: GenerateImageToolOutput): string {
  if (result.outputs.length > 0) return `已生成 ${result.outputs.length} 张图片。`;
  if (result.error) return result.error;
  if (result.status === 'canceled') return '图片生成任务已取消。';
  return '图片生成未返回图片。';
}

function buildLibraryAttachmentMetadata(libraryFileRefs: string[]): MessageAttachmentMetadata[] {
  return libraryFileRefs
    .map((ref) => fileRepo.get(ref))
    .filter((file): file is ProjectFile => file?.source_type === 'uploaded_file')
    .map((file) => ({
      id: file.id,
      fileId: file.id,
      name: file.original_name,
      mimeType: file.mime_type,
      size: file.size,
      url: file.url,
      isImage: file.mime_type.startsWith('image/'),
      deleted: file.deleted_at !== null,
    }));
}

function hasUserMessagePayload(
  content: string,
  workspaceFileRefs: string[],
  libraryFileRefs: string[],
  platformSkillRefs: ResolvedPlatformSkillRef[],
): boolean {
  return content.trim().length > 0 ||
    workspaceFileRefs.length > 0 ||
    libraryFileRefs.length > 0 ||
    platformSkillRefs.length > 0;
}

async function normalizeWorkspaceFileRefs(workspacePath: string, refs: string[] | undefined): Promise<string[]> {
  const normalizedRefs = dedupeRefs(refs);
  const validRefs: string[] = [];
  const seenPaths = new Set<string>();
  for (const ref of normalizedRefs) {
    let safePath: string;
    try {
      safePath = normalizeWorkspacePath(ref);
    } catch {
      throw new Error('workspace file reference is not available');
    }
    if (!safePath || isIgnoredWorkspacePath(safePath)) {
      throw new Error('workspace file reference is not available');
    }
    try {
      const resolved = await resolveWorkspacePath(workspacePath, safePath);
      const stats = await lstat(resolved.absolutePath);
      if (!stats.isFile()) {
        throw new Error('workspace file reference is not a file');
      }
      if (!seenPaths.has(resolved.relativePath)) {
        seenPaths.add(resolved.relativePath);
        validRefs.push(resolved.relativePath);
      }
    } catch {
      throw new Error('workspace file reference is not available');
    }
  }
  return validRefs;
}

function normalizeLibraryFileRefs(projectId: string, refs: string[] | undefined): string[] {
  return dedupeRefs(refs).map((ref) => {
    const file = fileRepo.get(ref);
    if (!file || file.project_id !== projectId || file.deleted_at !== null) {
      throw new Error('library file reference is not available');
    }
    return file.id;
  });
}

async function normalizePlatformSkillRefs(
  refs: PlatformSkillRef[] | undefined,
  plannerBackend: PlatformSkillRef['provider'],
): Promise<ResolvedPlatformSkillRef[]> {
  const normalized: ResolvedPlatformSkillRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const provider = ref.provider;
    const name = ref.name.trim();
    if (!name) continue;
    if (provider !== plannerBackend) {
      throw new Error('platform skill provider must match planner backend');
    }
    const key = `${provider}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    const skill = await getAvailablePlatformSkill(provider, name);
    normalized.push({
      provider,
      name: skill.name,
      description: skill.description,
    });
    seen.add(key);
    if (normalized.length >= MAX_PLATFORM_SKILL_REFS) break;
  }
  return normalized;
}

async function getAvailablePlatformSkill(
  provider: PlatformSkillRef['provider'],
  name: string,
): Promise<PlatformSkill> {
  const skill = await getPlatformSkill(provider, name).catch(() => null);
  if (!skill || !skill.valid) {
    throw new Error('platform skill is not available');
  }
  return skill;
}

function dedupeRefs(refs: string[] | undefined): string[] {
  const uniqueRefs: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueRefs.push(trimmed);
    if (uniqueRefs.length >= MAX_SESSION_FILE_REFS) break;
  }
  return uniqueRefs;
}

function shouldRenameFromFirstUserMessage(session: Session): boolean {
  if (session.title.trim() !== DEFAULT_SESSION_TITLE) return false;
  return sessionMessageRepo.listBySession(session.id, { limit: 1 }).length === 0;
}

export function buildSessionTitleFromMessage(content: string): string {
  const normalized = normalizeSessionTitleContent(content, { keepCodeBlocks: false }) ||
    normalizeSessionTitleContent(content, { keepCodeBlocks: true });
  const fallback = normalized || DEFAULT_SESSION_TITLE;
  return truncateTitle(fallback, AUTO_SESSION_TITLE_LIMIT);
}

function normalizeSessionTitleContent(content: string, options: { keepCodeBlocks: boolean }): string {
  return content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, options.keepCodeBlocks ? '$1' : ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(?:[#>*-]+\s*|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,，。.!！?？:：;；\s]+|[,，。.!！?？:：;；\s]+$/g, '');
}

function truncateTitle(title: string, limit: number): string {
  const chars = Array.from(title);
  if (chars.length <= limit) return title;
  return `${chars.slice(0, limit).join('').trimEnd()}...`;
}

export function buildRuntimePrompt(
  session: Session,
  content: string,
  referencedFilesBlock = '',
  platformSkillsBlock = '',
  globalSessionPrompt: string | null = null,
): string {
  const manifest = createContextManifest(session);
  const sourceBlocks = manifest.sources
    .filter((source) => source.included === 1 && source.excerpt?.trim())
    .map((source) => [
      `### ${source.title} (${source.source_type})`,
      `Reason: ${source.reason ?? 'session context'}`,
      source.excerpt!.trim(),
    ].join('\n'));
  const goal = session.current_goal?.trim();
  return [
    buildGlobalSessionInstructionBlock(globalSessionPrompt) || null,
    '本轮 prompt 来源由 SessionOS Context Inspector 记录。',
    goal ? `当前目标：${goal}` : null,
    sourceBlocks.length > 0 ? ['## Context Sources', ...sourceBlocks].join('\n\n') : null,
    referencedFilesBlock.trim() || null,
    platformSkillsBlock.trim() || null,
    buildKnowledgeAgentToolPrompt({ projectId: session.project_id }),
    '## User Request',
    content,
  ].filter(Boolean).join('\n\n');
}

export function buildGlobalSessionInstructionBlock(prompt: string | null | undefined): string {
  const trimmed = prompt?.trim();
  return trimmed ? `## Global Session Instruction\n${trimmed}` : '';
}

function buildPlatformSkillsPrompt(skills: ResolvedPlatformSkillRef[]): string {
  if (skills.length === 0) return '';
  return [
    '## Explicit Platform Skills',
    '用户通过 `$` 显式选择了 planner 当前 ACP backend 的 provider-native skills。请在本轮调用中按 provider 原生语义使用这些 skills。',
    ...skills.map((skill) => [
      `- $${skill.name}`,
      `  provider: ${skill.provider}`,
      skill.description ? `  description: ${skill.description}` : null,
    ].filter(Boolean).join('\n')),
  ].join('\n');
}
