import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowIncident } from '../types.js';
import type { WorkflowRecoveryDecision } from './recovery-supervisor.js';

const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-recovery-executor-'));
const projectDir = join(tempDir, 'project');
mkdirSync(projectDir);
process.env.OPENCLAW_ROOM_DB = join(tempDir, 'test.db');

const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowIncidentRepo } = await import('../repos/workflow-incidents.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { executeRecoveryDecision } = await import('./recovery-executor.js');

test('executeRecoveryDecision retries same agent and records recovery message', async () => {
  const fixture = createFixture('retry same');
  assert.ok(fixture.agent);
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    status: 'interrupted',
    room_agent_id: fixture.agent.id,
    prompt: 'interrupted',
    sort_order: 1,
  });
  const incident = createIncident(fixture, {
    workflow_step_id: step.id,
    child_task_id: fixture.childTask.id,
    room_agent_id: fixture.agent.id,
    incident_type: 'backend_restart_interrupted',
    error: 'Backend restarted before workflow step completed',
  });

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('retry_same_agent'),
  });

  assert.equal(result.status, 'executed');
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
  assert.equal(workflowIncidentRepo.get(incident.id)?.attempt_count, 1);
  assert.equal(workflowRepo.getStep(step.id)?.status, 'skipped');
  assert.equal(taskRepo.get(fixture.childTask.id)?.status, 'todo');
  assert.match(latestRecoveryMessage(fixture.room.id), /产品经理检测到子任务/);
  assert.match(latestRecoveryMessage(fixture.room.id), /retry_same_agent/);
});

test('executeRecoveryDecision provisions global executor then retries workflow', async () => {
  const fixture = createFixture('global retry', { createAgent: false });
  const incident = createIncident(fixture, {
    incident_type: 'executor_unavailable',
    error: 'No executor available for implementation',
    context: {
      childTask: { title: fixture.childTask.title, description: fixture.childTask.description },
      workflowStep: { scopeWrite: ['packages/backend/src/repos/assets.ts'] },
    },
  });

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('retry_with_global_agent'),
  });

  assert.equal(result.status, 'executed');
  assert.ok(roomAgentRepo.listByRoom(fixture.room.id).some((agent) => agent.agent_id === 'backend-executor'));
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
});

test('executeRecoveryDecision reassigns child task before retrying', async () => {
  const fixture = createFixture('reassign');
  assert.ok(fixture.agent);
  const other = configureExecutor(roomAgentRepo.add({
    room_id: fixture.room.id,
    agent_id: 'backend-reassign',
    agent_name: 'Backend Reassign',
  }));
  const incident = createIncident(fixture, {
    incident_type: 'runtime_boundary_mismatch',
    child_task_id: fixture.childTask.id,
    room_agent_id: fixture.agent.id,
  });

  const result = await executeRecoveryDecision({
    incident,
    decision: {
      ...decision('reassign_agent'),
      targetRoomAgentId: other.id,
    },
  });

  assert.equal(result.status, 'executed');
  assert.equal(taskRepo.get(fixture.childTask.id)?.assigned_agent_id, other.id);
});

test('executeRecoveryDecision splits task idempotently', async () => {
  const fixture = createFixture('split');
  const incident = createIncident(fixture, {
    incident_type: 'child_task_failed',
    child_task_id: fixture.childTask.id,
  });
  const splitDecision: WorkflowRecoveryDecision = {
    ...decision('split_task'),
    splitTasks: [
      { title: '拆分模型', description: '实现模型', scopeRead: ['db.ts'], scopeWrite: ['repos/assets.ts'] },
      { title: '拆分接口', description: '实现接口', scopeRead: ['server.ts'], scopeWrite: ['routes/assets.ts'] },
    ],
  };

  await executeRecoveryDecision({ incident, decision: splitDecision });
  await executeRecoveryDecision({ incident, decision: splitDecision });

  const children = taskRepo.listChildren(fixture.task.id).filter((task) => task.title.startsWith('拆分'));
  assert.equal(children.length, 2);
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.status, 'awaiting_decision');
});

