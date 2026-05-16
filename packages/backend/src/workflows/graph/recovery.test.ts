import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-recovery-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { memoryRepo } = await import('../../repos/memory.js');
const { createGraphNodes } = await import('./nodes.js');
const { createGraphTools } = await import('./tools.js');
const { parseGraphState } = await import('./state.js');
const { recoverGraphWorkflow } = await import('./runtime.js');

test('memory node stores accepted task summary and completes graph state', async () => {
  const projectPath = join(tmpdir(), `graph-memory-node-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Memory Node', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Memory Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Memory acceptance task',
    description: 'Ensure memory node writes task summary.',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'acceptance',
    graph_version: 'phase-b-v1',
  });
  workflowRepo.createArtifact({
    task_id: task.id,
    workflow_run_id: run.id,
    artifact_type: 'acceptance',
    title: '功能验收',
    content: JSON.stringify({
      verdict: 'pass',
      acceptedCriteria: ['summary sourced from acceptance'],
      failedCriteria: [],
      notes: 'Accepted by reviewer',
    }),
  });

  const state = await createGraphNodes(createGraphTools()).memoryNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: null,
    currentNode: 'acceptance',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    reviewVerdict: 'pass',
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'completed',
    error: null,
  });

  const savedRun = workflowRepo.getRun(run.id);
  const savedGraphState = parseGraphState(savedRun?.graph_state ?? null);
  const taskMemories = memoryRepo.list({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    includeArchived: true,
  });
  const taskSummary = taskMemories.find((memory) => memory.memory_type === 'task_summary');

  assert.ok(taskSummary);
  assert.equal(taskSummary?.source_type, 'workflow');
  assert.equal(taskSummary?.source_id, run.id);
  assert.match(taskSummary?.content ?? '', /summary sourced from acceptance/);
  assert.doesNotMatch(taskSummary?.content ?? '', /without acceptance artifact/);
  assert.equal(savedRun?.status, 'completed');
  assert.equal(savedGraphState?.status, 'completed');
  assert.equal(savedGraphState?.currentNode, 'memory');
  assert.equal(state.currentNode, 'memory');
});

test('memory node without acceptance artifact skips task summary but still completes graph state', async () => {
  const projectPath = join(tmpdir(), `graph-memory-node-no-acceptance-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Memory Node No Acceptance', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Memory No Acceptance Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Memory no acceptance task',
    description: 'Ensure memory node does not write fallback task summary.',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'acceptance',
    graph_version: 'phase-b-v1',
  });

  const state = await createGraphNodes(createGraphTools()).memoryNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
    plan: null,
    currentNode: 'acceptance',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    reviewVerdict: 'pass',
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'completed',
    error: null,
  });

  const taskMemories = memoryRepo.list({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    includeArchived: true,
  });
  const taskSummary = taskMemories.find((memory) => memory.memory_type === 'task_summary');
  const savedRun = workflowRepo.getRun(run.id);
  const savedGraphState = parseGraphState(savedRun?.graph_state ?? null);

  assert.equal(taskSummary, undefined);
  assert.equal(savedRun?.status, 'completed');
  assert.equal(savedGraphState?.status, 'completed');
  assert.equal(savedGraphState?.currentNode, 'memory');
  assert.equal(state.currentNode, 'memory');
});

