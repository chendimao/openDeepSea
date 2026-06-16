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
const { agentRunRepo } = await import('../repos/agent-runs.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { taskEventRepo } = await import('../repos/task-events.js');
const { workflowIncidentRepo } = await import('../repos/workflow-incidents.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { executeRecoveryDecision } = await import('./recovery-executor.js');
const { emptyAgentWorkflowState, parseGraphState, serializeGraphState } = await import('./graph/state.js');

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
    retryWorkflowStep: retryWithoutStartingAgent,
  });

  assert.equal(result.status, 'executed');
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
  assert.equal(workflowIncidentRepo.get(incident.id)?.attempt_count, 1);
  assert.equal(workflowRepo.getStep(step.id)?.status, 'skipped');
  assert.equal(taskRepo.get(fixture.childTask.id)?.status, 'todo');
  assert.equal(
    taskEventRepo.listByTask(fixture.childTask.id).some((event) =>
      event.type === 'task_status_changed' &&
      event.payload.previous_status === 'in_progress' &&
      event.payload.next_status === 'todo' &&
      event.payload.recovery_action === 'retry_same_agent',
    ),
    true,
  );
  assert.match(latestRecoveryMessage(fixture.room.id), /产品经理检测到子任务/);
  assert.match(latestRecoveryMessage(fixture.room.id), /retry_same_agent/);
});

test('executeRecoveryDecision reuses one recovery message for repeated workflow gate failures', async () => {
  const fixture = createFixture('repeat gate failure');
  assert.ok(fixture.agent);
  const firstStep = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'planning',
    node_name: 'brainstorming',
    status: 'failed',
    room_agent_id: fixture.agent.id,
    prompt: 'first planning attempt',
    sort_order: 1,
  });
  workflowRepo.updateStep(firstStep.id, { error: 'missing required evidence: designDocPath' });
  const firstIncident = createIncident(fixture, {
    workflow_step_id: firstStep.id,
    child_task_id: null,
    incident_type: 'planner_output_invalid',
    error: 'missing required evidence: designDocPath',
  });

  await executeRecoveryDecision({
    incident: firstIncident,
    decision: decision('retry_same_agent'),
    retryWorkflowStep: retryWithoutStartingAgent,
  });

  const secondStep = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'planning',
    node_name: 'brainstorming',
    status: 'failed',
    room_agent_id: fixture.agent.id,
    prompt: 'second planning attempt',
    sort_order: 2,
  });
  workflowRepo.updateStep(secondStep.id, { error: 'missing required evidence: designDocPath' });
  const secondIncident = createIncident(fixture, {
    workflow_step_id: secondStep.id,
    child_task_id: null,
    incident_type: 'planner_output_invalid',
    error: 'missing required evidence: designDocPath',
  });

  await executeRecoveryDecision({
    incident: secondIncident,
    decision: decision('retry_same_agent'),
    retryWorkflowStep: retryWithoutStartingAgent,
  });

  const messages = recoveryMessages(fixture.room.id);
  assert.equal(messages.length, 1);
  assert.equal(workflowIncidentRepo.get(secondIncident.id)?.last_message_id, messages[0]?.id);
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
    retryWorkflowStep: retryWithoutStartingAgent,
  });

  assert.equal(result.status, 'executed');
  assert.ok(roomAgentRepo.listByRoom(fixture.room.id).some((agent) => agent.agent_id === 'backend-executor'));
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
});

