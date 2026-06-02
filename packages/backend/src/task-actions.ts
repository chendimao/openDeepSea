import type {
  AgentRunStatus,
  RoomAgent,
  TaskActionKind,
  TaskActionStartResult,
  TaskWorkflowPlan,
} from './types.js';
import { agentRepo } from './repos/agents.js';
import { respondAsAgent } from './dispatcher.js';
import { projectRepo } from './repos/projects.js';
import { messageRepo } from './repos/messages.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { taskEventRepo } from './repos/task-events.js';
import { taskRepo } from './repos/tasks.js';
import { wsHub } from './ws-hub.js';

export interface TaskActionAgentResult {
  status: AgentRunStatus | 'failed';
  content: string;
  error: string | null;
  runId?: string;
  messageId?: string;
}

export interface TaskActionRunAgentInput {
  agent: RoomAgent;
  prompt: string;
  taskId: string;
  sourceMessageId?: string | null;
}

export interface StartTaskActionInput {
  roomId: string;
  taskId: string;
  action: TaskActionKind;
  senderId?: string;
  senderName?: string;
  runAgent?: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}

export async function startTaskAction(input: StartTaskActionInput): Promise<TaskActionStartResult> {
  const task = taskRepo.get(input.taskId);
  if (!task || task.room_id !== input.roomId) throw new Error('task not found');
  const room = roomRepo.get(input.roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');

  if (input.action === 'start_execution') {
    recordTaskActionEvent(input.roomId, input.taskId, input.action, 'running', {});
    let workflow: TaskWorkflowPlan;
    try {
      workflow = ensureFixedRosterWorkflow(input.roomId, task.title);
    } catch (error) {
      const blockedReason = toErrorMessage(error, 'locked roster could not be created');
      const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
        blocked_reason: blockedReason,
        error: blockedReason,
      });
      return {
        action: input.action,
        status: 'blocked',
        message_id: messageId,
        run_ids: [],
        blocked_reason: blockedReason,
      };
    }
    const stageResult = await runLockedRosterStagesSafely({
      roomId: input.roomId,
      taskId: input.taskId,
      workflow,
      sourceMessageId: task.source_message_id,
      runAgent: input.runAgent ?? defaultRunAgent,
    });
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, stageResult.status, {
      workflow,
      run_ids: stageResult.runIds,
      error: stageResult.error,
      blocked_reason: stageResult.status === 'blocked' ? stageResult.error : undefined,
    });
    return {
      action: input.action,
      status: stageResult.status,
      workflow,
      message_id: messageId,
      run_ids: stageResult.runIds,
      blocked_reason: stageResult.status === 'blocked' ? stageResult.error ?? undefined : undefined,
    };
  }

  const blockedReason = 'task action phase is not implemented yet';
  const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
    blocked_reason: blockedReason,
  });
  return {
    action: input.action,
    status: 'blocked',
    message_id: messageId,
    run_ids: [],
    blocked_reason: blockedReason,
  };
}

function ensureFixedRosterWorkflow(roomId: string, taskTitle: string): TaskWorkflowPlan {
  const executor = selectOrAddAgentByRole(roomId, 'executor');
  const reviewer = selectOrAddAgentByRole(roomId, 'reviewer');
  const acceptor = selectOrAddAgentByRole(roomId, 'acceptor');
  return {
    mode: 'fixed_roster',
    entry_action: 'start_execution',
    locked: true,
    agents: [
      { agent_id: executor.agent_id, room_agent_id: executor.id, role: 'executor' },
      { agent_id: reviewer.agent_id, room_agent_id: reviewer.id, role: 'reviewer' },
      { agent_id: acceptor.agent_id, room_agent_id: acceptor.id, role: 'acceptor' },
    ],
    stages: [
      { id: 'execute', agent_ids: [executor.agent_id], parallel: false, goal: `实现任务：${taskTitle}` },
      { id: 'review', agent_ids: [reviewer.agent_id], parallel: false, goal: `审查任务实现：${taskTitle}` },
      { id: 'acceptance', agent_ids: [acceptor.agent_id], parallel: false, goal: `验收任务结果：${taskTitle}` },
    ],
  };
}

async function defaultRunAgent(input: TaskActionRunAgentInput): Promise<TaskActionAgentResult> {
  const room = roomRepo.get(input.agent.room_id);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');

  let finalRunId: string | undefined;
  let finalMessageId: string | undefined;
  let finalStatus: AgentRunStatus | 'failed' = 'failed';
  let finalContent = '';
  let finalError: string | null = null;

  await respondAsAgent({
    agent: input.agent,
    projectPath: project.path,
    roomId: room.id,
    prompt: input.prompt,
    taskId: input.taskId,
    sourceMessageId: input.sourceMessageId,
    onFinished: ({ run, message, status }) => {
      finalRunId = run.id;
      finalMessageId = message.id;
      finalStatus = status;
      finalContent = message.content;
      finalError = run.error;
    },
  });

  return {
    status: finalStatus,
    content: finalContent,
    error: finalError,
    runId: finalRunId,
    messageId: finalMessageId,
  };
}

