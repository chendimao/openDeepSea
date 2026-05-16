import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, RoomAgent, WorkflowStage, WorkflowStep } from '../../types.js';
import type { RespondAsAgentInput } from '../../dispatcher.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-e2e-')), 'test.db');

const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { memoryRepo } = await import('../../repos/memory.js');
const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { parseGraphState } = await import('./state.js');
const { setWorkflowOrchestratorGraphDeps, workflowOrchestrator } = await import('../orchestrator.js');

const originalLangGraphWorkflowEnabled = process.env.LANGGRAPH_WORKFLOW_ENABLED;
const projectPathsToCleanup: string[] = [];
const acceptanceNotes = 'Graph runtime completed all steps';
const acceptanceCriterion = 'Implementation output is reviewed and accepted';

test.afterEach(() => {
  if (originalLangGraphWorkflowEnabled === undefined) {
    delete process.env.LANGGRAPH_WORKFLOW_ENABLED;
  } else {
    process.env.LANGGRAPH_WORKFLOW_ENABLED = originalLangGraphWorkflowEnabled;
  }
  setWorkflowOrchestratorGraphDeps({});
  for (const projectPath of projectPathsToCleanup.splice(0)) {
    rmSync(projectPath, { recursive: true, force: true });
  }
});

test('graph runtime completes ACP-only development loop without OpenClaw gateway', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-e2e-project-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph E2E', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph E2E Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Complete graph runtime loop',
    description: 'Verify graph runtime can complete without OpenClaw Gateway.',
  });
  const agentCalls: AgentCall[] = [];

  setWorkflowOrchestratorGraphDeps({
    planner: async () => ({
      goal: task.title,
      summary: 'Exercise the no-approval graph runtime loop.',
      assumptions: ['OpenClaw Gateway is not required for ACP-only agents.'],
      tasks: [{
        title: 'Implement graph loop output',
        description: 'Produce implementation output for review and acceptance.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: [acceptanceCriterion],
        scopeRead: ['packages/backend/src/workflows/graph/runtime.ts'],
        scopeWrite: ['packages/backend/src/workflows/graph/e2e.test.ts'],
        dependsOn: [],
      }],
      reviewFocus: ['runtime completes via ACP-only agents'],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      if (!input.workflowStage) throw new Error('workflowStage is required for graph E2E fake agent');
      if (!input.workflowStepId) throw new Error('workflowStepId is required for graph E2E fake agent');
      if (!input.taskId) throw new Error('taskId is required for graph E2E fake agent');
      agentCalls.push({
        stage: input.workflowStage,
        role: input.agent.workflow_role,
        agentId: input.agent.id,
        workflowStepId: input.workflowStepId,
        taskId: input.taskId,
      });
      const output = outputForStage(input.workflowStage);
      const agentRun = agentRunRepo.create({
        room_id: input.roomId,
        room_agent_id: input.agent.id,
        agent_id: input.agent.agent_id,
        backend: 'codex',
        status: 'completed',
        task_id: input.taskId,
        workflow_run_id: input.workflowRunId,
        workflow_step_id: input.workflowStepId,
        workflow_stage: input.workflowStage,
        prompt: input.prompt,
      });
      return {
        run: { ...agentRun, stdout: output },
        message: fakeMessage(input, output),
        status: 'completed',
      };
    },
  });

  const run = await workflowOrchestrator.start(task.id);
  const detail = workflowRepo.detail(run.id);
  assert.ok(detail);
  const graphState = parseGraphState(run.graph_state);
  const childTasks = taskRepo.listChildren(task.id);
  const taskMemories = memoryRepo.list({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
  });
  const taskSummary = taskMemories.find((memory) => memory.memory_type === 'task_summary' && memory.source_id === run.id);
  const steps = detail.steps;
  const artifacts = detail.artifacts;
  const nodeNames = steps.map((step) => step.node_name);
  const planningStep = requireStep(steps, 'planning');
  const dispatchStep = requireStep(steps, 'dispatch');
  const executeStep = requireStep(steps, 'execute');
  const reviewStep = requireStep(steps, 'review');
  const verifyStep = requireStep(steps, 'verify');
  const acceptanceStep = requireStep(steps, 'acceptance');
  const planArtifact = requireArtifact(artifacts, 'plan');
  const assignmentArtifact = requireArtifact(artifacts, 'assignment');
  const reviewArtifact = requireArtifact(artifacts, 'review');
  const verificationArtifact = artifacts.find((artifact) => artifact.workflow_step_id === verifyStep.id);
  const acceptanceArtifact = requireArtifact(artifacts, 'acceptance');
  const verificationMetadata = verificationArtifact?.metadata ? JSON.parse(verificationArtifact.metadata) as {
    results?: Array<{ command: string; status: string }>;
  } : null;

  assert.equal(run.status, 'completed');
  assert.equal(run.graph_version, 'phase-b-v1');
  assert.equal(taskRepo.get(task.id)?.status, 'done');
  assertOrderedSubsequence(nodeNames, ['context', 'planning', 'dispatch', 'execute', 'review', 'verify', 'acceptance']);
  assert.equal(verifyStep.status, 'completed');
  assert.match(verifyStep.result, /\(none\): skipped/);
  assert.ok(verificationArtifact);
  assert.equal(verificationArtifact.artifact_type, 'implementation_summary');
  assert.match(verificationArtifact.content, /\(none\): skipped/);
  assert.equal(verificationMetadata?.results?.[0]?.status, 'skipped');
  assert.equal(verificationMetadata?.results?.[0]?.command, '(none)');
  assert.equal(planArtifact.workflow_step_id, planningStep.id);
  assert.equal(assignmentArtifact.workflow_step_id, dispatchStep.id);
  assert.equal(reviewArtifact.workflow_step_id, reviewStep.id);
  assert.equal(acceptanceArtifact.workflow_step_id, acceptanceStep.id);
  assert.equal(graphState?.status, 'completed');
  assert.equal(graphState?.currentNode, 'memory');
  assert.equal(graphState?.verificationResults[0]?.status, 'skipped');
  assert.equal(graphState?.verificationResults[0]?.command, '(none)');
  assert.equal(childTasks.length, 1);
  assert.equal(childTasks[0]?.assigned_agent_id, executor.id);
  assert.equal(childTasks[0]?.status, 'done');
  assert.deepEqual(agentCalls, [
    {
      stage: 'implementation',
      role: 'executor',
      agentId: executor.id,
      workflowStepId: executeStep.id,
      taskId: childTasks[0]?.id,
    },
    {
      stage: 'code_review',
      role: 'reviewer',
      agentId: reviewer.id,
      workflowStepId: reviewStep.id,
      taskId: task.id,
    },
    {
      stage: 'acceptance',
      role: 'acceptor',
      agentId: acceptor.id,
      workflowStepId: acceptanceStep.id,
      taskId: task.id,
    },
  ]);
  assert.equal(executeStep.stage, 'implementation');
  assert.equal(executeStep.room_agent_id, executor.id);
  assert.equal(executeStep.assigned_room_agent_id, executor.id);
  assert.equal(reviewStep.stage, 'code_review');
  assert.equal(reviewStep.room_agent_id, reviewer.id);
  assert.equal(reviewStep.assigned_room_agent_id, reviewer.id);
  assert.equal(acceptanceStep.stage, 'acceptance');
  assert.equal(acceptanceStep.room_agent_id, acceptor.id);
  assert.equal(acceptanceStep.assigned_room_agent_id, acceptor.id);
  assert.equal(taskSummary?.title, `任务完成：${task.title}`);
  assert.equal(taskSummary?.source_id, run.id);
  assert.equal(taskSummary?.task_id, task.id);
  assert.match(taskSummary?.content ?? '', new RegExp(acceptanceNotes));
  assert.match(taskSummary?.content ?? '', new RegExp(acceptanceCriterion));
});

