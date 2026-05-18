import { HumanMessage, SystemMessage, type MessageContent } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { buildChatOpenAIFields, extractPlannerText, getRuntimeLangChainPlannerConfig } from './workflows/langchain-planner.js';
import type { Message, Project, Room } from './types.js';

export interface ModelChatInput {
  project: Project;
  room: Room;
  userMessage: Message;
  recentMessages: Message[];
}

export interface ModelChatInvoker {
  invoke(messages: Array<SystemMessage | HumanMessage>): Promise<MessageContent>;
}

export interface ModelChatOptions {
  skillContext?: string;
}

export function isModelChatConfigured(): boolean {
  return getRuntimeLangChainPlannerConfig().enabled;
}

export async function generateModelChatReply(
  input: ModelChatInput,
  invoker: ModelChatInvoker = createDefaultModelChatInvoker(),
  options: ModelChatOptions = {},
): Promise<string> {
  const content = await invoker.invoke(buildModelChatMessages(input, options));
  const text = extractPlannerText(content).trim();
  if (!text) throw new Error('Model chat completed without output');
  return text;
}

export function buildModelChatMessages(
  input: ModelChatInput,
  options: ModelChatOptions = {},
): Array<SystemMessage | HumanMessage> {
  const history = input.recentMessages
    .filter((message) => message.id !== input.userMessage.id)
    .slice(-12)
    .map((message) => {
      const sender = message.sender_type === 'user' ? 'User' : message.sender_name ?? message.sender_id;
      const content = message.content.trim();
      return content ? `${sender}: ${content}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join('\n');

  return [
    new SystemMessage([
      '你是 OpenDeepSea 的通用聊天助手。',
      '当聊天室没有可用 agent 或没有触发 agent 路由时，你负责直接回答用户。',
      '回答要简洁、具体、可执行；如果用户提出开发任务，可以给出下一步建议，但不要声称已经修改文件。',
      `当前项目：${input.project.name}`,
      `项目路径：${input.project.path}`,
      `当前群聊：${input.room.name}`,
      options.skillContext?.trim() ? `\n${options.skillContext.trim()}` : null,
    ].join('\n')),
    new HumanMessage([
      history ? `最近对话：\n${history}` : '最近对话：无',
      '',
      '用户最新消息：',
      input.userMessage.content,
    ].join('\n')),
  ];
}

export async function invokeConfiguredModelText(messages: Array<SystemMessage | HumanMessage>): Promise<string> {
  try {
    const config = getRuntimeLangChainPlannerConfig();
    if (!config.enabled || !config.model || !config.apiKey) return '';
    const model = new ChatOpenAI(buildChatOpenAIFields(config));
    const response = await model.invoke(messages);
    return extractPlannerText(response.content).trim();
  } catch (err) {
    const error = new Error(sanitizeModelErrorMessage(err));
    error.cause = err;
    throw error;
  }
}

function createDefaultModelChatInvoker(): ModelChatInvoker {
  const config = getRuntimeLangChainPlannerConfig();
  if (!config.enabled || !config.model || !config.apiKey) {
    throw new Error('Model chat is not configured');
  }
  return {
    async invoke(messages) {
      return invokeConfiguredModelText(messages);
    },
  };
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_CREDENTIAL]'],
  [/\b(Bearer)\s+sk-[A-Za-z0-9._-]+/gi, '$1 [REDACTED]'],
  [/\b(api[_-]?key|api[_-]?token|access[_-]?token|openai[_-]?api[_-]?key)\s*[:=]\s*["']?[^"',\s)]+/gi, '[REDACTED_CREDENTIAL]'],
  [/\bsk-[A-Za-z0-9._-]+/g, '[REDACTED]'],
];

export function sanitizeModelErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return SECRET_PATTERNS.reduce(
    (message, [pattern, replacement]) => message.replace(pattern, replacement),
    raw,
  );
}
