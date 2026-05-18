import { HumanMessage, SystemMessage, type MessageContent } from '@langchain/core/messages';
import { globalChatRepo } from './repos/global-chat.js';
import { memoryRepo } from './repos/memory.js';
import { settingsRepo } from './repos/settings.js';
import { invokeConfiguredModelText, sanitizeModelErrorMessage } from './chat-model.js';
import { extractPlannerText } from './workflows/langchain-planner.js';
import type { GlobalChatMessage, MemoryEntry } from './types.js';

export interface GlobalChatInvoker {
  invoke(messages: Array<SystemMessage | HumanMessage>): Promise<MessageContent>;
}

export interface SafeGlobalChatSettingsSummary {
  model: string | null;
  baseURL: string | null;
  apiKeySet: boolean;
  apiKeyPreview: string | null;
  rawApiKeyForTest?: string;
}

export interface SendGlobalChatMessageInput {
  sessionId: string;
  content: string;
  invoker?: GlobalChatInvoker;
  settingsSummary?: SafeGlobalChatSettingsSummary;
}

export interface SendGlobalChatMessageResult {
  userMessage: GlobalChatMessage;
  assistantMessage: GlobalChatMessage;
}

export async function sendGlobalChatMessage(input: SendGlobalChatMessageInput): Promise<SendGlobalChatMessageResult> {
  const content = input.content.trim();
  if (!content) throw new Error('content is required');
  const session = globalChatRepo.getSession(input.sessionId);
  if (!session || session.archived) throw new Error('global chat session not found');

  const userMessage = globalChatRepo.createMessage({
    session_id: session.id,
    role: 'user',
    content,
    status: 'completed',
  });
  const memories = memoryRepo.listForGlobalChatContext({ prompt: content, limit: 20 });
  const settingsSummary = input.settingsSummary ?? buildSafeSettingsSummary();
  const messages = buildGlobalChatMessages({
    userContent: content,
    history: globalChatRepo.listMessages(session.id, { limit: 20 }).filter((message) => message.id !== userMessage.id),
    memories,
    settingsSummary,
  });

  try {
    const reply = input.invoker
      ? extractPlannerText(await input.invoker.invoke(messages)).trim()
      : await invokeConfiguredModelText(messages);
    if (!reply) throw new Error('Global chat completed without output');
    const assistantMessage = globalChatRepo.createMessage({
      session_id: session.id,
      role: 'assistant',
      content: reply,
      status: 'completed',
      metadata: {
        model_chat: true,
        memory_refs: memories.map(toMemoryRef),
        config_refs: ['system_settings'],
      },
    });
    return { userMessage, assistantMessage };
  } catch (err) {
    const error = sanitizeModelErrorMessage(err);
    const assistantMessage = globalChatRepo.createMessage({
      session_id: session.id,
      role: 'assistant',
      content: `Global chat failed: ${error}`,
      status: 'failed',
      metadata: {
        model_chat: true,
        memory_refs: memories.map(toMemoryRef),
        config_refs: ['system_settings'],
        error,
      },
    });
    return { userMessage, assistantMessage };
  }
}

export function buildGlobalChatMessages(input: {
  userContent: string;
  history: GlobalChatMessage[];
  memories: MemoryEntry[];
  settingsSummary: SafeGlobalChatSettingsSummary;
}): Array<SystemMessage | HumanMessage> {
  const memoryContext = input.memories.length > 0
    ? input.memories.map((memory) =>
      `- [${memory.scope}] ${memory.title}: ${memory.content}`,
    ).join('\n')
    : '无';
  const history = input.history.slice(-12).map((message) =>
    `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`,
  ).join('\n');
  const settings = [
    `模型：${input.settingsSummary.model ?? '未配置'}`,
    `Base URL：${input.settingsSummary.baseURL ?? '未配置'}`,
    `API Key：${input.settingsSummary.apiKeySet ? input.settingsSummary.apiKeyPreview ?? '已设置' : '未设置'}`,
  ].join('\n');

  return [
    new SystemMessage([
      '你是 OpenDeepSea 的全局聊天助手。',
      '你可以基于检索到的记忆和非敏感配置摘要回答，也可以进行普通聊天。',
      '如果上下文没有证据，请说明不确定；不要声称已经修改文件、创建项目、创建任务或执行 workflow。',
      '',
      '检索到的记忆：',
      memoryContext,
      '',
      '非敏感系统配置摘要：',
      settings,
    ].join('\n')),
    new HumanMessage([
      history ? `最近对话：\n${history}` : '最近对话：无',
      '',
      '用户最新消息：',
      input.userContent,
    ].join('\n')),
  ];
}

export function buildSafeSettingsSummary(): SafeGlobalChatSettingsSummary {
  const settings = settingsRepo.getSystem();
  return {
    model: settings.langchain_planner_model,
    baseURL: settings.openai_base_url,
    apiKeySet: settings.openai_api_key_set,
    apiKeyPreview: settings.openai_api_key_preview,
  };
}

function toMemoryRef(memory: MemoryEntry): NonNullable<GlobalChatMessage['metadata']['memory_refs']>[number] {
  return {
    id: memory.id,
    title: memory.title,
    scope: memory.scope,
    project_id: memory.project_id,
    room_id: memory.room_id,
    task_id: memory.task_id,
  };
}
