import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageMetadata } from '../../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-review-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { messageRepo } = await import('../../repos/messages.js');
const { createGraphNodes } = await import('./nodes.js');
const { createGraphTools } = await import('./tools.js');
const { routeAfterReview, routeAfterRepairDecision } = await import('./router.js');

test('review pass routes to acceptance and completes workflow on acceptance pass', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-review-pass-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Review Pass', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Review Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  addAcpWorkflowAgent(room.id, 'reviewer');
  addAcpWorkflowAgent(room.id, 'acceptor');

  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent review pass task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child review pass task',
    description: 'Implementation child task',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  taskRepo.updateStatus(childTask.id, 'review');

  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: parentTask.id,
    status: 'running',
    current_stage: 'code_review',
    graph_version: 'phase-b-v1',
  });

  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        task_id: input.taskId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        workflow_step_id: input.workflowStepId ?? null,
        workflow_stage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      const completedRun = agentRunRepo.updateStatus(runRow.id, 'completed') ?? runRow;
      const isReview = input.workflowStage === 'code_review';
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: isReview
          ? '{"verdict":"pass","findings":[],"requiredFixes":[],"riskLevel":"low"}'
          : '{"verdict":"pass","acceptedCriteria":["child done"],"failedCriteria":[],"notes":"ok"}',
        message_type: 'agent_stream',
      });
      return {
        run: completedRun,
        message,
        status: 'completed' as const,
      };
    },
  });
  const nodes = createGraphNodes(tools);

  const reviewedState = await nodes.reviewNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Review and accept',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['done'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: ['bug risk'],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'execute',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [childTask.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.equal(routeAfterReview(reviewedState), 'verify');

  const acceptedState = await nodes.acceptanceNode(reviewedState);
  const artifacts = workflowRepo.listArtifacts(run.id);
  const reviewArtifact = artifacts.find((item) => item.artifact_type === 'review');
  const acceptanceArtifact = artifacts.find((item) => item.artifact_type === 'acceptance');

  assert.ok(reviewArtifact);
  assert.ok(acceptanceArtifact);
  assertWorkflowEvent(room.id, run.id, 'workflow_stage_changed', parentTask.id);
  assertWorkflowEvent(room.id, run.id, 'workflow_completed', parentTask.id);
  assert.equal(taskRepo.get(childTask.id)?.status, 'done');
  assert.equal(taskRepo.get(parentTask.id)?.status, 'done');
  assert.equal(workflowRepo.getRun(run.id)?.status, 'completed');
  assert.equal(acceptedState.status, 'completed');
});

test('review and acceptance ACP prompts do not include OpenDeepSea skill context by default', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-review-no-skills-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Review No Skills', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Review No Skills Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  addAcpWorkflowAgent(room.id, 'reviewer');
  addAcpWorkflowAgent(room.id, 'acceptor');

  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent no skill prompt task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child no skill prompt task',
    description: 'Implementation child task',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  taskRepo.updateStatus(childTask.id, 'review');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: parentTask.id,
    status: 'running',
    current_stage: 'code_review',
    graph_version: 'phase-b-v1',
  });

  const acpPrompts: string[] = [];
  const tools = createGraphTools({
    buildSkillContext: async () => 'OpenDeepSea active skills for this runtime:\nSkill: should-not-reach-acp',
    runAcpAgent: async (input) => {
      acpPrompts.push(input.prompt);
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        task_id: input.taskId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        workflow_step_id: input.workflowStepId ?? null,
        workflow_stage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      const completedRun = agentRunRepo.updateStatus(runRow.id, 'completed') ?? runRow;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: input.workflowStage === 'code_review'
          ? '{"verdict":"pass","findings":[],"requiredFixes":[],"riskLevel":"low"}'
          : '{"verdict":"pass","acceptedCriteria":["child done"],"failedCriteria":[],"notes":"ok"}',
        message_type: 'agent_stream',
      });
      return {
        run: completedRun,
        message,
        status: 'completed' as const,
      };
    },
  });
  const nodes = createGraphNodes(tools);
  const initialState = {
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Review and accept',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor' as const,
        priority: 'normal' as const,
        acceptance: ['done'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: ['bug risk'],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'execute' as const,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [childTask.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required' as const,
    status: 'running' as const,
    error: null,
  };

  const reviewedState = await nodes.reviewNode(initialState);
  await nodes.acceptanceNode(reviewedState);

  assert.equal(acpPrompts.length, 2);
  for (const prompt of acpPrompts) {
    assert.doesNotMatch(prompt, /OpenDeepSea active skills for this runtime/);
    assert.doesNotMatch(prompt, /should-not-reach-acp/);
  }
});

