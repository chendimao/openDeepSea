import { HumanMessage, SystemMessage, type MessageContent } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import {
  buildChatOpenAIFields,
  extractPlannerText,
  getLangChainPlannerConfig,
  getRuntimeLangChainPlannerConfig,
} from './workflows/langchain-planner.js';
import type { LangChainPlannerSettings, Message, Project, Room } from './types.js';

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

export interface ConfiguredModelTestResult {
  ok: boolean;
  status: 'success' | 'missing_credentials' | 'failed';
  model: string | null;
  baseURL: string | null;
  output: string | null;
  error: string | null;
  tested_at: number;
}

export interface ConfiguredModelTester {
  invoke(messages: Array<SystemMessage | HumanMessage>): Promise<MessageContent>;
}

export interface ConfiguredModelTestOptions {
  prompt?: string | null;
  tester?: ConfiguredModelTester;
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

export async function testConfiguredModel(
  settings: LangChainPlannerSettings,
  options: ConfiguredModelTestOptions = {},
): Promise<ConfiguredModelTestResult> {
  const config = getLangChainPlannerConfig({}, settings);
  if (!config.enabled || !config.model || !config.apiKey) {
    return {
      ok: false,
      status: 'missing_credentials',
      model: config.model,
      baseURL: config.baseURL,
      output: null,
      error: 'AI config requires both model and API key',
      tested_at: Date.now(),
    };
  }

  try {
    const tester = options.tester ?? createDefaultConfiguredModelTester(settings);
    const response = await tester.invoke(buildConfiguredModelTestMessages(options.prompt));
    const output = extractPlannerText(response).trim();
    return {
      ok: true,
      status: 'success',
      model: config.model,
      baseURL: config.baseURL,
      output,
      error: null,
      tested_at: Date.now(),
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      model: config.model,
      baseURL: config.baseURL,
      output: null,
      error: sanitizeModelErrorMessage(err),
      tested_at: Date.now(),
    };
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

function createDefaultConfiguredModelTester(settings: LangChainPlannerSettings): ConfiguredModelTester {
  const config = getLangChainPlannerConfig({}, settings);
  if (!config.enabled || !config.model || !config.apiKey) {
    throw new Error('AI config requires both model and API key');
  }
  const model = new ChatOpenAI(buildChatOpenAIFields(config));
  return {
    async invoke(messages) {
      const response = await model.invoke(messages);
      return response.content;
    },
  };
}

function buildConfiguredModelTestMessages(prompt: string | null | undefined): Array<SystemMessage | HumanMessage> {
  return [
    new SystemMessage('You are testing an OpenAI-compatible chat model connection. Reply with a brief confirmation.'),
    new HumanMessage(prompt?.trim() || 'Reply with OK.'),
  ];
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
