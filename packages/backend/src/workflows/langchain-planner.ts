import { HumanMessage, SystemMessage, type MessageContent } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { parsePlanArtifact, type ParsedPlan } from './plan-parser.js';
import type { Room, RoomAgent, Task } from '../types.js';

export interface LangChainPlannerConfig {
  enabled: boolean;
  model: string | null;
}

export interface LangChainPlannerInput {
  projectName: string;
  projectPath: string;
  room: Room;
  task: Task;
  agents: RoomAgent[];
  memories: string[];
  recentMessages: string[];
}

export type PlannerMessage = SystemMessage | HumanMessage;

export interface PlannerInvoker {
  invoke(messages: PlannerMessage[]): Promise<string>;
}

export interface LangChainPlannerOptions {
  maxAttempts?: number;
}

export class LangChainPlannerError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'LangChainPlannerError';
  }
}

export function getLangChainPlannerConfig(
  env: Partial<Pick<NodeJS.ProcessEnv, 'LANGCHAIN_PLANNER_MODEL' | 'OPENAI_API_KEY'>> = process.env,
): LangChainPlannerConfig {
  const model = env.LANGCHAIN_PLANNER_MODEL?.trim() || '';
  const hasApiKey = Boolean(env.OPENAI_API_KEY?.trim());
  return {
    enabled: Boolean(model && hasApiKey),
    model: model || null,
  };
}

export async function generateLangChainPlan(
  input: LangChainPlannerInput,
  invoker: PlannerInvoker = createDefaultPlannerInvoker(),
  options: LangChainPlannerOptions = {},
): Promise<ParsedPlan> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const messages = buildPlannerMessages(input);
  let lastOutput = '';
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastOutput = await invoker.invoke(messages);
      return parsePlanArtifact(lastOutput);
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new LangChainPlannerError(`LangChain Planner failed after ${maxAttempts} attempts: ${detail}`, lastOutput, lastError);
}

export function buildPlannerMessages(input: LangChainPlannerInput): PlannerMessage[] {
  return [
    new SystemMessage(
      [
        'You are the LangChain planning service for OpenClaw Room.',
        'Return only a fenced JSON object using the modern plan schema.',
        'The root object must include goal, summary, assumptions, steps, risks, verification, and needsApproval.',
        'Each step must include title, intent, assigneeRole, scopeRead, scopeWrite, acceptance, and dependsOn.',
        'Each step may include optional preferredBackend.',
        'Valid assigneeRole values: analyst, planner, coordinator, executor, reviewer, acceptor.',
        'Valid preferredBackend values: claudecode, opencode, codex.',
        'Use needsApproval=false only when the plan can proceed without a user decision.',
      ].join('\n'),
    ),
    new HumanMessage(formatPlannerInput(input)),
  ];
}

export function createDefaultPlannerInvoker(): PlannerInvoker {
  const config = getLangChainPlannerConfig();
  if (!config.enabled || !config.model) {
    throw new Error('LangChain Planner is not configured');
  }

  const model = new ChatOpenAI({ model: config.model, temperature: 0 });
  return {
    async invoke(messages) {
      const response = await model.invoke(messages);
      return extractPlannerText(response.content);
    },
  };
}

export function extractPlannerText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map(formatContentBlock).join('');
}

function formatPlannerInput(input: LangChainPlannerInput): string {
  return JSON.stringify(
    {
      project: {
        name: input.projectName,
        path: input.projectPath,
      },
      room: {
        id: input.room.id,
        name: input.room.name,
        description: input.room.description,
      },
      task: {
        id: input.task.id,
        title: input.task.title,
        description: input.task.description,
        priority: input.task.priority,
        status: input.task.status,
      },
      agents: input.agents.map(formatAgent),
      memories: input.memories,
      recent_messages: input.recentMessages,
    },
    null,
    2,
  );
}

function formatAgent(agent: RoomAgent): Record<string, unknown> {
  return {
    agent_name: agent.agent_name,
    agent_id: agent.agent_id,
    workflow_role: agent.workflow_role,
    acp_enabled: Boolean(agent.acp_enabled),
    acp_backend: agent.acp_backend,
    agent_role: agent.agent_role,
  };
}

function formatContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (typeof block !== 'object' || block === null) return String(block);
  if ('text' in block && typeof block.text === 'string') return block.text;
  return JSON.stringify(block);
}
