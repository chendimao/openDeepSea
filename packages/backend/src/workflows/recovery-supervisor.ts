import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import type {
  RoomAgent,
  WorkflowIncident,
  WorkflowIncidentType,
  WorkflowRecoveryAction,
  WorkflowStage,
} from '../types.js';
import type { PlannerInvoker, PlannerMessage } from './langchain-planner.js';
import {
  buildChatOpenAIFields,
  extractPlannerText,
  getRuntimeLangChainPlannerConfig,
} from './langchain-planner.js';
import { isExecutableAgent, selectWorkflowAgentForPlanTask } from './role-resolver.js';

const recoveryActionSchema = z.enum([
  'retry_same_agent',
  'retry_with_global_agent',
  'reassign_agent',
  'split_task',
  'ask_user',
  'mark_blocked',
]);

const splitTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  scopeRead: z.array(z.string()).default([]),
  scopeWrite: z.array(z.string()).default([]),
});

const recoveryDecisionSchema = z.object({
  action: recoveryActionSchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  targetRoomAgentId: z.string().min(1).optional(),
  globalAgentTemplateId: z.string().min(1).optional(),
  splitTasks: z.array(splitTaskSchema).optional(),
  userQuestion: z.string().min(1).optional(),
});

export interface WorkflowRecoveryDecision {
  action: WorkflowRecoveryAction;
  reason: string;
  confidence: number;
  targetRoomAgentId?: string;
  globalAgentTemplateId?: string;
  splitTasks?: Array<{
    title: string;
    description: string;
    scopeRead: string[];
    scopeWrite: string[];
  }>;
  userQuestion?: string;
}

export interface WorkflowRecoveryInput {
  project: {
    id: string;
    name: string;
    path: string;
    description: string | null;
  };
  room: {
    id: string;
    name: string;
    description: string | null;
  };
  task: {
    id: string;
    title: string;
    description?: string | null;
    status?: string | null;
  };
  childTask?: {
    id: string;
    title: string;
    description?: string | null;
    status?: string | null;
  } | null;
  workflowStep?: {
    id: string;
    stage: WorkflowStage | string;
    status: string;
    error?: string | null;
  } | null;
  incident: WorkflowIncident;
  agents: RoomAgent[];
  previousDecisions?: WorkflowRecoveryDecision[];
}

export interface WorkflowRecoverySupervisorOptions {
  invoker?: PlannerInvoker;
  disableModel?: boolean;
  maxAttempts?: number;
  skillContext?: string;
}

export function parseWorkflowRecoveryDecision(raw: string): WorkflowRecoveryDecision {
  const parsed = recoveryDecisionSchema.parse(JSON.parse(extractJson(raw)));
  return {
    action: parsed.action,
    reason: parsed.reason,
    confidence: parsed.confidence,
    ...(parsed.targetRoomAgentId === undefined ? {} : { targetRoomAgentId: parsed.targetRoomAgentId }),
    ...(parsed.globalAgentTemplateId === undefined ? {} : { globalAgentTemplateId: parsed.globalAgentTemplateId }),
    ...(parsed.splitTasks === undefined ? {} : { splitTasks: parsed.splitTasks }),
    ...(parsed.userQuestion === undefined ? {} : { userQuestion: parsed.userQuestion }),
  };
}

export function buildRecoverySupervisorMessages(
  input: WorkflowRecoveryInput,
  options: { skillContext?: string } = {},
): PlannerMessage[] {
  return [
    new SystemMessage([
      'You are the workflow recovery supervisor for OpenDeepSea.',
      'Decide a safe recovery action for a workflow incident.',
      'Return only a fenced JSON object.',
      'Allowed action values: retry_same_agent, retry_with_global_agent, reassign_agent, split_task, ask_user, mark_blocked.',
      'Do not blindly retry repeated failures. Escalate after repeated interruptions.',
      'Use retry_with_global_agent when the room lacks a suitable executor and a global agent should be provisioned.',
      'Use ask_user when recovery needs product/user judgement.',
      'confidence must be a number from 0 to 1.',
      options.skillContext?.trim() ? `\n${options.skillContext.trim()}` : null,
    ].join('\n')),
    new HumanMessage(formatRecoveryInput(input)),
  ];
}

export async function decideRecovery(
  input: WorkflowRecoveryInput,
  options: WorkflowRecoverySupervisorOptions = {},
): Promise<WorkflowRecoveryDecision> {
  if (options.disableModel === true) {
    return decideRecoveryByDefaultPolicy(input);
  }

  const invoker = options.invoker ?? createConfiguredRecoverySupervisorInvoker();
  if (!invoker) {
    return decideRecoveryByDefaultPolicy(input);
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const messages = buildRecoverySupervisorMessages(input, { skillContext: options.skillContext });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await invoker.invoke(messages);
      return parseWorkflowRecoveryDecision(raw);
    } catch {
      // Fall through to default policy after configured attempts.
    }
  }

  return decideRecoveryByDefaultPolicy(input);
}

