import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, RoomAgent, WorkflowStage } from '../../types.js';
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

test.afterEach(() => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '';
  setWorkflowOrchestratorGraphDeps({});
});

test('graph runtime completes ACP-only development loop without OpenClaw gateway', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-e2e-project-'));
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
  const calledRoles: Array<RoomAgent['workflow_role']> = [];
  const calledStages: WorkflowStage[] = [];

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
        acceptance: ['Implementation output is reviewed and accepted'],
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
      calledRoles.push(input.agent.workflow_role);
      calledStages.push(input.workflowStage);
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
  const graphState = parseGraphState(run.graph_state);
  const taskMemories = memoryRepo.list({
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.graph_version, 'phase-b-v1');
  assert.equal(taskRepo.get(task.id)?.status, 'done');
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'plan'));
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'assignment'));
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'review'));
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'acceptance'));
  assert.equal(graphState?.status, 'completed');
  assert.equal(graphState?.currentNode, 'memory');
  assert.equal(calledRoles.includes(executor.workflow_role), true);
  assert.equal(calledRoles.includes(reviewer.workflow_role), true);
  assert.equal(calledRoles.includes(acceptor.workflow_role), true);
  assert.deepEqual(calledStages, ['implementation', 'code_review', 'acceptance']);
  assert.ok(taskMemories.some((memory) => memory.memory_type === 'task_summary' && memory.source_id === run.id));
});

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
      acceptedCriteria: ['Implementation output is reviewed and accepted'],
      failedCriteria: [],
      notes: 'Graph runtime completed all steps',
    });
  }
  throw new Error(`unexpected ACP stage: ${stage}`);
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