test('review changes_requested routes back to execute with bounded repair attempts', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-review-repair-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Review Repair', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Review Repair Room' });
  addAcpWorkflowAgent(room.id, 'reviewer');
  const executor = addAcpWorkflowAgent(room.id, 'executor');

  const parentTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Parent review repair task',
    description: 'Parent workflow task',
  });
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: parentTask.id,
    title: 'Child review repair task',
    description: 'Implementation child task',
    assigned_agent_id: executor.id,
    created_from: 'workflow_assignment',
  });
  taskRepo.updateStatus(childTask.id, 'review');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: parentTask.id,
    status: 'running',
    current_stage: 'code_review',
    graph_version: 'phase-b-v1',
  });

  let reviewRound = 0;
  let executeCalls = 0;
  const tools = createGraphTools({
    runAcpAgent: async (input) => {
      const runRow = agentRunRepo.create({
        room_id: room.id,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        task_id: input.taskId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        workflow_step_id: input.workflowStepId ?? null,
        workflow_stage: input.workflowStage ?? null,
        prompt: input.prompt,
      });
      const completedRun = agentRunRepo.updateStatus(runRow.id, 'completed') ?? runRow;
      const isExecute = input.workflowStage === 'implementation';
      if (isExecute) executeCalls += 1;
      else reviewRound += 1;
      const message = messageRepo.create({
        room_id: room.id,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: isExecute
          ? 'repair applied'
          : reviewRound === 1
          ? '{"verdict":"changes_requested","findings":["fix naming"],"requiredFixes":["rename var"],"riskLevel":"medium"}'
          : '{"verdict":"pass","findings":[],"requiredFixes":[],"riskLevel":"low"}',
        message_type: 'agent_stream',
      });
      return {
        run: completedRun,
        message,
        status: 'completed' as const,
      };
    },
  });
  const nodes = createGraphNodes(tools);

  const reviewedState = await nodes.reviewNode({
    workflowRunId: run.id,
    projectId: project.id,
    roomId: room.id,
    taskId: parentTask.id,
    userGoal: parentTask.title,
    projectPath: project.path,
    plan: {
      goal: parentTask.title,
      summary: 'Repair loop',
      assumptions: [],
      tasks: [{
        title: childTask.title,
        description: childTask.description ?? '',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['repair passes'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: ['quality'],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    },
    currentNode: 'execute',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [childTask.id],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required',
    status: 'running',
    error: null,
  });

  assert.equal(routeAfterReview(reviewedState), 'repair_decision');
  assert.equal(reviewedState.reviewFindings.length > 0, true);

  const repairedOnce = await nodes.repairDecisionNode(reviewedState);
  assert.equal(repairedOnce.repairAttempts, 1);
  assert.equal(routeAfterRepairDecision(repairedOnce), 'execute');
  assert.equal(repairedOnce.currentNode, 'execute');
  assert.equal(taskRepo.get(childTask.id)?.status, 'todo');

  const executedAgain = await nodes.executeNode(repairedOnce);
  assert.equal(executeCalls, 1);
  assert.equal(taskRepo.get(childTask.id)?.status, 'review');

  const reviewedAgain = await nodes.reviewNode(executedAgain);
  assert.equal(reviewRound, 2);
  assert.equal(reviewedAgain.reviewVerdict, 'pass');
  assert.equal(routeAfterReview(reviewedAgain), 'verify');

  const repairedTwice = await nodes.repairDecisionNode(repairedOnce);
  assert.equal(repairedTwice.repairAttempts, 2);
  assert.equal(routeAfterRepairDecision(repairedTwice), 'execute');

  const blockedState = await nodes.repairDecisionNode(repairedTwice);
  assert.equal(routeAfterRepairDecision(blockedState), '__end__');
  assert.equal(blockedState.status, 'blocked');
  assert.match(blockedState.error ?? '', /max repair attempts/);
});

function assertWorkflowEvent(
  roomId: string,
  workflowRunId: string,
  eventType: MessageMetadata['event_type'],
  taskId: string,
): void {
  const events = messageRepo.listByRoom(roomId, 100)
    .map((message) => parseJsonMetadata(message.metadata))
    .filter((metadata): metadata is MessageMetadata =>
      metadata !== null && Boolean(metadata.event_type) && metadata.workflow_run_id === workflowRunId,
    );
  assert.ok(
    events.some((event) => event.event_type === eventType && event.task_id === taskId),
    `missing ${eventType} for task ${taskId}; got ${events.map((event) => event.event_type).join(', ')}`,
  );
}

function parseJsonMetadata(value: string | null): MessageMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as MessageMetadata
      : null;
  } catch {
    return null;
  }
}

function addAcpWorkflowAgent(roomId: string, role: 'executor' | 'reviewer' | 'acceptor') {
  const agent = roomAgentRepo.add({
    room_id: roomId,
    agent_id: `${role}-${Date.now()}-${Math.random()}`,
    agent_name: `${role} Agent`,
  });
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, role);
  if (!withRole) throw new Error(`failed to assign ${role} role`);
  const withAcp = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'workspace-write',
    acp_writable_dirs: [],
  });
  if (!withAcp) throw new Error(`failed to enable ACP for ${role}`);
  return withAcp;
}
