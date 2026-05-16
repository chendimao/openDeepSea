import { db } from '../db.js';
import { messageRepo } from '../repos/messages.js';
import { roomRepo } from '../repos/rooms.js';
import { taskRepo } from '../repos/tasks.js';
import { workflowRepo } from '../repos/workflows.js';
import { recordTaskEvent } from '../task-conversation.js';
import type { Message, WorkflowRun } from '../types.js';
import { wsHub } from '../ws-hub.js';
import { getLangGraphWorkflowConfig } from './graph/runtime-config.js';
import {
  approveGraphWorkflowPlan,
  createGraphWorkflowRun as defaultCreateGraphWorkflowRun,
  enqueueGraphWorkflow as defaultEnqueueGraphWorkflow,
  validateGraphWorkflowApproval,
} from './graph/runtime.js';
import type { GraphRuntimeDeps } from './graph/tools.js';

export type WorkflowStartConversationSource = 'chat_command' | 'task_button' | 'auto_start';
export type WorkflowApprovalConversationSource = 'approval_button';

export interface StartWorkflowWithConversationInput {
  roomId: string;
  taskId: string;
  content?: string;
  senderId?: string;
  senderName?: string;
  sourceMessageId?: string;
  source: WorkflowStartConversationSource;
}

export interface ApproveWorkflowPlanWithConversationInput {
  roomId: string;
  workflowId: string;
  content?: string;
  senderId?: string;
  senderName?: string;
  source: WorkflowApprovalConversationSource;
}

interface WorkflowConversationDeps {
  createGraphWorkflowRun?: (taskId: string) => WorkflowRun;
  approveGraphWorkflowPlan?: (id: string, approvedBy?: string) => WorkflowRun;
  enqueueGraphWorkflow?: (runId: string, deps?: GraphRuntimeDeps) => void;
  graphRuntimeDeps?: GraphRuntimeDeps;
}

let workflowConversationDeps: WorkflowConversationDeps = {};

export class WorkflowConversationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkflowConversationError';
    this.status = status;
  }
}

export function setWorkflowConversationDeps(deps: WorkflowConversationDeps): void {
  workflowConversationDeps = deps;
}

export function startWorkflowWithConversation(input: StartWorkflowWithConversationInput): WorkflowRun {
  const { task } = requireTaskInRoom(input.roomId, input.taskId);
  validateSourceMessage(input.roomId, input.source, input.sourceMessageId);
  ensureGraphWorkflowEnabled();

  const replayed = findWorkflowStartedBySourceMessage(input.roomId, input.taskId, input.sourceMessageId);
  if (replayed) return replayed;

  const start = db.transaction(() => {
    const active = workflowRepo.getActiveByTask(task.id);
    if (active) {
      const event = recordTaskEvent({
        roomId: input.roomId,
        taskId: task.id,
        taskTitle: task.title,
        workflowRunId: active.id,
        eventType: 'workflow_blocked',
        content: `任务「${task.title}」已有运行中的工作流，不能重复启动。`,
      }, { broadcast: false });
      return { status: 'conflict' as const, event, message: 'task already has an active workflow' };
    }

    const latestTask = taskRepo.get(task.id);
    if (!latestTask || latestTask.room_id !== input.roomId) {
      throw new WorkflowConversationError(404, 'task not found');
    }
    if (latestTask.status === 'done') {
      const event = recordTaskEvent({
        roomId: input.roomId,
        taskId: latestTask.id,
        taskTitle: latestTask.title,
        eventType: 'workflow_blocked',
        content: `任务「${latestTask.title}」已完成，不能重复启动工作流。`,
      }, { broadcast: false });
      return { status: 'conflict' as const, event, message: 'task is already completed' };
    }

    const userMessage = maybeCreateStartIntentMessage(input, task.title);
    const run = createRun(task.id);
    const event = recordTaskEvent({
      roomId: input.roomId,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: run.id,
      eventType: 'workflow_started',
      content: `工作流已启动：${task.title}`,
      metadata: {
        workflow_source: input.source,
        workflow_source_message_id: input.sourceMessageId,
      },
    }, { broadcast: false });
    return { status: 'started' as const, run, userMessage, event };
  })();
  if (start.status === 'conflict') {
    broadcastMessage(input.roomId, start.event);
    throw new WorkflowConversationError(409, start.message);
  }
  const { run } = start;
  if (start.userMessage) broadcastMessage(input.roomId, start.userMessage);
  wsHub.broadcast(run.room_id, { type: 'workflow:created', roomId: run.room_id, workflow: run });
  broadcastMessage(input.roomId, start.event);
  enqueue(run.id);
  return run;
}