interface AgentCall {
  stage: WorkflowStage;
  role: RoomAgent['workflow_role'];
  agentId: string;
  workflowStepId: string;
  taskId: string;
}

function addAcpWorkflowAgent(roomId: string, role: 'executor' | 'reviewer' | 'acceptor'): RoomAgent {
  const agent = roomAgentRepo.add({
    room_id: roomId,
    agent_id: `acp-${role}-${Date.now()}-${Math.random()}`,
    agent_name: `ACP ${role}`,
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

function outputForStage(stage: WorkflowStage): string {
  if (stage === 'implementation') return 'implementation output from ACP-only executor';
  if (stage === 'code_review') {
    return JSON.stringify({
      verdict: 'pass',
      findings: [],
      requiredFixes: [],
      riskLevel: 'low',
    });
  }
  if (stage === 'acceptance') {
    return JSON.stringify({
      verdict: 'pass',
      acceptedCriteria: [acceptanceCriterion],
      failedCriteria: [],
      notes: acceptanceNotes,
    });
  }
  throw new Error(`unexpected ACP stage: ${stage}`);
}

function requireStep(steps: WorkflowStep[], nodeName: string): WorkflowStep {
  const step = steps.find((item) => item.node_name === nodeName);
  assert.ok(step, `missing ${nodeName} step`);
  return step;
}

function requireArtifact(
  artifacts: Array<{ artifact_type: string; workflow_step_id: string | null }>,
  artifactType: string,
) {
  const artifact = artifacts.find((item) => item.artifact_type === artifactType);
  assert.ok(artifact, `missing ${artifactType} artifact`);
  return artifact;
}

function assertOrderedSubsequence(actual: Array<string | null>, expected: string[]): void {
  let cursor = 0;
  for (const item of actual) {
    if (item === expected[cursor]) cursor += 1;
  }
  assert.equal(
    cursor,
    expected.length,
    `expected node order ${expected.join(' -> ')} within ${actual.join(' -> ')}`,
  );
}

function fakeMessage(input: RespondAsAgentInput, content: string): Message {
  return {
    id: `message-${Date.now()}-${Math.random()}`,
    room_id: input.roomId,
    sender_type: 'agent',
    sender_id: input.agent.agent_id,
    sender_name: input.agent.agent_name,
    content,
    message_type: 'text',
    metadata: null,
    created_at: Date.now(),
  };
}