test('executeRecoveryDecision reassigns child task before retrying', async () => {
  const fixture = createFixture('reassign');
  assert.ok(fixture.agent);
  const originalAgent = fixture.agent;
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
    retryWorkflowStep: retryWithoutStartingAgent,
  });

  assert.equal(result.status, 'executed');
  assert.equal(taskRepo.get(fixture.childTask.id)?.assigned_agent_id, other.id);
  assert.equal(
    taskEventRepo.listByTask(fixture.childTask.id).some((event) =>
      event.type === 'task_updated' &&
      Array.isArray(event.payload.changed_fields) &&
      event.payload.changed_fields.includes('assigned_agent_id') &&
      event.payload.previous_assigned_agent_id === originalAgent.id &&
      event.payload.next_assigned_agent_id === other.id &&
      event.payload.recovery_action === 'reassign_agent',
    ),
    true,
  );
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
  assert.equal(children.every((child) =>
    taskEventRepo.listByTask(child.id).some((event) =>
      event.type === 'task_created' &&
      event.payload.origin === 'workflow_assignment' &&
      event.payload.incident_id === incident.id,
    ),
  ), true);
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

test('executeRecoveryDecision does not block a workflow already awaiting user decision in graph state', async () => {
  const fixture = createFixture('already awaiting decision');
  workflowRepo.updateGraphState(fixture.workflow.id, serializeGraphState({
    ...emptyAgentWorkflowState({
      workflowRunId: fixture.workflow.id,
      projectId: fixture.project.id,
      roomId: fixture.room.id,
      taskId: fixture.task.id,
      userGoal: fixture.task.title,
      projectPath: fixture.project.path,
    }),
    status: 'awaiting_decision',
    currentNode: 'acceptance',
    superpowersPhase: 'finish_branch',
    finishBranchDecision: {
      decision: null,
      options: ['merge_local', 'create_pr', 'keep_branch', 'discard_work'],
      reason: '等待用户选择分支收尾方式',
      decidedAt: null,
    },
  }));
  const incident = createIncident(fixture, { incident_type: 'unknown' });

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('mark_blocked'),
  });

  assert.equal(result.status, 'noop');
  assert.equal(result.detail, 'workflow is already awaiting user decision');
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.status, 'awaiting_decision');
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.error, null);
  assert.equal(recoveryMessages(fixture.room.id).length, 0);
});

test('executeRecoveryDecision restores finish branch approval gate even when graph state is stale blocked', async () => {
  const fixture = createFixture('stale blocked finish branch gate');
  workflowRepo.updateGraphState(fixture.workflow.id, serializeGraphState({
    ...emptyAgentWorkflowState({
      workflowRunId: fixture.workflow.id,
      projectId: fixture.project.id,
      roomId: fixture.room.id,
      taskId: fixture.task.id,
      userGoal: fixture.task.title,
      projectPath: fixture.project.path,
    }),
    status: 'blocked',
    currentNode: 'verify',
    superpowersPhase: 'code_quality_review',
    activeSuperpowersStage: 'code_quality_review',
    error: 'Verification failed: npm run build',
  }));
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.task.id,
    stage: 'acceptance',
    node_name: 'finish_branch',
    status: 'awaiting_approval',
    sort_order: 1,
  });
  workflowRepo.updateRun(fixture.workflow.id, {
    status: 'blocked',
    current_stage: 'acceptance',
    error: '未识别或高风险的工作流异常：unknown，默认阻塞并等待人工处理。',
  });
  const incident = createIncident(fixture, {
    workflow_step_id: step.id,
    child_task_id: null,
    incident_type: 'unknown',
    error: '未识别或高风险的工作流异常：unknown，默认阻塞并等待人工处理。',
  });

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('mark_blocked'),
  });

  const latestRun = workflowRepo.getRun(fixture.workflow.id);
  const latestState = parseGraphState(latestRun?.graph_state ?? null);
  assert.equal(result.status, 'noop');
  assert.equal(result.detail, 'workflow is already awaiting user decision');
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
  assert.equal(latestRun?.status, 'awaiting_decision');
  assert.equal(latestRun?.current_stage, 'acceptance');
  assert.equal(latestRun?.error, null);
  assert.equal(latestState?.status, 'awaiting_decision');
  assert.equal(latestState?.currentNode, 'acceptance');
  assert.equal(latestState?.currentStepId, step.id);
  assert.equal(latestState?.superpowersPhase, 'finish_branch');
  assert.equal(latestState?.activeSuperpowersStage, 'finish_branch');
  assert.equal(latestState?.finishBranchDecision?.decision, null);
  assert.equal(recoveryMessages(fixture.room.id).length, 0);
});

