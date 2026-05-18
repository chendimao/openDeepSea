import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessageMetadata, RoomAgent, TaskEventType, WorkflowStage, WorkflowStep } from '../../types.js';
import type { RespondAsAgentInput } from '../../dispatcher.js';
import type { AgentWorkflowState } from './state.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-e2e-')), 'test.db');

const { agentRunRepo } = await import('../../repos/agent-runs.js');
const { memoryRepo } = await import('../../repos/memory.js');
const { messageRepo } = await import('../../repos/messages.js');
const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { workflowContextRepo } = await import('../../repos/workflow-context.js');
const { parseGraphState, serializeGraphState } = await import('./state.js');
const { setWorkflowOrchestratorGraphDeps, workflowOrchestrator } = await import('../orchestrator.js');
const {
  approveGraphWorkflowPlan,
  createGraphWorkflowRun,
  enqueueGraphWorkflow,
  startGraphWorkflow,
} = await import('./runtime.js');

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

test('graph runtime completes ACP-only development loop', async () => {
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
    description: 'Verify graph runtime can complete with ACP-only agents.',
  });
  const agentCalls: AgentCall[] = [];

  setWorkflowOrchestratorGraphDeps({
    planner: async () => ({
      goal: task.title,
      summary: 'Exercise the no-approval graph runtime loop.',
      assumptions: ['ACP-only agents are sufficient for the graph runtime.'],
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
  const events = readWorkflowEvents(room.id, run.id);
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
  assertWorkflowEvent(events, 'workflow_started', task.id);
  assertWorkflowEvent(events, 'workflow_stage_changed', task.id, planningStep.id);
  assertWorkflowEvent(events, 'workflow_plan_ready', task.id, planningStep.id);
  assertWorkflowEvent(events, 'workflow_assignment_created', task.id, dispatchStep.id);
  assertWorkflowEvent(events, 'workflow_stage_changed', childTasks[0]?.id ?? '', executeStep.id);
  assertWorkflowEvent(events, 'workflow_stage_changed', task.id, reviewStep.id);
  assertWorkflowEvent(events, 'workflow_stage_changed', task.id, verifyStep.id);
  assertWorkflowEvent(events, 'workflow_stage_changed', task.id, acceptanceStep.id);
  assertWorkflowEvent(events, 'workflow_completed', task.id, acceptanceStep.id);
  assertWorkflowEvent(events, 'workflow_memory_written', task.id);
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

test('graph runtime executes every planned child before review', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-e2e-multi-child-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph E2E Multi Child', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph E2E Multi Child Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  const acceptor = addAcpWorkflowAgent(room.id, 'acceptor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Complete multi-child graph runtime loop',
    description: 'Verify graph runtime executes every planned child task before review.',
  });
  const agentCalls: AgentCall[] = [];
  const reviewSnapshots: Array<Array<{ id: string; status: string }>> = [];

  setWorkflowOrchestratorGraphDeps({
    planner: async () => ({
      goal: task.title,
      summary: 'Exercise all child implementation tasks before review.',
      assumptions: [],
      tasks: [
        {
          title: 'Implement first graph child',
          description: 'Produce first implementation output.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['First child is implemented'],
          scopeRead: ['packages/backend/src/workflows/graph/runtime.ts'],
          scopeWrite: ['packages/backend/src/workflows/graph/e2e.test.ts'],
          dependsOn: [],
        },
        {
          title: 'Implement second graph child',
          description: 'Produce second implementation output.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Second child is implemented'],
          scopeRead: ['packages/backend/src/workflows/graph/router.ts'],
          scopeWrite: ['packages/backend/src/workflows/graph/e2e.test.ts'],
          dependsOn: [],
        },
      ],
      reviewFocus: ['review only after all implementation children are ready'],
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
      if (input.workflowStage === 'code_review') {
        const snapshot = taskRepo.listChildren(task.id).map((child) => ({ id: child.id, status: child.status }));
        reviewSnapshots.push(snapshot);
        assert.equal(
          snapshot.some((child) => child.status === 'todo' || child.status === 'in_progress'),
          false,
          `review started before all children were implemented: ${JSON.stringify(snapshot)}`,
        );
      }
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
  const childTasks = taskRepo.listChildren(task.id);
  const implementationCalls = agentCalls.filter((call) => call.stage === 'implementation');
  const reviewCallIndex = agentCalls.findIndex((call) => call.stage === 'code_review');
  const secondImplementationCallIndex = agentCalls.findIndex((call, index) =>
    index > 0 && call.stage === 'implementation',
  );

  assert.equal(run.status, 'completed');
  assert.equal(taskRepo.get(task.id)?.status, 'done');
  assert.equal(childTasks.length, 2);
  assert.deepEqual(childTasks.map((child) => child.status), ['done', 'done']);
  assert.equal(implementationCalls.length, 2);
  assert.deepEqual(
    implementationCalls.map((call) => call.taskId),
    childTasks.map((child) => child.id),
  );
  assert.ok(reviewCallIndex > secondImplementationCallIndex);
  assert.equal(reviewSnapshots.length, 1);
  assert.equal(agentCalls.at(-1)?.agentId, acceptor.id);
  assert.equal(implementationCalls.every((call) => call.agentId === executor.id), true);
  assert.equal(agentCalls.some((call) => call.stage === 'code_review' && call.agentId === reviewer.id), true);
});

test('graph review prompt uses workflow context entries instead of raw implementation output', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-context-budget-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Context Budget', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Context Budget Room' });
  const executor = addAcpWorkflowAgent(room.id, 'executor');
  const reviewer = addAcpWorkflowAgent(room.id, 'reviewer');
  addAcpWorkflowAgent(room.id, 'acceptor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Keep raw implementation out of review prompt',
    description: 'Verify workflow context entries are the downstream context source.',
  });
  const rawNeedle = 'RAW_IMPLEMENTATION_OUTPUT_SHOULD_NOT_REACH_REVIEW_PROMPT';
  const longImplementationOutput = `${rawNeedle}\n${'x'.repeat(50_000)}`;
  const reviewPrompts: string[] = [];

  setWorkflowOrchestratorGraphDeps({
    planner: async () => ({
      goal: task.title,
      summary: 'Create one child task with long raw output.',
      assumptions: [],
      tasks: [{
        title: 'Produce long output',
        description: 'Return a deliberately long implementation output.',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['review receives handoff only'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: false,
    }),
    runAcpAgent: async (input) => {
      if (!input.workflowStage || !input.workflowStepId || !input.taskId) {
        throw new Error('workflow fake requires stage, step, and task');
      }
      if (input.workflowStage === 'code_review') {
        reviewPrompts.push(input.prompt);
      }
      const output = input.workflowStage === 'implementation'
        ? longImplementationOutput
        : outputForStage(input.workflowStage);
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
  const executeStep = requireStep(detail.steps, 'execute');
  const contextEntries = workflowContextRepo.listByWorkflow(run.id);
  const handoff = contextEntries.find((entry) => entry.entry_type === 'handoff' && entry.workflow_step_id === executeStep.id);

  assert.ok(handoff);
  assert.equal(handoff.raw_char_count, longImplementationOutput.length);
  assert.match(handoff.content, /完整原始输出请查看引用/);
  assert.equal(reviewPrompts.length, 1);
  assert.match(reviewPrompts[0] ?? '', /已有工作流上下文/);
  assert.match(reviewPrompts[0] ?? '', /执行交接：Produce long output/);
  assert.doesNotMatch(reviewPrompts[0] ?? '', new RegExp(rawNeedle));
  assert.ok((reviewPrompts[0] ?? '').length < 12_000);
  assert.equal(taskRepo.get(task.id)?.status, 'done');
  assert.equal(executor.workflow_role, 'executor');
  assert.equal(reviewer.workflow_role, 'reviewer');
});

test('graph workflow blocks when critical context entry creation fails', async () => {
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-context-failure-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Context Failure', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Context Failure Room' });
  addAcpWorkflowAgent(room.id, 'executor');
  addAcpWorkflowAgent(room.id, 'reviewer');
  addAcpWorkflowAgent(room.id, 'acceptor');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Block without workflow context',
  });
  const reviewPrompts: string[] = [];
  const originalCreate = workflowContextRepo.create;
  workflowContextRepo.create = (() => {
    throw new Error('context db unavailable');
  }) as typeof workflowContextRepo.create;

  try {
    setWorkflowOrchestratorGraphDeps({
      planner: async () => ({
        goal: task.title,
        summary: 'Create one child task.',
        assumptions: [],
        tasks: [{
          title: 'Produce output',
          description: 'Return implementation output.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['context is required before review'],
          scopeRead: [],
          scopeWrite: [],
          dependsOn: [],
        }],
        reviewFocus: [],
        verification: [],
        verificationCommands: [],
        risks: [],
        needsApproval: false,
      }),
      runAcpAgent: async (input) => {
        if (input.workflowStage === 'code_review') reviewPrompts.push(input.prompt);
        const output = outputForStage(input.workflowStage ?? 'implementation');
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

    await assert.rejects(() => workflowOrchestrator.start(task.id), /context db unavailable/);
  } finally {
    workflowContextRepo.create = originalCreate;
  }

  const run = workflowRepo.listByTask(task.id)[0];
  assert.ok(run);
  assert.equal(run.status, 'blocked');
  assert.match(run.error ?? '', /context db unavailable/);
  assert.equal(reviewPrompts.length, 0);
});

test('graph approval records accepted event before continuing', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-approval-event-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Approval Event', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Approval Event Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Approve event workflow',
  });
  const run = createAwaitingApprovalRun({
    roomId: room.id,
    projectId: project.id,
    projectPath,
    taskId: task.id,
    taskTitle: task.title,
  });

  const approved = approveGraphWorkflowPlan(run.id, 'tester');

  assert.equal(approved.status, 'running');
  const approvalEvent = readWorkflowEvents(room.id, run.id)
    .find((event) =>
      event.event_type === 'workflow_stage_changed' &&
      event.task_id === task.id &&
      event.approval_status === 'accepted',
    );
  assert.ok(approvalEvent);
  assert.equal(approvalEvent.workflow_step_id, undefined);
  assert.equal(
    readWorkflowEvents(room.id, run.id).filter((event) =>
      event.event_type === 'workflow_stage_changed' &&
      event.task_id === task.id &&
      event.approval_status === 'accepted',
    ).length,
    1,
  );
});

test('background graph continuation failure records workflow_failed event', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-background-failure-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Background Failure', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Background Failure Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Background failure workflow',
  });
  const run = createGraphWorkflowRun(task.id);

  enqueueGraphWorkflow(run.id, {
    planner: async () => {
      throw new Error('background planner unavailable');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(workflowRepo.getRun(run.id)?.status, 'blocked');
  const failureEvent = readWorkflowEvents(room.id, run.id)
    .find((event) => event.event_type === 'workflow_failed' && event.task_id === task.id);
  assert.ok(failureEvent);
  assert.equal(failureEvent.graph_node, 'planning');
  assert.equal(failureEvent.workflow_stage, 'planning');
  assert.equal(failureEvent.error, 'background planner unavailable');
  assert.equal(
    failureEvent.workflow_step_id,
    workflowRepo.listSteps(run.id).find((step) => step.node_name === 'planning')?.id,
  );
});

test('graph cancellation records workflow_cancelled event', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-cancel-event-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Cancel Event', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Cancel Event Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Cancel event workflow',
  });
  const run = createAwaitingApprovalRun({
    roomId: room.id,
    projectId: project.id,
    projectPath,
    taskId: task.id,
    taskTitle: task.title,
    status: 'running',
    currentNode: 'execute',
  });

  const cancelled = await workflowOrchestrator.cancel(run.id);

  assert.equal(cancelled.status, 'cancelled');
  assertWorkflowEvent(readWorkflowEvents(room.id, run.id), 'workflow_cancelled', task.id);
});