async function runLockedRosterStages(input: {
  roomId: string;
  taskId: string;
  workflow: TaskWorkflowPlan;
  sourceMessageId?: string | null;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<{ status: 'completed' | 'failed' | 'blocked'; runIds: string[]; error: string | null }> {
  const runIds: string[] = [];
  const outputs: string[] = [];

  for (const stage of input.workflow.stages) {
    for (const agentId of stage.agent_ids) {
      const lockedAgent = input.workflow.agents.find((candidate) => candidate.agent_id === agentId);
      if (!lockedAgent) return { status: 'blocked', runIds, error: `locked roster agent missing: ${agentId}` };
      const agent = roomAgentRepo.get(lockedAgent.room_agent_id);
      if (!agent || agent.room_id !== input.roomId || agent.left_at !== null) {
        return { status: 'blocked', runIds, error: `locked roster agent unavailable: ${agentId}` };
      }
      if (agent.agent_id !== lockedAgent.agent_id || !agent.acp_enabled || !agent.acp_backend) {
        return { status: 'blocked', runIds, error: `locked roster agent not executable: ${agentId}` };
      }
      let result: TaskActionAgentResult;
      try {
        result = await input.runAgent({
          agent,
          taskId: input.taskId,
          sourceMessageId: input.sourceMessageId,
          prompt: buildLockedStagePrompt(stage.id, stage.goal, outputs),
        });
      } catch (error) {
        return {
          status: 'failed',
          runIds,
          error: error instanceof Error ? error.message : `${agent.agent_id} failed`,
        };
      }
      if (result.runId) runIds.push(result.runId);
      outputs.push(`${agent.agent_id}: ${result.content}`);
      if (result.status !== 'completed') {
        return { status: 'failed', runIds, error: result.error ?? `${agent.agent_id} failed` };
      }
    }
  }

  return { status: 'completed', runIds, error: null };
}

function buildLockedStagePrompt(stageId: string, goal: string, previousOutputs: string[]): string {
  return [
    `固定编队阶段：${stageId}`,
    `阶段目标：${goal}`,
    '本任务已锁定完整 roster。你不能要求新增智能体；如果发现缺人，说明阻塞原因，不要输出新增 agent 的 task_execution。',
    '',
    previousOutputs.length > 0 ? `前序阶段输出：\n${previousOutputs.join('\n\n')}` : '前序阶段输出：无',
  ].join('\n');
}

function selectOrAddAgentByRole(roomId: string, role: 'executor' | 'reviewer' | 'acceptor'): RoomAgent {
  const existing = roomAgentRepo.listByRoom(roomId).find((agent) =>
    agent.workflow_role === role &&
    Boolean(agent.acp_enabled) &&
    Boolean(agent.acp_backend)
  );
  if (existing) return existing;
  const fallbackId = role === 'executor' ? 'backend-executor' : role;
  const globalAgent = agentRepo.getByAgentId(fallbackId) ?? agentRepo.getByBuiltinKey(fallbackId);
  if (!globalAgent) throw new Error(`no ${role} agent available`);
  const added = globalAgent.builtin_key
    ? roomAgentRepo.ensureBuiltInAgent(roomId, globalAgent.builtin_key)
    : roomAgentRepo.addFromGlobalAgent({ room_id: roomId, global_agent_id: globalAgent.id });
  if (!added.acp_enabled || !added.acp_backend) throw new Error(`no executable ${role} agent available`);
  return added;
}

async function runLockedRosterStagesSafely(input: {
  roomId: string;
  taskId: string;
  workflow: TaskWorkflowPlan;
  sourceMessageId?: string | null;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<{ status: 'completed' | 'failed' | 'blocked'; runIds: string[]; error: string | null }> {
  try {
    return await runLockedRosterStages(input);
  } catch (error) {
    return {
      status: 'failed',
      runIds: [],
      error: toErrorMessage(error, 'locked roster stage failed'),
    };
  }
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function recordTaskActionEvent(
  roomId: string,
  taskId: string,
  action: TaskActionKind,
  status: Exclude<TaskActionStartResult['status'], 'queued'>,
  metadata: Record<string, unknown>,
): string {
  const task = taskRepo.get(taskId);
  const content = `任务动作 ${action} 已进入 ${status}`;
  const message = messageRepo.create({
    room_id: roomId,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content,
    message_type: 'system',
    layer: 'timeline',
    metadata: {
      task_id: taskId,
      event_type: 'task_updated',
      task_action: action,
      task_action_status: status,
      task_title: task?.title,
      ...metadata,
    },
  });
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message });
  const event = taskEventRepo.create({
    room_id: roomId,
    task_id: taskId,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action,
      status,
      message_id: message.id,
      event_message_id: message.id,
      content,
      task_title: task?.title,
      ...metadata,
    },
  });
  wsHub.broadcast(roomId, { type: 'task_event:new', roomId, event });
  return message.id;
}