test('executeRecoveryDecision asks user idempotently', async () => {
  const fixture = createFixture('ask user');
  const incident = createIncident(fixture, { incident_type: 'backend_restart_interrupted' });
  const askDecision: WorkflowRecoveryDecision = {
    ...decision('ask_user'),
    userQuestion: '是否换一个后端执行智能体？',
  };

  await executeRecoveryDecision({ incident, decision: askDecision });
  await executeRecoveryDecision({ incident, decision: askDecision });

  const messages = recoveryMessages(fixture.room.id);
  assert.equal(messages.length, 1);
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.status, 'awaiting_decision');
  assert.match(messages[0]?.content ?? '', /是否换一个后端执行智能体/);
});

test('executeRecoveryDecision marks workflow blocked', async () => {
  const fixture = createFixture('blocked');
  const incident = createIncident(fixture, { incident_type: 'unknown' });

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('mark_blocked'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'blocked');
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.status, 'blocked');
  assert.match(latestRecoveryMessage(fixture.room.id), /mark_blocked/);
});

function createFixture(name: string, options: { createAgent?: boolean } = {}) {
  const fixtureProjectDir = join(projectDir, name.replace(/\s+/g, '-'));
  mkdirSync(fixtureProjectDir, { recursive: true });
  const project = projectRepo.create({ name: `Project ${name}`, path: fixtureProjectDir });
  const room = roomRepo.create({ project_id: project.id, name: `Room ${name}` });
  const agent = options.createAgent === false
    ? null
    : configureExecutor(roomAgentRepo.add({
      room_id: room.id,
      agent_id: `codex-${name.replace(/\s+/g, '-')}`,
      agent_name: 'Codex Agent',
    }));
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: `Parent ${name}`,
  });
  taskRepo.updateStatus(task.id, 'in_progress');
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: `Child ${name}`,
    description: 'packages/backend implementation',
    assigned_agent_id: agent?.id,
  });
  taskRepo.updateStatus(childTask.id, 'in_progress');
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'blocked',
    current_stage: 'implementation',
  });
  return { project, room, agent, task, childTask, workflow };
}

function createIncident(
  fixture: ReturnType<typeof createFixture>,
  patch: Partial<Parameters<typeof workflowIncidentRepo.upsertDetected>[0]> = {},
): WorkflowIncident {
  return workflowIncidentRepo.upsertDetected({
    room_id: fixture.room.id,
    project_id: fixture.project.id,
    workflow_run_id: fixture.workflow.id,
    workflow_step_id: null,
    task_id: fixture.task.id,
    child_task_id: fixture.childTask.id,
    agent_run_id: null,
    room_agent_id: fixture.agent?.id ?? null,
    incident_type: 'backend_restart_interrupted',
    error: 'Backend restarted before workflow step completed',
    context: {
      task: { title: fixture.task.title },
      childTask: { title: fixture.childTask.title, description: fixture.childTask.description },
      workflowStep: { scopeRead: [], scopeWrite: ['packages/backend/src'] },
    },
    ...patch,
  });
}

function configureExecutor(agent: ReturnType<typeof roomAgentRepo.add>) {
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, 'executor') ?? agent;
  const withAcp = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  }) ?? withRole;
  return roomAgentRepo.setCapabilitiesAndRuntime(withAcp.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
  }) ?? withAcp;
}

function decision(action: WorkflowRecoveryDecision['action']): WorkflowRecoveryDecision {
  return {
    action,
    reason: `test reason for ${action}`,
    confidence: 0.8,
  };
}

function recoveryMessages(roomId: string) {
  return messageRepo.listByRoom(roomId).filter((message) => {
    if (!message.metadata) return false;
    const metadata = JSON.parse(message.metadata) as Record<string, unknown>;
    return metadata.event_type === 'workflow_recovery_decided';
  });
}

function latestRecoveryMessage(roomId: string): string {
  return recoveryMessages(roomId).at(-1)?.content ?? '';
}
