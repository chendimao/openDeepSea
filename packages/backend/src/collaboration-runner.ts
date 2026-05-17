import { nanoid } from 'nanoid';
import type { CollaborationDecision, CollaborationStagePlan } from './collaboration-decision.js';
import { runAgentOnce } from './dispatcher.js';
import { now } from './db.js';
import { messageRepo } from './repos/messages.js';
import { roomAgentRepo } from './repos/rooms.js';
import type {
  AgentRun,
  AgentRunStatus,
  CollaborationRunResult,
  CollaborationStage,
  CollaborationStepResult,
  Message,
  RoomAgent,
} from './types.js';
import { wsHub } from './ws-hub.js';

export interface RunCollaborationStagesInput {
  runId: string;
  projectPath: string;
  roomId: string;
  sourceMessage: Message;
  decision: CollaborationDecision;
  runAgent?: CollaborationAgentRunner;
}

export type CollaborationAgentRunner = (input: {
  agent: RoomAgent;
  projectPath: string;
  roomId: string;
  prompt: string;
  collaborationRunId: string;
  collaborationStage: CollaborationStage;
}) => Promise<{
  run: AgentRun;
  message: Message;
  status: AgentRunStatus;
}>;

export async function runCollaborationStages(input: RunCollaborationStagesInput): Promise<CollaborationRunResult> {
  const startedAt = now();
  const result: CollaborationRunResult = {
    id: input.runId,
    room_id: input.roomId,
    source_message_id: input.sourceMessage.id,
    status: 'running',
    steps: [],
    error: null,
    started_at: startedAt,
    completed_at: null,
  };
  const runAgent = input.runAgent ?? defaultRunAgent;
  const agentsById = new Map(roomAgentRepo.listByRoom(input.roomId).flatMap((agent) => [
    [agent.agent_id, agent],
    [agent.id, agent],
  ]));
  const plannerAgent = agentsById.get('planner') ?? null;

  createSystemEvent(input.roomId, '轻量群聊协作已开始', {
    event_type: 'collaboration_started',
    collaboration_run_id: input.runId,
    source_message_id: input.sourceMessage.id,
  });

  if (input.decision.stages.length === 0) {
    result.status = 'blocked';
    result.error = 'Collaboration decision has no stages';
    result.completed_at = now();
    createSystemEvent(input.roomId, `轻量群聊协作已阻塞：${result.error}`, {
      event_type: 'collaboration_blocked',
      collaboration_run_id: input.runId,
      source_message_id: input.sourceMessage.id,
      error: result.error,
    });
    return result;
  }

  for (const stage of input.decision.stages) {
    const stageAssignments = buildStageAssignments({ agentsById, plannerAgent, stage });
    if (stageAssignments.length === 0) {
      result.status = 'blocked';
      result.error = `Collaboration stage ${stage.stage} has no agents and planner fallback is unavailable`;
      result.completed_at = now();
      createSystemEvent(input.roomId, `轻量群聊协作已阻塞：${result.error}`, {
        event_type: 'collaboration_blocked',
        collaboration_run_id: input.runId,
        source_message_id: input.sourceMessage.id,
        error: result.error,
      });
      return result;
    }

    const stageSteps = stage.parallel
      ? await Promise.all(stageAssignments.map((assignment, index) => runStageStep({
        assignment,
        input,
        previousSteps: result.steps,
        runAgent,
        sortOrder: result.steps.length + index,
        stage,
      })))
      : await runStageStepsSequentially({
        input,
        previousSteps: result.steps,
        runAgent,
        sortOrder: result.steps.length,
        stage,
        stageAssignments,
      });

    result.steps.push(...stageSteps);
    const failed = stageSteps.find((step) => step.status === 'failed');
    if (failed) {
      result.status = 'blocked';
      result.error = failed.error ?? `Collaboration stage ${stage.stage} failed`;
      result.completed_at = now();
      createSystemEvent(input.roomId, `轻量群聊协作已阻塞：${result.error}`, {
        event_type: 'collaboration_blocked',
        collaboration_run_id: input.runId,
        source_message_id: input.sourceMessage.id,
        failed_step_id: failed.id,
        error: result.error,
      });
      return result;
    }
  }

  result.status = 'completed';
  result.completed_at = now();
  createSystemEvent(input.roomId, '轻量群聊协作已完成', {
    event_type: 'collaboration_completed',
    collaboration_run_id: input.runId,
    source_message_id: input.sourceMessage.id,
  });
  return result;
}

async function runStageStepsSequentially(args: {
  input: RunCollaborationStagesInput;
  previousSteps: CollaborationStepResult[];
  runAgent: CollaborationAgentRunner;
  sortOrder: number;
  stage: CollaborationStagePlan;
  stageAssignments: CollaborationStageAssignment[];
}): Promise<CollaborationStepResult[]> {
  const steps: CollaborationStepResult[] = [];
  for (const [index, assignment] of args.stageAssignments.entries()) {
    const step = await runStageStep({
      ...args,
      assignment,
      previousSteps: [...args.previousSteps, ...steps],
      sortOrder: args.sortOrder + index,
    });
    steps.push(step);
    if (step.status === 'failed') break;
  }
  return steps;
}