test('executeRecoveryDecision does not retry a workflow already awaiting user decision in graph state', async () => {
  const fixture = createFixture('already awaiting retry');
  workflowRepo.updateGraphState(fixture.workflow.id, serializeGraphState({
    ...emptyAgentWorkflowState({
      workflowRunId: fixture.workflow.id,
      projectId: fixture.project.id,
      roomId: fixture.room.id,
      taskId: fixture.task.id,
      userGoal: fixture.task.title,
      projectPath: fixture.project.path,
    }),
    status: 'awaiting_decision',
    currentNode: 'acceptance',
    superpowersPhase: 'finish_branch',
    finishBranchDecision: {
      decision: null,
      options: ['merge_local', 'create_pr', 'keep_branch', 'discard_work'],
      reason: '等待用户选择分支收尾方式',
      decidedAt: null,
    },
  }));
  const incident = createIncident(fixture, { incident_type: 'agent_run_stale', error: 'Process exited with code 130' });
  let retried = false;

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('retry_same_agent'),
    retryWorkflowStep: async (workflowRunId) => {
      retried = true;
      return retryWithoutStartingAgent(workflowRunId);
    },
  });

  assert.equal(result.status, 'noop');
  assert.equal(result.detail, 'workflow is already awaiting user decision');
  assert.equal(retried, false);
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.status, 'awaiting_decision');
  assert.equal(workflowRepo.getRun(fixture.workflow.id)?.error, null);
  assert.equal(recoveryMessages(fixture.room.id).length, 0);
});

test('executeRecoveryDecision interrupts the stale active agent run before retrying workflow', async () => {
  const fixture = createFixture('stale active retry');
  assert.ok(fixture.agent);
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: fixture.agent.id,
    prompt: 'stale implementation',
    sort_order: 1,
  });
  const activeRun = agentRunRepo.create({
    room_id: fixture.room.id,
    room_agent_id: fixture.agent.id,
    agent_id: fixture.agent.agent_id,
    backend: 'codex',
    task_id: fixture.childTask.id,
    workflow_run_id: fixture.workflow.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'stale implementation',
  });
  workflowRepo.updateStep(step.id, { agent_run_id: activeRun.id });
  const incident = createIncident(fixture, {
    workflow_step_id: step.id,
    child_task_id: fixture.childTask.id,
    agent_run_id: activeRun.id,
    room_agent_id: fixture.agent.id,
    incident_type: 'agent_run_stale',
    error: 'Agent run has not updated for 300000ms',
  });
  let retried = false;

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('retry_same_agent'),
    retryWorkflowStep: async (workflowRunId) => {
      retried = true;
      return retryWithoutStartingAgent(workflowRunId);
    },
  });

  assert.equal(result.status, 'executed');
  assert.equal(retried, true);
  assert.equal(agentRunRepo.get(activeRun.id)?.status, 'interrupted');
  assert.match(agentRunRepo.get(activeRun.id)?.error ?? '', /Agent run has not updated/);
  assert.equal(agentRunRepo.listActiveByWorkflow(fixture.workflow.id).length, 0);
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
});