export function decideRecoveryByDefaultPolicy(input: WorkflowRecoveryInput): WorkflowRecoveryDecision {
  const incidentType = input.incident.incident_type;
  const attempts = input.incident.attempt_count;

  if (shouldRetrySameAgent(incidentType)) {
    if (attempts >= 2) {
      return {
        action: 'ask_user',
        reason: '同一子任务已经连续中断，继续自动重试可能掩盖真实问题，需要用户或产品经理确认下一步。',
        confidence: 0.72,
        userQuestion: '这个子任务已经连续中断 2 次，是否改派其他智能体、拆分任务，或手动处理？',
      };
    }
    return {
      action: 'retry_same_agent',
      reason: '异常看起来由运行环境中断引起，原执行智能体和任务上下文仍然可复用，先重试一次。',
      confidence: 0.78,
    };
  }

  if (incidentType === 'executor_unavailable') {
    return {
      action: 'retry_with_global_agent',
      reason: '当前聊天室没有可用执行智能体，应自动拉入匹配的全局执行智能体后继续执行。',
      confidence: 0.82,
    };
  }

  if (incidentType === 'runtime_boundary_mismatch') {
    const candidate = findCompatibleRoomAgent(input);
    if (candidate) {
      return {
        action: 'reassign_agent',
        reason: `当前执行智能体与任务边界不匹配，改派给更匹配的房间智能体：${candidate.agent_name}。`,
        confidence: 0.8,
        targetRoomAgentId: candidate.id,
      };
    }
    return {
      action: 'retry_with_global_agent',
      reason: '当前房间内没有匹配任务边界的可用执行智能体，应拉入合适的全局智能体继续。',
      confidence: 0.76,
    };
  }

  return {
    action: 'mark_blocked',
    reason: `未识别或高风险的工作流异常：${incidentType}，默认阻塞并等待人工处理。`,
    confidence: 0.6,
  };
}

export function createConfiguredRecoverySupervisorInvoker(): PlannerInvoker | null {
  const config = getRuntimeLangChainPlannerConfig();
  if (!config.enabled || !config.model || !config.apiKey) {
    return null;
  }

  const model = new ChatOpenAI(buildChatOpenAIFields(config));
  return {
    async invoke(messages) {
      const response = await model.invoke(messages);
      return extractPlannerText(response.content);
    },
  };
}

function shouldRetrySameAgent(incidentType: WorkflowIncidentType): boolean {
  return incidentType === 'backend_restart_interrupted'
    || incidentType === 'agent_run_stale'
    || incidentType === 'step_without_active_run';
}

function findCompatibleRoomAgent(input: WorkflowRecoveryInput): RoomAgent | null {
  const context = parseIncidentContext(input.incident.context_json);
  const requiredCapabilities = asStringArray(context.requiredCapabilities);
  let candidates = input.agents.filter((agent) =>
    agent.id !== input.incident.room_agent_id
    && agent.workflow_role === 'executor'
    && isExecutableAgent(agent),
  );

  if (requiredCapabilities.length > 0) {
    candidates = candidates.filter((agent) =>
      requiredCapabilities.every((required) =>
        agent.capabilities.some((capability) => capability.toLowerCase().includes(required.toLowerCase())),
      ),
    );
  }

  if (candidates.length === 0) return null;

  return selectWorkflowAgentForPlanTask('executor', candidates, {
    title: String(context.childTaskTitle ?? input.childTask?.title ?? input.task.title),
    description: String(context.childTaskDescription ?? input.childTask?.description ?? input.task.description ?? ''),
    scopeRead: asStringArray(context.scopeRead),
    scopeWrite: asStringArray(context.scopeWrite),
  }) ?? candidates[0] ?? null;
}

function formatRecoveryInput(input: WorkflowRecoveryInput): string {
  return JSON.stringify(
    {
      project: input.project,
      room: input.room,
      task: input.task,
      child_task: input.childTask ?? null,
      workflow_step: input.workflowStep ?? null,
      incident: {
        id: input.incident.id,
        incident_type: input.incident.incident_type,
        severity: input.incident.severity,
        status: input.incident.status,
        workflow_run_id: input.incident.workflow_run_id,
        workflow_step_id: input.incident.workflow_step_id,
        task_id: input.incident.task_id,
        child_task_id: input.incident.child_task_id,
        agent_run_id: input.incident.agent_run_id,
        room_agent_id: input.incident.room_agent_id,
        error: input.incident.error,
        attempt_count: input.incident.attempt_count,
        context: parseIncidentContext(input.incident.context_json),
      },
      agents: input.agents.map((agent) => ({
        id: agent.id,
        agent_id: agent.agent_id,
        agent_name: agent.agent_name,
        workflow_role: agent.workflow_role,
        agent_role: agent.agent_role,
        capabilities: agent.capabilities,
        acp_enabled: Boolean(agent.acp_enabled),
        acp_backend: agent.acp_backend,
        default_runtime: agent.default_runtime,
        runtime_backend: agent.runtime_backend,
        tool_policy: agent.tool_policy,
        workspace_policy: agent.workspace_policy,
      })),
      previous_decisions: input.previousDecisions ?? [],
    },
    null,
    2,
  );
}

function parseIncidentContext(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? raw).trim();
}