test('direct graph start records workflow_started event', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-start-event-'));
  projectPathsToCleanup.push(projectPath);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Start Event', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Start Event Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Start event workflow',
  });

  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: task.title,
      summary: 'Plan pauses for approval.',
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: true,
    }),
  });

  assert.equal(run.status, 'awaiting_approval');
  assertWorkflowEvent(readWorkflowEvents(room.id, run.id), 'workflow_started', task.id);
});

function readWorkflowEvents(roomId: string, workflowRunId: string): MessageMetadata[] {
  return messageRepo.listByRoom(roomId, 200)
    .map((message) => parseJsonMetadata(message.metadata))
    .filter((metadata): metadata is MessageMetadata =>
      metadata !== null && Boolean(metadata.event_type) && metadata.workflow_run_id === workflowRunId,
    );
}

function createAwaitingApprovalRun(input: {
  roomId: string;
  projectId: string;
  projectPath: string;
  taskId: string;
  taskTitle: string;
  status?: 'running' | 'awaiting_approval';
  currentNode?: 'approval' | 'execute';
}) {
  const state: AgentWorkflowState = {
    workflowRunId: 'pending',
    projectId: input.projectId,
    roomId: input.roomId,
    taskId: input.taskId,
    userGoal: input.taskTitle,
    projectPath: input.projectPath,
    plan: {
      goal: input.taskTitle,
      summary: 'Approval event plan.',
      assumptions: [],
      tasks: [],
      reviewFocus: [],
      verification: [],
      verificationCommands: [],
      risks: [],
      needsApproval: true,
    },
    currentNode: input.currentNode ?? 'approval',
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    reviewVerdict: null,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'pending',
    status: input.status ?? 'awaiting_approval',
    error: null,
  };
  const run = workflowRepo.createRun({
    room_id: input.roomId,
    project_id: input.projectId,
    task_id: input.taskId,
    status: input.status ?? 'awaiting_approval',
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(state),
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState({ ...state, workflowRunId: run.id }));
  return workflowRepo.getRun(run.id)!;
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

function assertWorkflowEvent(
  events: MessageMetadata[],
  eventType: TaskEventType,
  taskId: string,
  workflowStepId?: string | null,
): void {
  assert.ok(taskId, `missing task id for ${eventType}`);
  const event = events.find((item) =>
    item.event_type === eventType &&
    item.task_id === taskId &&
    (workflowStepId === undefined || item.workflow_step_id === workflowStepId),
  );
  assert.ok(
    event,
    `missing ${eventType} event for task ${taskId}${workflowStepId ? ` and step ${workflowStepId}` : ''}; got ${
      events.map((item) => `${item.event_type}:${item.task_id}:${item.workflow_step_id ?? 'none'}`).join(', ')
    }`,
  );
  assert.equal(event.event_type, eventType);
  assert.equal(event.task_id, taskId);
  assert.equal(typeof event.workflow_run_id, 'string');
  if (workflowStepId !== undefined && workflowStepId !== null) {
    assert.equal(event.workflow_step_id, workflowStepId);
  }
}

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
  if (role !== 'executor') return withAcp;
  const withRuntimeBoundary = roomAgentRepo.setCapabilitiesAndRuntime(withAcp.id, {
    capabilities: withAcp.capabilities,
    default_runtime: withAcp.default_runtime,
    tool_policy: { allowed: ['read_files', 'write_files'] },
    workspace_policy: { read: ['.'], write: ['packages/backend'] },
  });
  if (!withRuntimeBoundary) throw new Error(`failed to configure runtime boundary for ${role}`);
  return withRuntimeBoundary;
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
