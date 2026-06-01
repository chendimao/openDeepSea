import { parseClassifierIntentResult, type MessageIntentClassifierInvoker } from './message-intent-router.js';
import type { SessionAdapter } from './acp/types.js';
import type { RoomAgent } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export function createAcpMessageIntentClassifier(input: {
  projectPath: string;
  agent: RoomAgent;
  adapter: SessionAdapter;
  timeoutMs?: number;
}): MessageIntentClassifierInvoker {
  return async ({ message, ruleResult }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let answer = '';
    try {
      await input.adapter.invoke({
        projectPath: input.projectPath,
        sessionId: null,
        prompt: buildAcpIntentClassifierPrompt(message, ruleResult, input.agent),
        acpPermissionMode: 'read-only',
        acpWritableDirs: [],
        envOverrides: {
          OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER: 'project',
          OPENDEEPSEA_SUPERPOWERS_DISABLED: '1',
        },
        onChunk: (chunk) => {
          if (chunk.stream === 'stdout' && chunk.channel === 'answer') {
            answer += chunk.text;
          }
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const trimmed = answer.trim();
    if (!trimmed) throw new Error('ACP intent classifier returned empty output');
    if (!parseClassifierIntentResult(trimmed)) {
      throw new Error('ACP intent classifier returned invalid JSON');
    }
    return trimmed;
  };
}

function buildAcpIntentClassifierPrompt(
  message: string,
  ruleResult: Parameters<MessageIntentClassifierInvoker>[0]['ruleResult'],
  agent: RoomAgent,
): string {
  return [
    '只判断消息意图，不要执行用户请求，不要修改文件，不要调用工具。',
    '你是 OpenClaw Room 的消息意图分类器。根据用户消息判断应该进入哪类处理流程。',
    `当前用于判断的 ACP 智能体：${agent.agent_name}（${agent.agent_id}）。`,
    '',
    '可选 intent：',
    '- chat：普通问答、解释、闲聊，不需要改文件或启动任务。',
    '- light_task：小范围明确改动，例如删除/隐藏/修改 UI 入口、改文案、补配置、整理局部内容。',
    '- debugger：用户要求排查错误、找根因、修复异常或解释为什么没生效。',
    '- brainstorming：用户明确要求头脑风暴、发散方案、选型或多方案对比。',
    '- workflow：需要完整闭环、计划、TDD、代码审查、浏览器验证、自动提交或多步骤正式实现。',
    '',
    'suggestedAction 映射：',
    '- chat -> reply_in_chat',
    '- light_task -> create_light_task',
    '- debugger -> start_debugger',
    '- brainstorming -> start_brainstorming',
    '- workflow -> start_workflow',
    '',
    '只输出严格 JSON，不要 Markdown，不要代码块，不要额外文字。JSON 字段固定为：',
    '{"intent":"light_task","confidence":0.9,"suggestedAction":"create_light_task","reason":"简短中文原因","signals":["命中的关键信号"]}',
    '',
    `规则初判：${JSON.stringify(ruleResult)}`,
    `用户消息：${message}`,
  ].join('\n');
}
