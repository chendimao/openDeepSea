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

  createSystemEvent(input.roomId, '轻量群聊协作已开始', {
    event_type: 'collaboration_started',
    collaboration_run_id: input.runId,
    source_message_id: input.sourceMessage.id,
  });

  const invalidStage = input.decision.stages.find((stage) => stage.agentIds.length === 0);
  if (input.decision.stages.length === 0 || invalidStage) {
    result.status = 'blocked';
    result.error = invalidStage
      ? `Collaboration stage ${invalidStage.stage} has no agents`
      : 'Collaboration decision has no stages';
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
    const stageSteps = stage.parallel
      ? await Promise.all(stage.agentIds.map((agentId, index) => runStageStep({
        agentId,
        agentsById,
        input,
        previousSteps: result.steps,
        runAgent,
        sortOrder: result.steps.length + index,
        stage,
      })))
      : await runStageStepsSequentially({
        agentsById,
        input,
        previousSteps: result.steps,
        runAgent,
        sortOrder: result.steps.length,
        stage,
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
  agentsById: Map<string, RoomAgent>;
  input: RunCollaborationStagesInput;
  previousSteps: CollaborationStepResult[];
  runAgent: CollaborationAgentRunner;
  sortOrder: number;
  stage: CollaborationStagePlan;
}): Promise<CollaborationStepResult[]> {
  const steps: CollaborationStepResult[] = [];
  for (const [index, agentId] of args.stage.agentIds.entries()) {
    const step = await runStageStep({
      ...args,
      agentId,
      previousSteps: [...args.previousSteps, ...steps],
      sortOrder: args.sortOrder + index,
    });
    steps.push(step);
    if (step.status === 'failed') break;
  }
  return steps;
}

async function runStageStep(args: {
  agentId: string;
  agentsById: Map<string, RoomAgent>;
  input: RunCollaborationStagesInput;
  previousSteps: CollaborationStepResult[];
  runAgent: CollaborationAgentRunner;
  sortOrder: number;
  stage: CollaborationStagePlan;
}): Promise<CollaborationStepResult> {
  const startedAt = now();
  const agent = args.agentsById.get(args.agentId);
  const baseStep: CollaborationStepResult = {
    id: nanoid(16),
    collaboration_run_id: args.input.runId,
    stage: args.stage.stage,
    status: 'running',
    room_agent_id: agent?.id ?? null,
    agent_id: args.agentId,
    agent_run_id: null,
    result_message_id: null,
    result_content: null,
    prompt: '',
    error: null,
    sort_order: args.sortOrder,
    started_at: startedAt,
    completed_at: null,
  };

  if (!agent) {
    return {
      ...baseStep,
      status: 'failed',
      error: `Collaboration agent not found: ${args.agentId}`,
      completed_at: now(),
    };
  }

  const prompt = buildStagePrompt({
    agent,
    decision: args.input.decision,
    previousSteps: args.previousSteps,
    sourceMessage: args.input.sourceMessage,
    stage: args.stage,
    runId: args.input.runId,
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
  ].join('\n');
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
