import type {
  AgentRunStatus,
  RoomAgent,
  TaskActionKind,
  TaskActionStartResult,
  TaskWorkflowPlan,
} from './types.js';
import { agentRepo } from './repos/agents.js';
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
    const workflow = ensureFixedRosterWorkflow(input.roomId, task.title);
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'running', { workflow });
    return {
      action: input.action,
      status: 'running',
      workflow,
      message_id: messageId,
      run_ids: [],
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

function selectOrAddAgentByRole(roomId: string, role: 'executor' | 'reviewer' | 'acceptor'): RoomAgent {
  const existing = roomAgentRepo.listByRoom(roomId).find((agent) =>
    agent.workflow_role === role &&
    Boolean(agent.acp_enabled)
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