test('recoverGraphWorkflow marks graph running steps interrupted, blocks runs, and keeps retry context', () => {
  const projectPath = join(tmpdir(), `graph-recover-runtime-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Recovery Runtime', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Recovery Room' });
  const agent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'executor-graph-recover',
    agent_name: 'Executor Graph Recover',
  });
  roomAgentRepo.setWorkflowRole(agent.id, 'executor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Recover graph workflow',
    description: 'Ensure graph recovery interrupts running nodes.',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    graph_state: JSON.stringify({
      workflowRunId: runIdPlaceholder(),
      projectId: project.id,
      roomId: room.id,
      taskId: task.id,
      userGoal: task.title,
      projectPath: project.path,
      plan: null,
      currentNode: 'execute',
      currentStepId: null,
      activeAgentRunId: null,
      childTaskIds: [],
      reviewFindings: [],
      reviewVerdict: null,
      verificationResults: [],
      repairAttempts: 0,
      approval: 'not_required',
      status: 'running',
      error: null,
    }),
  });
  const patchedRunState = parseGraphState(run.graph_state);
  if (!patchedRunState) throw new Error('graph state missing');
  patchedRunState.workflowRunId = run.id;
  workflowRepo.updateGraphState(run.id, JSON.stringify(patchedRunState));

  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: agent.id,
    assigned_room_agent_id: agent.id,
    scope_read: ['packages/backend/src/workflows/graph/runtime.ts'],
    scope_write: ['packages/backend/src/workflows/graph/nodes.ts'],
    prompt: 'implement graph recovery',
    sort_order: 1,
  });
  const agentRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    acp_session_id: 'retry-session-graph-1',
    task_id: task.id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'implement graph recovery',
  });

  const legacyRun = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    graph_state: run.graph_state,
  });
  const legacyStep = workflowRepo.createStep({
    workflow_run_id: legacyRun.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: null,
    status: 'running',
    room_agent_id: agent.id,
    assigned_room_agent_id: agent.id,
    prompt: 'legacy running step without node_name',
    sort_order: 1,
  });

  const badStateRun = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
    graph_version: 'phase-b-v1',
    graph_state: '{"invalid": ',
  });
  const badStateStep = workflowRepo.createStep({
    workflow_run_id: badStateRun.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'running',
    room_agent_id: agent.id,
    assigned_room_agent_id: agent.id,
    prompt: 'bad state running step',
    sort_order: 1,
  });
  const badStateAgentRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    acp_session_id: 'retry-session-graph-bad-state',
    task_id: task.id,
    workflow_run_id: badStateRun.id,
    workflow_step_id: badStateStep.id,
    workflow_stage: 'implementation',
    prompt: 'implement graph recovery on bad state',
  });

  const sameWorkflowOtherStep = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'code_review',
    node_name: 'review',
    status: 'running',
    room_agent_id: agent.id,
    assigned_room_agent_id: agent.id,
    prompt: 'parallel running review step',
    sort_order: 2,
  });
  const otherStepAgentRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    acp_session_id: 'retry-session-graph-2',
    task_id: task.id,
    workflow_run_id: run.id,
    workflow_step_id: sameWorkflowOtherStep.id,
    workflow_stage: 'code_review',
    prompt: 'review graph recovery',
  });

  const count = recoverGraphWorkflow('Backend restarted before graph node completed');
  const updatedStep = workflowRepo.getStep(step.id);
  const updatedRun = workflowRepo.getRun(run.id);
  const updatedAgentRun = agentRunRepo.get(agentRun.id);
  const updatedOtherStepAgentRun = agentRunRepo.get(otherStepAgentRun.id);
  const updatedLegacyStep = workflowRepo.getStep(legacyStep.id);
  const updatedLegacyRun = workflowRepo.getRun(legacyRun.id);
  const updatedBadStateStep = workflowRepo.getStep(badStateStep.id);
  const updatedBadStateRun = workflowRepo.getRun(badStateRun.id);
  const updatedBadStateAgentRun = agentRunRepo.get(badStateAgentRun.id);
  const nextGraphState = parseGraphState(updatedRun?.graph_state ?? null);

  assert.equal(count, 3);
  assert.equal(updatedStep?.status, 'interrupted');
  assert.equal(updatedStep?.error, 'Backend restarted before graph node completed');
  assert.equal(updatedAgentRun?.status, 'interrupted');
  assert.equal(updatedAgentRun?.workflow_run_id, run.id);
  assert.equal(updatedAgentRun?.workflow_step_id, step.id);
  assert.equal(updatedAgentRun?.acp_session_id, 'retry-session-graph-1');
  assert.equal(updatedOtherStepAgentRun?.status, 'interrupted');
  assert.equal(updatedOtherStepAgentRun?.workflow_step_id, sameWorkflowOtherStep.id);
  assert.equal(updatedOtherStepAgentRun?.acp_session_id, 'retry-session-graph-2');

  assert.equal(updatedLegacyStep?.status, 'running');
  assert.equal(updatedLegacyRun?.status, 'running');

  assert.equal(updatedBadStateStep?.status, 'interrupted');
  assert.equal(updatedBadStateStep?.error, 'Backend restarted before graph node completed');
  assert.equal(updatedBadStateAgentRun?.status, 'interrupted');
  assert.equal(updatedBadStateRun?.status, 'blocked');

  assert.equal(updatedRun?.status, 'blocked');
  assert.equal(nextGraphState?.status, 'blocked');
  assert.equal(nextGraphState?.error, 'Backend restarted before graph node completed');
});

function runIdPlaceholder(): string {
  return 'pending-run-id';
}
