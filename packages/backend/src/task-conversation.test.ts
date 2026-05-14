import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from './db.js';
import { createTaskWithConversation, recordTaskEvent } from './task-conversation.js';

function insertProjectAndRoom(): { projectId: string; roomId: string } {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const projectId = `project-${nonce}`;
  const roomId = `room-${nonce}`;
  const ts = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, path, description, message_routing_mode, fallback_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'mentions_only', NULL, ?, ?)`,
  ).run(projectId, projectId, `/tmp/${projectId}`, ts, ts);
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, description, created_at)
     VALUES (?, ?, 'Room', NULL, ?)`,
  ).run(roomId, projectId, ts);
  return { projectId, roomId };
}

test('createTaskWithConversation creates user message, task, and system task event', () => {
  const { roomId } = insertProjectAndRoom();
  const result = createTaskWithConversation({
    roomId,
    origin: 'manual',
    actor: { sender_id: 'user', sender_name: 'You' },
    taskInput: { title: '修复登录错误', priority: 'high' },
  });

  assert.equal(result.userMessage?.content, '创建任务：修复登录错误');
  assert.equal(result.task.title, '修复登录错误');
  assert.equal(result.task.priority, 'high');
  assert.equal(result.task.created_from, 'manual');
  assert.equal(result.task.source_message_id, result.userMessage?.id);
  assert.equal(result.systemMessage.sender_type, 'system');
  assert.equal(result.systemMessage.message_type, 'system');

  const metadata = JSON.parse(result.systemMessage.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(metadata.event_type, 'task_created');
  assert.equal(metadata.task_id, result.task.id);
  assert.equal(metadata.task_title, result.task.title);
  assert.equal(metadata.origin, 'manual');
});

test('recordTaskEvent persists workflow metadata on a system message', () => {
  const { roomId } = insertProjectAndRoom();
  const task = createTaskWithConversation({
    roomId,
    origin: 'slash_command',
    taskInput: { title: '补充测试' },
  }).task;

  const message = recordTaskEvent({
    roomId,
    taskId: task.id,
    taskTitle: task.title,
    workflowRunId: 'workflow-1',
    workflowStepId: 'step-1',
    eventType: 'workflow_stage_changed',
    content: '任务进入分析阶段',
  });

  const metadata = JSON.parse(message.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(metadata.task_id, task.id);
  assert.equal(metadata.workflow_run_id, 'workflow-1');
  assert.equal(metadata.workflow_step_id, 'step-1');
  assert.equal(metadata.event_type, 'workflow_stage_changed');
});