async function runStageStep(args: {
  assignment: CollaborationStageAssignment;
  input: RunCollaborationStagesInput;
  previousSteps: CollaborationStepResult[];
  runAgent: CollaborationAgentRunner;
  sortOrder: number;
  stage: CollaborationStagePlan;
}): Promise<CollaborationStepResult> {
  const startedAt = now();
  const baseStep: CollaborationStepResult = {
    id: nanoid(16),
    collaboration_run_id: args.input.runId,
    stage: args.stage.stage,
    status: 'running',
    room_agent_id: args.assignment.agent.id,
    agent_id: args.assignment.agent.agent_id,
    agent_run_id: null,
    result_message_id: null,
    result_content: null,
    prompt: '',
    error: null,
    sort_order: args.sortOrder,
    started_at: startedAt,
    completed_at: null,
  };
  const agent = args.assignment.fallbackReason
    ? { ...args.assignment.agent, acp_session_id: null }
    : args.assignment.agent;

  const prompt = buildStagePrompt({
    agent,
    decision: args.input.decision,
    previousSteps: args.previousSteps,
    sourceMessage: args.input.sourceMessage,
    stage: args.stage,
    runId: args.input.runId,
    fallbackReason: args.assignment.fallbackReason,
  });

  try {
    const runResult = await args.runAgent({
      agent,
      projectPath: args.input.projectPath,
      roomId: args.input.roomId,
      prompt,
      collaborationRunId: args.input.runId,
      collaborationStage: args.stage.stage,
    });
    return {
      ...baseStep,
      status: runResult.status === 'completed' ? 'completed' : 'failed',
      agent_id: agent.agent_id,
      agent_run_id: runResult.run.id,
      result_message_id: runResult.message.id,
      result_content: runResult.message.content,
      prompt,
      error: runResult.status === 'completed'
        ? null
        : runResult.run.error ?? `${agent.agent_name} finished with status ${runResult.status}`,
      completed_at: now(),
    };
  } catch (error) {
    return {
      ...baseStep,
      status: 'failed',
      agent_id: agent.agent_id,
      prompt,
      error: formatUnknownError(error),
      completed_at: now(),
    };
  }
}

function buildStagePrompt(args: {
  agent: RoomAgent;
  decision: CollaborationDecision;
  previousSteps: CollaborationStepResult[];
  sourceMessage: Message;
  stage: CollaborationStagePlan;
  runId: string;
  fallbackReason: string | null;
}): string {
  const previousResults = args.previousSteps
    .filter((step) => step.status === 'completed' && step.result_message_id)
    .map((step) => [
      `- ${step.stage} / ${step.agent_id}: result_message_id=${step.result_message_id}`,
      step.result_content ? `  输出：${truncateForPrompt(step.result_content, 4000)}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n'))
    .join('\n');

  return [
    '你正在参与轻量群聊协作。',
    `协作运行：${args.runId}`,
    `协作阶段：${args.stage.stage}`,
    `目标智能体：${args.agent.agent_name} (${args.agent.agent_id})`,
    args.fallbackReason
      ? `补位说明：planner 作为 ${args.stage.stage} 阶段补位智能体。原计划智能体 unavailable：${args.fallbackReason}。本阶段必须使用独立新会话，不继承 planner 既有执行上下文。`
      : null,
    `阶段目标：${args.stage.goal}`,
    '',
    'Planner 决策摘要：',
    args.decision.summary,
    '',
    'Planner 决策理由：',
    args.decision.rationale,
    '',
    '用户原始消息：',
    args.sourceMessage.content,
    '',
    '已完成的上游步骤：',
    previousResults || '- 暂无',
  ].filter((line): line is string => line !== null).join('\n');
}

interface CollaborationStageAssignment {
  agent: RoomAgent;
  fallbackReason: string | null;
}

function buildStageAssignments(args: {
  agentsById: Map<string, RoomAgent>;
  plannerAgent: RoomAgent | null;
  stage: CollaborationStagePlan;
}): CollaborationStageAssignment[] {
  if (args.stage.agentIds.length === 0) {
    return args.plannerAgent
      ? [{ agent: args.plannerAgent, fallbackReason: 'no assigned agents' }]
      : [];
  }

  return args.stage.agentIds.flatMap((agentId): CollaborationStageAssignment[] => {
    const agent = args.agentsById.get(agentId);
    if (agent) return [{ agent, fallbackReason: null }];
    return args.plannerAgent
      ? [{ agent: args.plannerAgent, fallbackReason: agentId }]
      : [];
  });
}

async function defaultRunAgent(input: Parameters<CollaborationAgentRunner>[0]): ReturnType<CollaborationAgentRunner> {
  return runAgentOnce({
    agent: input.agent,
    projectPath: input.projectPath,
    roomId: input.roomId,
    prompt: input.prompt,
    collaborationRunId: input.collaborationRunId,
    collaborationStage: input.collaborationStage,
  });
}

function createSystemEvent(roomId: string, content: string, metadata: Record<string, unknown>): void {
  const message = messageRepo.create({
    room_id: roomId,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content,
    message_type: 'system',
    metadata,
  });
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message });
}

function truncateForPrompt(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[内容已截断]`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized) return serialized;
  } catch {
    // Fall through to String() below.
  }
  return String(error);
}