test('executeRecoveryDecision interrupts a stale local running workflow step before retrying workflow', async () => {
  const fixture = createFixture('stale local verify');
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.task.id,
    stage: 'code_review',
    node_name: 'verify',
    status: 'running',
    prompt: 'local verify',
    sort_order: 1,
  });
  const incident = createIncident(fixture, {
    workflow_step_id: step.id,
    child_task_id: null,
    agent_run_id: null,
    room_agent_id: null,
    incident_type: 'step_without_active_run',
    error: `Workflow verify step ${step.id} (running) is stale without an active agent run`,
  });
  let retried = false;

  const result = await executeRecoveryDecision({
    incident,
    decision: decision('retry_same_agent'),
    retryWorkflowStep: async (workflowRunId) => {
      retried = true;
      return retryWithoutStartingAgent(workflowRunId);
    },
  });

  assert.equal(result.status, 'executed');
  assert.equal(retried, true);
  assert.equal(workflowRepo.getStep(step.id)?.status, 'skipped');
  assert.match(workflowRepo.getStep(step.id)?.error ?? '', /stale without an active agent run/);
  assert.equal(workflowIncidentRepo.get(incident.id)?.status, 'resolved');
});

test('executeRecoveryDecision restores blocked workflow state when retry execution throws', async () => {
  const fixture = createFixture('retry throws');
  assert.ok(fixture.agent);
  workflowRepo.updateGraphState(fixture.workflow.id, serializeGraphState({
    ...emptyAgentWorkflowState({
      workflowRunId: fixture.workflow.id,
      projectId: fixture.project.id,
      roomId: fixture.room.id,
      taskId: fixture.task.id,
      userGoal: fixture.task.title,
      projectPath: fixture.project.path,
    }),
    currentNode: 'execute',
    status: 'blocked',
    error: 'Selected model is at capacity',
    childTaskIds: [fixture.childTask.id],
  }));
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    node_name: 'tdd_execute',
    status: 'failed',
    room_agent_id: fixture.agent.id,
    prompt: 'failed implementation',
    sort_order: 1,
  });
  workflowRepo.updateStep(step.id, { error: 'Selected model is at capacity' });
  const incident = createIncident(fixture, {
    workflow_step_id: step.id,
    child_task_id: fixture.childTask.id,
    room_agent_id: fixture.agent.id,
    incident_type: 'agent_run_stale',
    error: 'Selected model is at capacity. Some(ServerOverloaded)',
  });

  await assert.rejects(
    executeRecoveryDecision({
      incident,
      decision: decision('retry_same_agent'),
      retryWorkflowStep: async (workflowRunId) => {
        workflowRepo.updateRun(workflowRunId, { status: 'running', error: null });
        workflowRepo.updateGraphState(workflowRunId, serializeGraphState({
          ...emptyAgentWorkflowState({
            workflowRunId,
            projectId: fixture.project.id,
            roomId: fixture.room.id,
            taskId: fixture.task.id,
            userGoal: fixture.task.title,
            projectPath: fixture.project.path,
          }),
          currentNode: 'execute',
          status: 'running',
          error: null,
          activeAgentRunId: null,
          childTaskIds: [fixture.childTask.id],
        }));
        throw new Error('graph retry exceeded resume limit');
      },
    }),
    /graph retry exceeded resume limit/,
  );

  const latestRun = workflowRepo.getRun(fixture.workflow.id);
  const latestState = parseGraphState(latestRun?.graph_state ?? null);
  assert.equal(latestRun?.status, 'blocked');
  assert.match(latestRun?.error ?? '', /自动恢复执行失败：graph retry exceeded resume limit/);
  assert.equal(latestState?.status, 'blocked');
  assert.equal(latestState?.activeAgentRunId, null);
  assert.match(latestState?.error ?? '', /自动恢复执行失败：graph retry exceeded resume limit/);
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

async function retryWithoutStartingAgent(workflowRunId: string) {
  const run = workflowRepo.getRun(workflowRunId);
  if (!run) throw new Error('workflow not found');
  const retryableStep = [...workflowRepo.listSteps(workflowRunId)]
    .reverse()
    .find((step) => step.status === 'failed' || step.status === 'cancelled' || step.status === 'interrupted');
  if (retryableStep) {
    workflowRepo.updateStep(retryableStep.id, {
      status: 'skipped',
      error: retryableStep.error ?? 'Superseded by test retry',
    });
  }
  return workflowRepo.updateRun(workflowRunId, { status: 'running', error: null }) ?? run;
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