export function approveWorkflowPlanWithConversation(input: ApproveWorkflowPlanWithConversationInput): WorkflowRun {
  const { run, task } = requireWorkflowInRoom(input.roomId, input.workflowId);
  ensureGraphWorkflowEnabled();

  if (run.status !== 'awaiting_approval') {
    recordTaskEvent({
      roomId: input.roomId,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: run.id,
      eventType: 'workflow_blocked',
      content: `工作流当前状态为 ${run.status}，不能批准计划。`,
    });
    throw new WorkflowConversationError(409, 'workflow is not awaiting approval');
  }

  validateGraphWorkflowApproval(run.id);
  const approval = db.transaction(() => {
    const userMessage = createUserMessage({
      roomId: input.roomId,
      senderId: input.senderId ?? 'user',
      senderName: input.senderName ?? 'You',
      content: input.content?.trim() || `批准任务「${task.title}」的执行计划`,
      metadata: { workflow_run_id: run.id, task_id: task.id, source: input.source },
    });
    const approved = approvePlan(run.id, input.senderId ?? 'user');
    const event = recordTaskEvent({
      roomId: input.roomId,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: approved.id,
      eventType: 'workflow_stage_changed',
      content: `已批准任务「${task.title}」的执行计划，继续分配和执行。`,
    }, { broadcast: false });
    return { approved, userMessage, event };
  })();
  const { approved } = approval;
  broadcastMessage(input.roomId, approval.userMessage);
  wsHub.broadcast(approved.room_id, { type: 'workflow:updated', roomId: approved.room_id, workflow: approved });
  broadcastMessage(input.roomId, approval.event);
  enqueue(approved.id);
  return approved;
}

function requireTaskInRoom(roomId: string, taskId: string) {
  const room = roomRepo.get(roomId);
  if (!room) throw new WorkflowConversationError(404, 'room not found');
  const task = taskRepo.get(taskId);
  if (!task) throw new WorkflowConversationError(404, 'task not found');
  if (task.room_id !== roomId) throw new WorkflowConversationError(404, 'task room mismatch');
  return { room, task };
}

function requireWorkflowInRoom(roomId: string, workflowId: string) {
  const room = roomRepo.get(roomId);
  if (!room) throw new WorkflowConversationError(404, 'room not found');
  const run = workflowRepo.getRun(workflowId);
  if (!run) throw new WorkflowConversationError(404, 'workflow not found');
  if (run.room_id !== roomId) throw new WorkflowConversationError(404, 'workflow room mismatch');
  const task = taskRepo.get(run.task_id);
  if (!task) throw new WorkflowConversationError(404, 'task not found');
  return { room, run, task };
}

function validateSourceMessage(
  roomId: string,
  source: WorkflowStartConversationSource,
  sourceMessageId?: string,
): Message | null {
  if (!sourceMessageId) return null;
  const message = messageRepo.get(sourceMessageId);
  if (!message) throw new WorkflowConversationError(404, 'source message not found');
  if (message.room_id !== roomId) throw new WorkflowConversationError(404, 'source message room mismatch');
  if (source === 'chat_command' && message.sender_type !== 'user') {
    throw new WorkflowConversationError(400, 'source message is not a user message');
  }
  return message;
}

function maybeCreateStartIntentMessage(input: StartWorkflowWithConversationInput, taskTitle: string): Message | null {
  if (input.source === 'auto_start') return null;
  if (input.source === 'chat_command' && input.sourceMessageId) return null;
  const content = input.content?.trim() || `启动任务「${taskTitle}」的工作流`;
  return createUserMessage({
    roomId: input.roomId,
    senderId: input.senderId ?? 'user',
    senderName: input.senderName ?? 'You',
    content,
    metadata: {
      task_id: input.taskId,
      source: input.source,
    },
  });
}

function createUserMessage(input: {
  roomId: string;
  senderId: string;
  senderName: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Message {
  const message = messageRepo.create({
    room_id: input.roomId,
    sender_type: 'user',
    sender_id: input.senderId,
    sender_name: input.senderName,
    content: input.content,
    message_type: 'text',
    metadata: input.metadata,
  });
  return message;
}

function broadcastMessage(roomId: string, message: Message): void {
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message });
}

function ensureGraphWorkflowEnabled(): void {
  if (!getLangGraphWorkflowConfig().enabled) {
    throw new WorkflowConversationError(400, 'LangGraph workflow is not enabled');
  }
}

function createRun(taskId: string): WorkflowRun {
  const createGraphWorkflowRun = workflowConversationDeps.createGraphWorkflowRun ?? defaultCreateGraphWorkflowRun;
  return createGraphWorkflowRun(taskId);
}

function approvePlan(id: string, approvedBy: string): WorkflowRun {
  const approve = workflowConversationDeps.approveGraphWorkflowPlan ?? approveGraphWorkflowPlan;
  return approve(id, approvedBy);
}

function findWorkflowStartedBySourceMessage(
  roomId: string,
  taskId: string,
  sourceMessageId?: string,
): WorkflowRun | null {
  if (!sourceMessageId) return null;
  for (const message of messageRepo.listByRoom(roomId, 500)) {
    const metadata = parseMetadata(message.metadata);
    if (
      metadata?.event_type === 'workflow_started' &&
      metadata.task_id === taskId &&
      metadata.workflow_source_message_id === sourceMessageId &&
      typeof metadata.workflow_run_id === 'string'
    ) {
      return workflowRepo.getRun(metadata.workflow_run_id) ?? null;
    }
  }
  return null;
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function enqueue(runId: string): void {
  const enqueueGraphWorkflow = workflowConversationDeps.enqueueGraphWorkflow ?? defaultEnqueueGraphWorkflow;
  enqueueGraphWorkflow(runId, workflowConversationDeps.graphRuntimeDeps);
}
