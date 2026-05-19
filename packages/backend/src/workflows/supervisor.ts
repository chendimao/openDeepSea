import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import type { PlannerInvoker, PlannerMessage } from './langchain-planner.js';
import { buildChatOpenAIFields, extractPlannerText, getRuntimeLangChainPlannerConfig } from './langchain-planner.js';
import type { Project, Room, RoomAgent, Task, TaskExecutionIntent, WorkflowDefinition, WorkflowRole, WorkflowStage } from '../types.js';

const workflowSupervisorModeSchema = z.enum([
  'select_existing_workflow',
  'use_default_workflow',
  'propose_temporary_workflow',
]);

const assignmentSchema = z.object({
  stage: z.enum(['analysis', 'planning', 'assignment', 'implementation', 'code_review', 'acceptance']),
  role: z.enum(['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor']),
  agentId: z.string().min(1),
  reason: z.string().default(''),
});

const supervisorDecisionSchema = z.object({
  mode: workflowSupervisorModeSchema,
  workflowDefinitionId: z.string().min(1).nullable().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  assignments: z.array(assignmentSchema).default([]),
  fallbackMode: z.enum(['default_workflow']).default('default_workflow'),
  draft: z.unknown().optional(),
});

export interface WorkflowSupervisorAssignment {
  stage: WorkflowStage;
  role: WorkflowRole;
  agentId: string;
  reason: string;
}

export interface WorkflowSupervisorDecision {
  mode: z.infer<typeof workflowSupervisorModeSchema>;
  workflowDefinitionId: string | null;
  confidence: number;
  reason: string;
  assignments: WorkflowSupervisorAssignment[];
  fallbackMode: 'default_workflow';
  draft?: unknown;
}

export interface WorkflowSupervisorInput {
  project: Project;
  room: Room;
  task: Task;
  agents: RoomAgent[];
  workflowDefinitions: WorkflowDefinition[];
}

export interface WorkflowSupervisorOptions {
  maxAttempts?: number;
  skillContext?: string;
}

export class WorkflowSupervisorError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'WorkflowSupervisorError';
  }
}

export function parseWorkflowSupervisorDecision(raw: string): WorkflowSupervisorDecision {
  const parsed = supervisorDecisionSchema.parse(JSON.parse(extractJson(raw)));
  return {
    mode: parsed.mode,
    workflowDefinitionId: parsed.mode === 'select_existing_workflow' ? parsed.workflowDefinitionId ?? null : null,
    confidence: parsed.confidence,
    reason: parsed.reason,
    assignments: parsed.assignments,
    fallbackMode: parsed.fallbackMode,
    ...(parsed.draft === undefined ? {} : { draft: parsed.draft }),
  };
}

export interface SupervisorMessageOptions {
  skillContext?: string;
}

export function buildSupervisorMessages(input: WorkflowSupervisorInput, options: SupervisorMessageOptions = {}): PlannerMessage[] {
  return [
    new SystemMessage([
      'You are the workflow supervisor for OpenDeepSea.',
      'Choose the best existing published workflow definition for the task.',
      'Return only a fenced JSON object.',
      'Allowed mode values: select_existing_workflow, use_default_workflow, propose_temporary_workflow.',
      'Use select_existing_workflow only when one listed workflow is clearly suitable.',
      'Use propose_temporary_workflow only as a recommendation; it will not be executed automatically.',
      'When task.execution_intent is analysis_only, planning_only, documentation_only, or review_only, prefer a lightweight analysis/document workflow such as 方案文档闭环 or analysis-document. Do not select a development workflow that includes execute, code_review, or verify nodes for these intents.',
      'When task.execution_intent is implementation or debug_fix, prefer the development workflow with implementation, review, verification, acceptance, and memory stages.',
      'confidence must be a number from 0 to 1.',
      'Assignments are advisory and must reference listed room agent IDs.',
      options.skillContext?.trim() ? `\n${options.skillContext.trim()}` : null,
    ].join('\n')),
    new HumanMessage(formatSupervisorInput(input)),
  ];
}

export async function generateWorkflowSupervisorDecision(
  input: WorkflowSupervisorInput,
  invoker: PlannerInvoker = createDefaultSupervisorInvoker(),
  options: WorkflowSupervisorOptions = {},
): Promise<WorkflowSupervisorDecision> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const messages = buildSupervisorMessages(input, { skillContext: options.skillContext });
  let lastOutput = '';
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastOutput = await invoker.invoke(messages);
      return parseWorkflowSupervisorDecision(lastOutput);
    } catch (err) {
      lastError = err;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new WorkflowSupervisorError(`Workflow Supervisor failed after ${maxAttempts} attempts: ${detail}`, lastOutput, lastError);
}

export function createDefaultSupervisorInvoker(): PlannerInvoker {
  const config = getRuntimeLangChainPlannerConfig();
  if (!config.enabled || !config.model || !config.apiKey) {
    throw new Error('Workflow Supervisor is not configured');
  }

  const model = new ChatOpenAI(buildChatOpenAIFields(config));
  return {
    async invoke(messages) {
      const response = await model.invoke(messages);
      return extractPlannerText(response.content);
    },
  };
}

function formatSupervisorInput(input: WorkflowSupervisorInput): string {
  return JSON.stringify(
    {
      project: {
        id: input.project.id,
        name: input.project.name,
        path: input.project.path,
        description: input.project.description,
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
        execution_intent: extractTaskExecutionIntent(input.task.description),
        priority: input.task.priority,
        status: input.task.status,
      },
      agents: input.agents.map((agent) => ({
        id: agent.id,
        agent_id: agent.agent_id,
        agent_name: agent.agent_name,
        workflow_role: agent.workflow_role,
        capabilities: agent.capabilities,
        acp_enabled: Boolean(agent.acp_enabled),
        acp_backend: agent.acp_backend,
      })),
      workflow_definitions: input.workflowDefinitions.map((definition) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        scope: definition.scope,
        version: definition.version,
        nodes: definition.definition.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          label: node.label,
          stage: node.stage ?? null,
          role: node.role ?? null,
        })),
      })),
    },
    null,
    2,
  );
}

function extractTaskExecutionIntent(value: string | null): TaskExecutionIntent | null {
  if (!value) return null;
  const match = value.match(/任务意图[：:]\s*(analysis_only|planning_only|documentation_only|implementation|debug_fix|review_only)/);
  return match ? match[1] as TaskExecutionIntent : null;
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? raw).trim();
}
