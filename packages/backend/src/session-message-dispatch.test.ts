import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-dispatch-')), 'test.db');
const platformSkillsHome = mkdtempSync(join(tmpdir(), 'openclaw-room-session-platform-skills-home-'));
process.env.HOME = platformSkillsHome;
process.env.CODEX_HOME = join(platformSkillsHome, '.codex');

const { projectRepo } = await import('./repos/projects.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { fileRepo } = await import('./repos/files.js');
const { messageRepo } = await import('./repos/messages.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { settingsRepo } = await import('./repos/settings.js');
const { sessionMessageRepo, sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { taskRepo } = await import('./repos/tasks.js');
const { workflowArtifactVersionRepo, workflowRepo } = await import('./repos/workflows.js');
const {
  dispatchSessionUserMessage,
  recordSessionImageGenerationJobMessage,
  recordSessionImageGenerationToolResultEvidence,
} = await import('./session-message-dispatch.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { recordTaskEvent } = await import('./task-conversation.js');
const { setWorkflowOrchestratorGraphDeps, workflowOrchestrator } = await import('./workflows/orchestrator.js');
const { setVerificationCommandRunnerForTests } = await import('./workflows/graph/verification.js');
const { emptyAgentWorkflowState, parseGraphState, serializeGraphState } = await import('./workflows/graph/state.js');
const { SUPERPOWERS_V2_GRAPH_VERSION } = await import('./workflows/superpowers-stage-registry.js');

type WorkflowGraphDepsForTest = Parameters<typeof setWorkflowOrchestratorGraphDeps>[0];
const noRetryGraphDepsForTests: WorkflowGraphDepsForTest = {
  scheduleRetry: () => undefined,
};
let workflowIntakeEnqueueCalls: string[] = [];

function resetWorkflowGraphDepsForTests(): void {
  setWorkflowOrchestratorGraphDeps(noRetryGraphDepsForTests);
}

function setWorkflowGraphDepsForTests(deps: WorkflowGraphDepsForTest): void {
  setWorkflowOrchestratorGraphDeps({
    ...noRetryGraphDepsForTests,
    ...deps,
  });
}

function resetWorkflowIntakeEnqueueForTests(): void {
  workflowIntakeEnqueueCalls = [];
  workflowOrchestrator.enqueueExistingGraphRun = (runId) => {
    workflowIntakeEnqueueCalls.push(runId);
    const run = workflowRepo.getRun(runId);
    assert.ok(run);
    const task = taskRepo.get(run.task_id);
    assert.ok(task);
    recordTaskEvent({
      roomId: run.room_id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: run.id,
      eventType: 'workflow_started',
      content: `工作流已启动，进入 ${run.current_stage ?? 'planning'} 阶段。`,
      metadata: {
        graph_node: 'start',
        workflow_stage: run.current_stage ?? 'planning',
      },
    });
    return { run, enqueued: true };
  };
}

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
  resetWorkflowGraphDepsForTests();
  resetWorkflowIntakeEnqueueForTests();
  setVerificationCommandRunnerForTests(null);
  settingsRepo.updateSystem({ global_session_prompt: null });
});

resetWorkflowGraphDepsForTests();
resetWorkflowIntakeEnqueueForTests();

test('dispatchSessionUserMessage keeps ordinary chat on workflow intake when project planner backend differs', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Planner Backend Workflow Intake',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-planner-backend-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Planner Backend Workflow Intake',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];

  setSessionRuntimeAdapterForTest({
    backend: 'opencode',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'opencode-session', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({ sessionId: session.id, content: '分析当前项目' });

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
});

test('dispatchSessionUserMessage routes ordinary chat through workflow intake instead of planner run', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Ordinary Chat Workflow',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-ordinary-chat-workflow-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Ordinary Chat Workflow',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-ordinary-chat', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '这个项目的 workflow 是怎么工作的？',
    mode: 'ask',
  });

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
});

test('dispatchSessionUserMessage preserves explicit platform skill refs for workflow intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Platform Skill Refs',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-platform-skills-')),
  });
  createPlatformSkill('codex', 'frontend-design', 'Frontend design workflow.');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Platform Skill Refs',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-platform-skill', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '优化会话输入框',
    platformSkillRefs: [{ provider: 'codex', name: 'frontend-design' }],
  });

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    platform_skill_refs?: Array<{ provider: string; name: string }>;
  };
  assert.deepEqual(metadata.platform_skill_refs, [{ provider: 'codex', name: 'frontend-design' }]);
  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  const { task } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.match(task.description ?? '', /Platform skills:/);
  assert.match(task.description ?? '', /codex:frontend-design/);
});

test('dispatchSessionUserMessage routes medium-risk development tasks through Superpowers intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Risk Gate',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-risk-gate-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Risk Gate',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-risk-gate', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);

  const messages = sessionMessageRepo.listBySession(session.id);
  const gateMessage = messages.find((item) => item.sender_id === 'risk-gate');
  assert.equal(message.content, GIT_STATUS_BAR_TASK);
  assert.equal(gateMessage, undefined);

  const { run } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.equal(run.approved_by, null);

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    risk_assessment?: { riskLevel?: string; requiresApproval?: boolean };
    approval_card?: unknown;
    session_approval?: unknown;
  };
  assert.equal(metadata.risk_assessment?.riskLevel, 'medium');
  assert.equal(metadata.risk_assessment?.requiresApproval, true);
  assert.equal(metadata.approval_card, undefined);
  assert.equal(metadata.session_approval, undefined);
});

test('dispatchSessionUserMessage starts graph workflow for approved fullstack session task', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Risk Approval',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-risk-approval-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Risk Approval',
    provider: 'codex',
    workspace_path: project.path,
  });
  const workflowAgentCalls: Array<{ agentId: string; stage: string | null | undefined }> = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-risk-approved', stderr: '' }),
  });
  setVerificationCommandRunnerForTests(async (command) => ({
    command,
    status: 'passed',
    exitCode: 0,
    stdout: 'session workflow verification passed',
    stderr: '',
  }));
  setWorkflowGraphDepsForTests({
    planner: async () => {
      throw new Error('planner should not be called for approved session workflow handoff');
    },
    runAcpAgent: async (input) => {
      workflowAgentCalls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      const output = outputForWorkflowStage(input.workflowStage);
      const run = agentRunRepo.create({
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
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
        message_type: 'text',
      });
      return {
        run: { ...run, stdout: output },
        message,
        status: 'completed',
      };
    },
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });
  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '确认',
  });
  await waitFor(
    () => {
      const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
      const runs = workflowTasks.flatMap((task) => workflowRepo.listByTask(task.id));
      return runs.some((run) =>
        run.status === 'blocked' && /approved spec artifact/i.test(run.error ?? '')
      );
    },
    1000,
    () => {
      const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
      const runs = workflowTasks.flatMap((task) => workflowRepo.listByTask(task.id));
      return `calls=${JSON.stringify(workflowAgentCalls)} runs=${JSON.stringify(runs.map((run) => ({
        status: run.status,
        stage: run.current_stage,
        error: run.error,
      })))}`;
    },
  );
  const workflowTasksAfterGate = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  const [blockedRun] = workflowTasksAfterGate.flatMap((task) => workflowRepo.listByTask(task.id));
  assert.ok(blockedRun);
  const stateAtSpecGate = parseGraphState(blockedRun.graph_state);
  assert.ok(stateAtSpecGate?.draftSpecArtifactVersionId);
  assert.equal(stateAtSpecGate?.draftPlanArtifactVersionId, null);
  assert.equal(workflowArtifactVersionRepo.get(stateAtSpecGate.draftSpecArtifactVersionId)?.artifact_type, 'spec');

  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assert.equal(workflowAgentCalls.every((call) => call.stage === 'planning'), true);

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  assert.equal(workflowTasks[0]?.title, GIT_STATUS_BAR_TASK);
  assert.match(workflowTasks[0]?.description ?? '', /产品经理方案背景/);

  const workflowRuns = workflowRepo.listByTask(workflowTasks[0]!.id);
  assert.equal(workflowRuns.length, 1);
  assert.equal(typeof workflowRuns[0]?.graph_version, 'string');
  assert.equal(workflowRuns[0]?.approved_by, null);

  const agents = roomAgentRepo.listByRoom(workflowTasks[0]!.room_id).map((agent) => agent.agent_id);
  assert.deepEqual(agents, ['planner']);

  const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    session_approval?: {
      status?: string;
      decidedByMessageId?: string;
      executionPath?: string;
      workflowRunId?: string;
      workflowTaskId?: string;
    };
  };
  assert.equal(metadata.session_approval?.status, 'approved');
  assert.equal(metadata.session_approval?.executionPath, 'workflow_graph');
  assert.equal(metadata.session_approval?.workflowTaskId, workflowTasks[0]?.id);
  assert.equal(metadata.session_approval?.workflowRunId, workflowRuns[0]?.id);

  const messages = sessionMessageRepo.listBySession(session.id);
  assert.ok(messages.some((item) => item.sender_id === 'risk-gate' && /启动 workflow/.test(item.content)));
});

test('dispatchSessionUserMessage preserves contextual fix content after risk approval', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Contextual Approval',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-contextual-approval-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Contextual Approval',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: 'user',
    content: GIT_STATUS_BAR_TASK,
    message_type: 'text',
  });
  const workflowAgentCalls: Array<{ agentId: string; stage: string | null | undefined }> = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-contextual-approval', stderr: '' }),
  });
  setVerificationCommandRunnerForTests(async (command) => ({
    command,
    status: 'passed',
    exitCode: 0,
    stdout: 'contextual approval workflow verification passed',
    stderr: '',
  }));
  setWorkflowGraphDepsForTests({
    planner: async () => {
      throw new Error('planner should not be called for approved contextual workflow handoff');
    },
    runAcpAgent: async (input) => {
      workflowAgentCalls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      const output = outputForWorkflowStage(input.workflowStage);
      const run = agentRunRepo.create({
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
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
        message_type: 'text',
      });
      return {
        run: { ...run, stdout: output },
        message,
        status: 'completed',
      };
    },
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: '帮我修复这个问题',
    contextContent: GIT_STATUS_BAR_TASK,
    taskKind: 'bug_fix',
    riskLevel: 'medium',
  });

  const pendingMessage = sessionMessageRepo.get(taskMessage.id);
  const pendingMetadata = JSON.parse(pendingMessage?.metadata ?? '{}') as {
    risk_assessment?: { taskKind?: string; riskLevel?: string };
    session_approval?: { status?: string; contextContent?: string };
  };
  assert.equal(pendingMetadata.risk_assessment?.taskKind, 'bug_fix');
  assert.equal(pendingMetadata.risk_assessment?.riskLevel, 'medium');
  assert.equal(pendingMetadata.session_approval?.status, 'pending');
  assert.match(pendingMetadata.session_approval?.contextContent ?? '', /Git 分支/);

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '确认',
  });
  await waitFor(
    () => {
      const updated = sessionMessageRepo.get(taskMessage.id);
      const metadata = JSON.parse(updated?.metadata ?? '{}') as {
        session_approval?: { workflowTaskId?: string };
      };
      return Boolean(metadata.session_approval?.workflowTaskId);
    },
    1000,
    () => `calls=${JSON.stringify(workflowAgentCalls)}`,
  );

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  assert.equal(workflowTasks[0]?.title, '帮我修复这个问题');
  assert.match(workflowTasks[0]?.description ?? '', /最近会话上下文/);
  assert.match(workflowTasks[0]?.description ?? '', /Git 分支/);

  const approvedMessage = sessionMessageRepo.get(taskMessage.id);
  const approvedMetadata = JSON.parse(approvedMessage?.metadata ?? '{}') as {
    session_approval?: { status?: string; contextContent?: string; workflowTaskId?: string };
  };
  assert.equal(approvedMetadata.session_approval?.status, 'approved');
  assert.match(approvedMetadata.session_approval?.contextContent ?? '', /Git 分支/);
  assert.equal(approvedMetadata.session_approval?.workflowTaskId, workflowTasks[0]?.id);
});

test('dispatchSessionUserMessage auto-starts graph workflow for low-risk frontend implementation', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Low Risk Frontend Workflow',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-low-risk-frontend-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Low Risk Frontend Workflow',
    provider: 'codex',
    workspace_path: project.path,
  });
  const workflowAgentCalls: Array<{ agentId: string; stage: string | null | undefined }> = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-low-risk-frontend', stderr: '' }),
  });
  setVerificationCommandRunnerForTests(async (command) => ({
    command,
    status: 'passed',
    exitCode: 0,
    stdout: 'low-risk frontend workflow verification passed',
    stderr: '',
  }));
  setWorkflowGraphDepsForTests({
    planner: async () => {
      throw new Error('planner should not be called for low-risk session workflow handoff');
    },
    runAcpAgent: async (input) => {
      workflowAgentCalls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      const output = outputForWorkflowStage(input.workflowStage);
      const run = agentRunRepo.create({
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
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
        message_type: 'text',
      });
      return {
        run: { ...run, stdout: output },
        message,
        status: 'completed',
      };
    },
  });

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: LOW_RISK_FRONTEND_TASK,
  });

  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assert.equal(workflowAgentCalls.some((call) => call.stage === 'planning'), false);
  const { run } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: taskMessage.id,
  });
  assert.equal(run.approved_by, null);
  assert.deepEqual(workflowIntakeEnqueueCalls, [run.id]);
});

test('dispatchSessionUserMessage routes contextual fix follow-ups through workflow', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Contextual Fix Workflow',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-contextual-fix-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Contextual Fix Workflow',
    provider: 'codex',
    workspace_path: project.path,
  });
  const plannerPrompts: string[] = [];
  const workflowAgentCalls: Array<{ agentId: string; stage: string | null | undefined }> = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      plannerPrompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-contextual-fix', stderr: '' };
    },
  });
  setVerificationCommandRunnerForTests(async (command) => ({
    command,
    status: 'passed',
    exitCode: 0,
    stdout: 'contextual fix workflow verification passed',
    stderr: '',
  }));
  setWorkflowGraphDepsForTests({
    planner: async () => {
      throw new Error('planner should not be called for contextual fix workflow handoff');
    },
    runAcpAgent: async (input) => {
      workflowAgentCalls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      const output = outputForWorkflowStage(input.workflowStage);
      const run = agentRunRepo.create({
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
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
        message_type: 'text',
      });
      return {
        run: { ...run, stdout: output },
        message,
        status: 'completed',
      };
    },
  });

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析一下，会话页面右侧栏的本次会话变更为什么没有生效',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '帮我修复这个问题',
  });

  assert.equal(plannerPrompts.length, 0);
  assert.equal(workflowAgentCalls.some((call) => call.stage === 'planning'), false);

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  assert.equal(workflowTasks[0]?.title, '帮我修复这个问题');
  assert.match(workflowTasks[0]?.description ?? '', /会话页面右侧栏/);

  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: taskMessage.id,
  });

  const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    risk_assessment?: { taskKind?: string; riskLevel?: string };
  };
  assert.equal(metadata.risk_assessment?.taskKind, 'frontend_change');
  assert.equal(metadata.risk_assessment?.riskLevel, 'low');
});

test('dispatchSessionUserMessage routes bare contextual fix command through workflow', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Bare Contextual Fix Workflow',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-bare-contextual-fix-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Bare Contextual Fix Workflow',
    provider: 'codex',
    workspace_path: project.path,
  });
  const plannerPrompts: string[] = [];
  const workflowAgentCalls: Array<{ agentId: string; stage: string | null | undefined }> = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      plannerPrompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-bare-contextual-fix', stderr: '' };
    },
  });
  setVerificationCommandRunnerForTests(async (command) => ({
    command,
    status: 'passed',
    exitCode: 0,
    stdout: 'bare contextual fix workflow verification passed',
    stderr: '',
  }));
  setWorkflowGraphDepsForTests({
    planner: async () => {
      throw new Error('planner should not be called for bare contextual fix workflow handoff');
    },
    runAcpAgent: async (input) => {
      workflowAgentCalls.push({ agentId: input.agent.agent_id, stage: input.workflowStage });
      const output = outputForWorkflowStage(input.workflowStage);
      const run = agentRunRepo.create({
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
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
        message_type: 'text',
      });
      return {
        run: { ...run, stdout: output },
        message,
        status: 'completed',
      };
    },
  });

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析一下右侧栏的会话变更为什么所有会话的变更数量都是一样的',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '修复',
  });

  assert.equal(plannerPrompts.length, 0);
  assert.deepEqual(workflowAgentCalls, []);

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  assert.equal(workflowTasks[0]?.title, '修复');
  assert.match(workflowTasks[0]?.description ?? '', /右侧栏的会话变更/);

  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: taskMessage.id,
  });

  const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    risk_assessment?: { taskKind?: string; riskLevel?: string };
  };
  assert.equal(metadata.risk_assessment?.taskKind, 'frontend_change');
  assert.equal(metadata.risk_assessment?.riskLevel, 'low');
});

test('dispatchSessionUserMessage routes bare fix without context through workflow intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Bare Fix Without Context',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-bare-fix-no-context-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Bare Fix Without Context',
    provider: 'codex',
    workspace_path: project.path,
  });
  const plannerPrompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      plannerPrompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-bare-fix-no-context', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '修复',
  });

  assert.equal(plannerPrompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });

  const metadata = JSON.parse(sessionMessageRepo.get(message.id)?.metadata ?? '{}') as {
    session_execution?: { executionPath?: string };
  };
  assert.equal(metadata.session_execution?.executionPath, 'workflow_graph');
});

test('dispatchSessionUserMessage treats continue-fix as new workflow even with stale pending approval', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Stale Pending Continue Fix',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-stale-pending-continue-fix-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Stale Pending Continue Fix',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-stale-pending-continue-fix', stderr: '' }),
  });
  const staleApproval = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: 'user',
    content: '分析一下右侧栏的会话变更为什么所有会话的变更数量都是一样的',
    message_type: 'text',
  });

  const followUp = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '继续修复',
  });

  const staleMetadata = JSON.parse(sessionMessageRepo.get(staleApproval.id)?.metadata ?? '{}') as {
    session_approval?: { status?: string; workflowTaskId?: string };
  };
  assert.equal(staleMetadata.session_approval?.status, 'pending');
  assert.equal(staleMetadata.session_approval?.workflowTaskId, undefined);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: followUp.id,
  });
});

test('dispatchSessionUserMessage routes analysis-only implementation questions through workflow intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Analysis Only Implementation Question',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-analysis-only-implementation-question-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Analysis Only Implementation Question',
    provider: 'codex',
    workspace_path: project.path,
  });
  const plannerPrompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      plannerPrompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-analysis-only-implementation-question', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析一下状态栏的网络延迟是怎么实现的',
  });

  assert.equal(plannerPrompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });

  const metadata = JSON.parse(sessionMessageRepo.get(message.id)?.metadata ?? '{}') as {
    session_execution?: { executionPath?: string };
  };
  assert.equal(metadata.session_execution?.executionPath, 'workflow_graph');
});

test('dispatchSessionUserMessage routes analysis-framed follow-up implementation actions through intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Analysis Framed Action',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-analysis-framed-action-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Analysis Framed Action',
    provider: 'codex',
    workspace_path: project.path,
  });
  const plannerPrompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      plannerPrompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-analysis-framed-action', stderr: '' };
    },
  });

  const content = '分析一下状态栏的网络延迟是怎么实现的并修复前后端延迟展示问题，后端需要提供接口，前端需要展示。';
  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(plannerPrompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);

  const messages = sessionMessageRepo.listBySession(session.id);
  const gateMessage = messages.find((item) => item.sender_id === 'risk-gate');
  assert.equal(gateMessage, undefined);

  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });

  const metadata = JSON.parse(sessionMessageRepo.get(message.id)?.metadata ?? '{}') as {
    risk_assessment?: { riskLevel?: string; requiresApproval?: boolean };
    approval_card?: unknown;
    session_approval?: unknown;
  };
  assert.equal(metadata.risk_assessment?.riskLevel, 'medium');
  assert.equal(metadata.risk_assessment?.requiresApproval, true);
  assert.equal(metadata.approval_card, undefined);
  assert.equal(metadata.session_approval, undefined);
});

test('dispatchSessionUserMessage records low-risk Superpowers intake workflow immediately', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Low Risk Background Run',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-low-risk-background-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Low Risk Background Run',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-low-risk-background', stderr: '' }),
  });
  setVerificationCommandRunnerForTests(async (command) => ({
    command,
    status: 'passed',
    exitCode: 0,
    stdout: 'background workflow verification passed',
    stderr: '',
  }));
  setWorkflowGraphDepsForTests({
    supervisor: async () => new Promise(() => {}),
    planner: async () => {
      return {
        goal: 'Remove project path from footer status bar',
        summary: 'Update the footer status bar display.',
        assumptions: [],
        tasks: [{
          title: 'Update footer status bar',
          description: 'Hide the project path from the session footer status bar.',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Footer no longer shows the project path'],
          scopeRead: [],
          scopeWrite: ['packages/frontend/src/session-ui/SessionShellView.tsx'],
          dependsOn: [],
        }],
        reviewFocus: [],
        verification: ['npm run build'],
        verificationCommands: [{ command: 'npm run build', reason: 'build verifies frontend types', required: true }],
        risks: [],
        needsApproval: true,
      };
    },
    runAcpAgent: async (input) => {
      const output = outputForWorkflowStage(input.workflowStage);
      const run = agentRunRepo.create({
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
      const message = messageRepo.create({
        room_id: input.roomId,
        sender_type: 'agent',
        sender_id: input.agent.agent_id,
        sender_name: input.agent.agent_name,
        content: output,
        message_type: 'text',
      });
      return {
        run: { ...run, stdout: output },
        message,
        status: 'completed',
      };
    },
  });

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: LOW_RISK_FRONTEND_TASK,
  });

  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);

  const messages = sessionMessageRepo.listBySession(session.id);
  const workflowMessage = messages.find((item) =>
    item.sender_id === 'workflow' && /已进入 Superpowers 工作流/.test(item.content)
  );
  assert.ok(workflowMessage);
  assert.equal(workflowMessage.message_type, 'system');
  assert.match(workflowMessage.content, /已进入 Superpowers 工作流/);
  assert.match(workflowMessage.content, /当前阶段：planning/);

  const workflowMessageMetadata = JSON.parse(workflowMessage.metadata ?? '{}') as {
    session_workflow?: {
      executionPath?: string;
      trigger?: string;
      workflowRoomId?: string;
      workflowTaskId?: string;
      workflowRunId?: string;
      workflowStatus?: string;
      workflowStage?: string | null;
      graphVersion?: string;
      activeSuperpowersStage?: string;
      sourceMessageId?: string;
    };
  };
  const { task, run } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: taskMessage.id,
  });
  assert.equal(workflowMessageMetadata.session_workflow?.executionPath, 'workflow_graph');
  assert.equal(workflowMessageMetadata.session_workflow?.trigger, 'workflow_intake');
  assert.equal(workflowMessageMetadata.session_workflow?.workflowRoomId, task.room_id);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowTaskId, task.id);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowRunId, run.id);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowStatus, run.status);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowStage, run.current_stage);
  assert.equal(workflowMessageMetadata.session_workflow?.graphVersion, SUPERPOWERS_V2_GRAPH_VERSION);
  assert.equal(workflowMessageMetadata.session_workflow?.activeSuperpowersStage, 'intake');
  assert.equal(workflowMessageMetadata.session_workflow?.sourceMessageId, taskMessage.id);
});

test('dispatchSessionUserMessage does not auto-approve escalated graph workflow risk', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Workflow Escalated Risk',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-workflow-escalated-risk-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Workflow Escalated Risk',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-risk-escalated', stderr: '' }),
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });

  const originalStartInBackground = workflowOrchestrator.startInBackground;
  const originalApprovePlan = workflowOrchestrator.approvePlan;
  let approveCalls = 0;
  workflowOrchestrator.startInBackground = async (taskId) => {
    const task = taskRepo.get(taskId);
    assert.ok(task);
    const run = workflowRepo.createRun({
      room_id: task.room_id,
      project_id: task.project_id,
      task_id: task.id,
      status: 'awaiting_approval',
      current_stage: 'planning',
      approval_required: true,
      graph_version: 'phase-b-v1',
      graph_state: JSON.stringify({
        plan: { riskLevel: 'high', needsApproval: true },
        riskAssessment: { riskLevel: 'high' },
        approvalCard: { riskLevel: 'high' },
      }),
    });
    workflowRepo.createArtifact({
      task_id: task.id,
      workflow_run_id: run.id,
      workflow_step_id: null,
      artifact_type: 'decision_request',
      title: '风险确认',
      content: 'High risk workflow confirmation',
      metadata: {
        risk_assessment: { riskLevel: 'high' },
        approval_card: { riskLevel: 'high' },
      },
    });
    return run;
  };
  workflowOrchestrator.approvePlan = async (runId, approvedBy) => {
    approveCalls += 1;
    const updated = workflowRepo.updateRun(runId, { status: 'running', approved_by: approvedBy });
    assert.ok(updated);
    return updated;
  };

  try {
    await dispatchSessionUserMessage({
      sessionId: session.id,
      content: '确认',
    });
    await waitFor(() => {
      const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
      const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
        session_approval?: { workflowRunId?: string };
      };
      return Boolean(metadata.session_approval?.workflowRunId);
    });

    const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
    const workflowRuns = workflowTasks.flatMap((task) => workflowRepo.listByTask(task.id));
    assert.equal(approveCalls, 0);
    assert.equal(workflowRuns[0]?.status, 'awaiting_approval');
    assert.equal(workflowRuns[0]?.approved_by, null);
  } finally {
    workflowOrchestrator.startInBackground = originalStartInBackground;
    workflowOrchestrator.approvePlan = originalApprovePlan;
  }
});

test('dispatchSessionUserMessage keeps workflow room and task metadata when workflow start fails', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Workflow Start Failure',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-workflow-start-failure-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Workflow Start Failure',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-risk-start-failure', stderr: '' }),
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });

  const originalStartInBackground = workflowOrchestrator.startInBackground;
  workflowOrchestrator.startInBackground = () => {
    throw new Error('workflow start failed after task creation');
  };

  try {
    await dispatchSessionUserMessage({
      sessionId: session.id,
      content: '确认',
    });
    await waitFor(() => {
      const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
      const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
        session_approval?: {
          executionPath?: string;
          workflowRoomId?: string;
          workflowTaskId?: string;
          workflowRunId?: string;
        };
      };
      return Boolean(
        metadata.session_approval?.executionPath === 'workflow_graph' &&
        metadata.session_approval.workflowRoomId &&
        metadata.session_approval.workflowTaskId,
      );
    });

    const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
    const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
      session_approval?: {
        executionPath?: string;
        workflowRoomId?: string;
        workflowTaskId?: string;
        workflowRunId?: string;
      };
    };
    const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
    assert.equal(metadata.session_approval?.executionPath, 'workflow_graph');
    assert.equal(metadata.session_approval?.workflowTaskId, workflowTasks[0]?.id);
    assert.equal(metadata.session_approval?.workflowRunId, undefined);
  } finally {
    workflowOrchestrator.startInBackground = originalStartInBackground;
  }
});

test('dispatchSessionUserMessage records workflow run id before auto-approval finishes', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Workflow Run Id Before Approval',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-workflow-run-id-before-approval-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Workflow Run Id Before Approval',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-risk-run-id-before-approval', stderr: '' }),
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });

  const originalStartInBackground = workflowOrchestrator.startInBackground;
  const originalApprovePlan = workflowOrchestrator.approvePlan;
  let workflowRunId: string | undefined;
  let approveStarted = false;
  let releaseApprove: (() => void) | undefined;
  workflowOrchestrator.startInBackground = async (taskId) => {
    const task = taskRepo.get(taskId);
    assert.ok(task);
    const run = workflowRepo.createRun({
      room_id: task.room_id,
      project_id: task.project_id,
      task_id: task.id,
      status: 'awaiting_approval',
      current_stage: 'planning',
      approval_required: true,
      graph_version: 'phase-b-v1',
      graph_state: JSON.stringify({
        plan: { riskLevel: 'medium', needsApproval: true },
        riskAssessment: { riskLevel: 'medium' },
        approvalCard: { riskLevel: 'medium' },
      }),
    });
    workflowRunId = run.id;
    workflowRepo.createArtifact({
      task_id: task.id,
      workflow_run_id: run.id,
      workflow_step_id: null,
      artifact_type: 'decision_request',
      title: '风险确认',
      content: 'Medium risk workflow confirmation',
      metadata: {
        risk_assessment: { riskLevel: 'medium' },
        approval_card: { riskLevel: 'medium' },
      },
    });
    return run;
  };
  workflowOrchestrator.approvePlan = async (runId, approvedBy) => {
    approveStarted = true;
    return new Promise((resolve) => {
      releaseApprove = () => {
        const updated = workflowRepo.updateRun(runId, { status: 'running', approved_by: approvedBy });
        assert.ok(updated);
        resolve(updated);
      };
    });
  };

  try {
    await dispatchSessionUserMessage({
      sessionId: session.id,
      content: '确认',
    });
    await waitFor(() => approveStarted && Boolean(workflowRunId));

    const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
    const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
      session_approval?: { workflowRunId?: string };
    };
    assert.equal(metadata.session_approval?.workflowRunId, workflowRunId);

    releaseApprove?.();
    await waitFor(() => workflowRepo.getRun(workflowRunId ?? '')?.approved_by === 'session-risk-gate');
  } finally {
    releaseApprove?.();
    workflowOrchestrator.startInBackground = originalStartInBackground;
    workflowOrchestrator.approvePlan = originalApprovePlan;
  }
});

test('dispatchSessionUserMessage records approved workflow run id without waiting for workflow execution', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Approved Workflow Background Start',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-approved-background-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Approved Workflow Background Start',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-risk-background', stderr: '' }),
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });

  const originalStart = workflowOrchestrator.start;
  const originalStartInBackground = workflowOrchestrator.startInBackground;
  let backgroundRunId: string | undefined;
  workflowOrchestrator.start = async () => new Promise<never>(() => undefined);
  workflowOrchestrator.startInBackground = async (taskId) => {
    const task = taskRepo.get(taskId);
    assert.ok(task);
    const run = workflowRepo.createRun({
      room_id: task.room_id,
      project_id: task.project_id,
      task_id: task.id,
      status: 'running',
      current_stage: 'planning',
      approval_required: true,
      graph_version: 'phase-b-v1',
      graph_state: JSON.stringify({ status: 'running' }),
    });
    backgroundRunId = run.id;
    return run;
  };

  try {
    await dispatchSessionUserMessage({
      sessionId: session.id,
      content: '确认',
    });
    await waitFor(
      () => {
        const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
        const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
          session_approval?: { workflowRunId?: string };
        };
        return Boolean(backgroundRunId && metadata.session_approval?.workflowRunId === backgroundRunId);
      },
      1000,
      () => {
        const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
        return `metadata=${updatedTaskMessage?.metadata ?? '{}'}`;
      },
    );
  } finally {
    workflowOrchestrator.start = originalStart;
    workflowOrchestrator.startInBackground = originalStartInBackground;
  }
});

test('dispatchSessionUserMessage routes high-risk referenced files through intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Referenced Risk',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-referenced-risk-')),
  });
  writeFileSync(join(project.path, 'package.json'), '{"name":"risk-test"}\n');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Referenced Risk',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-referenced-risk', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '修改这个文件',
    workspaceFileRefs: ['package.json'],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    risk_assessment?: { riskLevel?: string; approvalReason?: string; scopeWrite?: string[] };
    approval_card?: unknown;
  };
  assert.equal(metadata.risk_assessment?.riskLevel, 'high');
  assert.equal(metadata.risk_assessment?.approvalReason, 'dependency/root config changes require approval');
  assert.deepEqual(metadata.risk_assessment?.scopeWrite, ['package.json']);
  assert.equal(metadata.approval_card, undefined);
});

test('dispatchSessionUserMessage treats edit wording as referenced file write intent', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Edit Wording Risk',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-edit-wording-risk-')),
  });
  writeFileSync(join(project.path, 'package.json'), '{"name":"edit-risk-test"}\n');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Edit Wording Risk',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-edit-wording-risk', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: 'edit this file',
    workspaceFileRefs: ['package.json'],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    risk_assessment?: { riskLevel?: string; scopeWrite?: string[] };
  };
  assert.equal(metadata.risk_assessment?.riskLevel, 'high');
  assert.deepEqual(metadata.risk_assessment?.scopeWrite, ['package.json']);
});

test('dispatchSessionUserMessage cancels pending session approval without starting planner', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Session Risk Cancel',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-risk-cancel-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session Risk Cancel',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-risk-cancelled', stderr: '' };
    },
  });

  const taskMessage = createPendingSessionApprovalMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
    taskKind: 'fullstack_change',
    riskLevel: 'medium',
  });
  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '取消。',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);

  const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    session_approval?: { status?: string };
  };
  assert.equal(metadata.session_approval?.status, 'rejected');

  const messages = sessionMessageRepo.listBySession(session.id);
  assert.ok(messages.some((item) => item.sender_id === 'risk-gate' && /已取消/.test(item.content)));
});

test('dispatchSessionUserMessage records global-prompt sessions through workflow intake without planner prompt', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Global Session Prompt',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-global-prompt-')),
  });
  settingsRepo.updateSystem({ global_session_prompt: '全局规则：先遵循系统设置注入。' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Global Session Prompt',
    provider: 'codex',
    workspace_path: project.path,
    current_goal: '完成会话提示词验收',
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-global-session-prompt', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析当前状态',
  });

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assert.equal(message.content, '分析当前状态');
  const { task } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.match(task.description ?? '', /分析当前状态/);
});

test('dispatchSessionUserMessage routes knowledge requests through workflow intake without runtime prompt', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Knowledge Tool Prompt',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-knowledge-tool-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Knowledge Tool Prompt',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-knowledge-tool', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '查询项目知识库里的验收记录',
  });

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  const { task } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.match(task.description ?? '', /查询项目知识库里的验收记录/);
});

test('dispatchSessionUserMessage routes empty-global-prompt sessions through workflow intake', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Empty Global Session Prompt',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-empty-global-prompt-')),
  });
  settingsRepo.updateSystem({ global_session_prompt: null });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Empty Global Session Prompt',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-empty-global-session-prompt', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({ sessionId: session.id, content: '保持现有 prompt' });

  assert.equal(prompts.length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  const { task } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.match(task.description ?? '', /保持现有 prompt/);
});

test('dispatchSessionUserMessage rejects platform skill refs outside planner backend', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Reject Foreign Platform Skill Provider',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-reject-platform-provider-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });
  createPlatformSkill('codex', 'frontend-design', 'Frontend design workflow.');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Reject Foreign Platform Skill Provider',
    provider: 'codex',
    workspace_path: project.path,
  });

  await assert.rejects(
    () => dispatchSessionUserMessage({
      sessionId: session.id,
      content: '不要创建这条消息',
      platformSkillRefs: [{ provider: 'codex', name: 'frontend-design' }],
    }),
    /platform skill provider must match planner backend/,
  );
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
});

test('dispatchSessionUserMessage rejects missing planner platform skill refs', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Reject Missing Platform Skill',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-reject-missing-platform-skill-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Reject Missing Platform Skill',
    provider: 'codex',
    workspace_path: project.path,
  });

  await assert.rejects(
    () => dispatchSessionUserMessage({
      sessionId: session.id,
      content: '不要创建这条消息',
      platformSkillRefs: [{ provider: 'codex', name: 'missing-skill' }],
    }),
    /platform skill is not available/,
  );
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
});

test('dispatchSessionUserMessage stores normalized file refs in message metadata', async () => {
  const project = projectRepo.create({
    name: 'Dispatch File Refs',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-file-refs-')),
  });
  mkdirSync(join(project.path, 'src'), { recursive: true });
  writeFileSync(join(project.path, 'src', 'app.ts'), 'export const answer = 42;\n');
  const libraryFile = fileRepo.createAgentDocument({
    project_id: project.id,
    title: 'handoff.md',
    content: '历史交接记录',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch File Refs',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-session', stderr: '' }),
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '结合这些文件分析',
    workspaceFileRefs: [' ./src/../src/app.ts ', 'src/app.ts'],
    libraryFileRefs: [libraryFile.id, libraryFile.id],
  });

  const metadata = JSON.parse(message.metadata ?? '{}') as {
    workspace_file_refs?: string[];
    library_file_refs?: string[];
  };
  assert.deepEqual(metadata.workspace_file_refs, ['src/app.ts']);
  assert.deepEqual(metadata.library_file_refs, [libraryFile.id]);
});

test('dispatchSessionUserMessage stores uploaded project file refs as message attachments', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Uploaded Attachment Metadata',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-uploaded-attachment-')),
  });
  const storedPath = join(project.path, 'brief.txt');
  writeFileSync(storedPath, '用户粘贴的文本附件');
  const uploadedFile = fileRepo.create({
    project_id: project.id,
    original_name: 'brief.txt',
    stored_name: 'stored-brief.txt',
    mime_type: 'text/plain',
    size: 27,
    url: '/uploads/files/project/brief.txt',
    storage_path: storedPath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Uploaded Attachment Metadata',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'codex-uploaded-metadata', stderr: '' }),
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析附件',
    libraryFileRefs: [uploadedFile.id],
  });

  const metadata = JSON.parse(message.metadata ?? '{}') as {
    library_file_refs?: string[];
    attachments?: Array<{
      id: string;
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      url: string;
      isImage: boolean;
      deleted: boolean;
    }>;
  };
  assert.deepEqual(metadata.library_file_refs, [uploadedFile.id]);
  assert.deepEqual(metadata.attachments, [{
    id: uploadedFile.id,
    fileId: uploadedFile.id,
    name: 'brief.txt',
    mimeType: 'text/plain',
    size: 27,
    isImage: false,
    url: '/uploads/files/project/brief.txt',
    deleted: false,
  }]);
});

test('dispatchSessionUserMessage rejects foreign library refs before creating a message', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Reject File Refs',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-reject-file-refs-')),
  });
  const otherProject = projectRepo.create({
    name: 'Dispatch Foreign Library',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-foreign-library-')),
  });
  const foreignFile = fileRepo.createAgentDocument({
    project_id: otherProject.id,
    title: 'foreign.md',
    content: '其它项目的资料',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Reject File Refs',
    provider: 'codex',
    workspace_path: project.path,
  });

  await assert.rejects(
    () => dispatchSessionUserMessage({
      sessionId: session.id,
      content: '不要创建这条消息',
      libraryFileRefs: [foreignFile.id],
    }),
    /library file reference is not available/,
  );
  assert.equal(sessionRepo.get(session.id)?.title, 'Dispatch Reject File Refs');
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
});

test('dispatchSessionUserMessage carries referenced workspace files into workflow intake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-dispatch-context-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = true;\n');
  const project = projectRepo.create({ name: 'Dispatch Context', path: root });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Context Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const prompts: string[] = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt }) => {
      prompts.push(prompt);
      return { exitCode: 0, sessionId: 'codex-context', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析引用',
    workspaceFileRefs: ['src/app.ts'],
  });

  assert.equal(prompts.length, 0);
  const { task } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.match(task.description ?? '', /Workspace refs:/);
  assert.match(task.description ?? '', /src\/app\.ts/);
});

test('dispatchSessionUserMessage carries uploaded project file refs into workflow intake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-dispatch-uploaded-context-'));
  const textPath = join(root, 'notes.md');
  const imagePath = join(root, 'screen.png');
  writeFileSync(textPath, '# 粘贴文本\n\n请读取这段内容。\n');
  writeFileSync(imagePath, 'fake-png');
  const project = projectRepo.create({ name: 'Dispatch Uploaded Context', path: root });
  const textFile = fileRepo.create({
    project_id: project.id,
    original_name: 'notes.md',
    stored_name: 'stored-notes.md',
    mime_type: 'text/markdown',
    size: 42,
    url: '/uploads/files/project/notes.md',
    storage_path: textPath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const imageFile = fileRepo.create({
    project_id: project.id,
    original_name: 'screen.png',
    stored_name: 'stored-screen.png',
    mime_type: 'image/png',
    size: 8,
    url: '/uploads/files/project/screen.png',
    storage_path: imagePath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Uploaded Context Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const captured: Array<{ prompt: string; imagePaths?: string[] }> = [];

  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt, imagePaths }) => {
      captured.push({ prompt, imagePaths });
      return { exitCode: 0, sessionId: 'codex-uploaded-context', stderr: '' };
    },
  });

  const message = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析粘贴附件',
    libraryFileRefs: [textFile.id, imageFile.id],
  });

  assert.deepEqual(captured, []);
  const { task } = assertSuperpowersIntakeForMessage({
    projectId: project.id,
    sessionId: session.id,
    messageId: message.id,
  });
  assert.match(task.description ?? '', /Library refs:/);
  assert.match(task.description ?? '', new RegExp(textFile.id));
  assert.match(task.description ?? '', new RegExp(imageFile.id));
});

test('recordSessionImageGenerationJobMessage stores image job id and output attachments', () => {
  const project = projectRepo.create({
    name: 'Session Image Job Message',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-image-job-message-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Session Image Job Message',
    provider: 'codex',
    workspace_path: project.path,
  });

  const message = recordSessionImageGenerationJobMessage({
    sessionId: session.id,
    job: {
      id: 'image-job-output-test',
      project_id: project.id,
      room_id: null,
      session_id: session.id,
      source_message_id: null,
      source_agent_id: null,
      source_task_id: null,
      provider_profile_id: 'profile-test',
      workflow: 'generate',
      prompt: '生成一张海报',
      count: 1,
      quality: 'auto',
      size: 'auto',
      status: 'completed',
      message: null,
      error: null,
      created_at: 1,
      started_at: 2,
      completed_at: 3,
      updated_at: 3,
    },
    outputs: [{
      id: 'output-test',
      job_id: 'image-job-output-test',
      file_id: 'file-output-test',
      slot: 1,
      name: 'generated.png',
      url: '/uploads/files/generated.png',
      mime_type: 'image/png',
      size: 42,
      width: 1024,
      height: 1024,
      created_at: 3,
    }],
  });

  const stored = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(stored?.metadata ?? '{}') as {
    image_generation_job_id?: string;
    image_generation_status?: string;
    attachments?: Array<{
      id: string;
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      url: string;
      isImage: boolean;
    }>;
  };
  assert.equal(message.role, 'system');
  assert.equal(message.sender_id, 'image-generation');
  assert.match(message.content, /生成一张海报/);
  assert.equal(metadata.image_generation_job_id, 'image-job-output-test');
  assert.equal(metadata.image_generation_status, 'completed');
  assert.deepEqual(metadata.attachments, [{
    id: 'file-output-test',
    fileId: 'file-output-test',
    name: 'generated.png',
    mimeType: 'image/png',
    size: 42,
    url: '/uploads/files/generated.png',
    isImage: true,
  }]);
});

test('recordSessionImageGenerationJobMessage rejects mismatched job and target session', () => {
  const project = projectRepo.create({
    name: 'Session Image Job Mismatch',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-image-job-mismatch-')),
  });
  const sourceSession = sessionRepo.create({
    project_id: project.id,
    title: 'Source Image Session',
    provider: 'codex',
    workspace_path: project.path,
  });
  const targetSession = sessionRepo.create({
    project_id: project.id,
    title: 'Target Image Session',
    provider: 'codex',
    workspace_path: project.path,
  });

  assert.throws(
    () => recordSessionImageGenerationJobMessage({
      sessionId: targetSession.id,
      job: {
        id: 'image-job-mismatch-test',
        project_id: project.id,
        room_id: null,
        session_id: sourceSession.id,
        source_message_id: null,
        source_agent_id: null,
        source_task_id: null,
        provider_profile_id: 'profile-test',
        workflow: 'generate',
        prompt: '不要写入错误会话',
        count: 1,
        quality: 'auto',
        size: 'auto',
        status: 'queued',
        message: null,
        error: null,
        created_at: 1,
        started_at: null,
        completed_at: null,
        updated_at: 1,
      },
    }),
    /image generation job session mismatch/,
  );
  assert.equal(sessionMessageRepo.listBySession(targetSession.id).length, 0);
});

test('recordSessionImageGenerationToolResultEvidence stores generated outputs as session evidence', () => {
  const project = projectRepo.create({
    name: 'Session Image Tool Evidence',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-image-tool-evidence-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Session Image Tool Evidence',
    provider: 'codex',
    workspace_path: project.path,
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    mode: 'code',
    phase: 'implementing',
    prompt: '生成图片',
  });

  const event = recordSessionImageGenerationToolResultEvidence({
    sessionId: session.id,
    sourceRunId: run.id,
    result: {
      job_id: 'image-tool-job-1',
      status: 'completed',
      error: null,
      outputs: [{
        file_id: 'file-generated-1',
        resource_id: 'file:file-generated-1',
        url: '/uploads/files/project/generated.png',
        slot: 1,
      }],
    },
  });

  assert.equal(event.event_type, 'tool_result');
  assert.equal(event.source_run_id, run.id);
  assert.equal(event.title, '图片生成结果');
  assert.match(event.summary ?? '', /1 张图片/);
  assert.deepEqual(event.payload, {
    tool_name: 'generate_image',
    job_id: 'image-tool-job-1',
    status: 'completed',
    error: null,
    outputs: [{
      file_id: 'file-generated-1',
      resource_id: 'file:file-generated-1',
      url: '/uploads/files/project/generated.png',
      slot: 1,
    }],
  });
});

test('dispatchSessionUserMessage routes workflow artifact change request into existing run', async () => {
  const project = projectRepo.create({
    name: 'workflow artifact change request project',
    path: mkdtempSync(join(tmpdir(), 'session-artifact-change-request-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Artifact Change Request Room' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Artifact Change Request Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '实现 workflow-first',
    metadata: {},
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Artifact change request workflow',
    source_message_id: sourceMessage.id,
    created_from: 'chat_plan',
  });
  const state = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: sourceMessage.content,
    projectPath: project.path,
  });
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
    current_stage: 'planning',
    approval_required: true,
    graph_version: SUPERPOWERS_V2_GRAPH_VERSION,
    graph_state: serializeGraphState({
      ...state,
      workflowRunId: 'pending',
      currentNode: 'planning',
      superpowersPhase: 'plan_review',
      activeSuperpowersStage: 'plan_review',
      status: 'awaiting_approval',
    }),
  });
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v1',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  const approved = workflowArtifactVersionRepo.approve(draft.id, {
    approved_by: 'test',
    approval_message_id: null,
  });
  assert.ok(approved);
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...state,
    workflowRunId: workflow.id,
    currentNode: 'planning',
    draftPlanArtifactVersionId: null,
    approvedPlanArtifactVersionId: approved.id,
    implementationPlanPath: 'docs/superpowers/plans/test.md',
    planReviewVerdict: 'approved',
    superpowersPhase: 'plan_review',
    activeSuperpowersStage: 'plan_review',
    plan: {
      goal: sourceMessage.content,
      summary: 'Old approved plan',
      assumptions: [],
      tasks: [
        {
          title: 'Old child task',
          description: 'Old implementation task',
          suggestedRole: 'executor',
          priority: 'normal',
          acceptance: ['Old behavior is implemented'],
          scopeRead: [],
          scopeWrite: ['packages/backend/src/old.ts'],
          dependsOn: [],
        },
      ],
      reviewFocus: [],
      verification: ['npm run build'],
      verificationCommands: [
        { command: 'npm run build', reason: 'Old verification', required: true },
      ],
      risks: [],
      needsApproval: true,
    },
    workflowPlan: {
      workflow_name: 'Old workflow',
      source_message_id: sourceMessage.id,
      goal: sourceMessage.content,
      summary: 'Old approved plan',
      tasks: [
        {
          id: 'old-task',
          title: 'Old child task',
          description: 'Old implementation task',
          role: 'executor',
          agent_id: null,
          mode: 'serial',
          depends_on: [],
          status: 'completed',
          progress: 100,
          result_refs: [],
        },
      ],
    },
    status: 'awaiting_approval',
  }));
  const child = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: 'Old child task',
  });
  const dispatchStep = workflowRepo.createStep({
    workflow_run_id: workflow.id,
    task_id: task.id,
    stage: 'assignment',
    node_name: 'dispatch',
    status: 'completed',
    sort_order: 1,
  });
  const verifyStep = workflowRepo.createStep({
    workflow_run_id: workflow.id,
    task_id: child.id,
    stage: 'acceptance',
    node_name: 'verify',
    status: 'completed',
    sort_order: 2,
  });
  const oldExecutor = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'old-executor',
    agent_name: 'Old Executor',
  });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: oldExecutor.id,
    agent_id: 'old-executor',
    backend: 'codex',
    task_id: child.id,
    workflow_run_id: workflow.id,
    workflow_step_id: verifyStep.id,
    workflow_stage: 'implementation',
    prompt: 'old execution still running',
  });
  const stateWithExecution = parseGraphState(workflowRepo.getRun(workflow.id)?.graph_state ?? null);
  assert.ok(stateWithExecution);
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...stateWithExecution,
    childTaskIds: [child.id],
    childTaskPlanIndexes: { [child.id]: 0 },
  }));
  const enqueued: string[] = [];
  const originalEnqueue = workflowOrchestrator.enqueueExistingGraphRun;
  workflowOrchestrator.enqueueExistingGraphRun = (runId) => {
    enqueued.push(runId);
    const run = workflowRepo.getRun(runId);
    assert.ok(run);
    return { run, enqueued: true };
  };
  try {
    const requestMessage = await dispatchSessionUserMessage({
      sessionId: session.id,
      content: '请修改 plan v1：增加测试步骤。',
      workflowArtifactChangeRequest: {
        workflowRunId: workflow.id,
        artifactVersionId: approved.id,
        artifactType: 'plan',
      },
    });

    assert.deepEqual(enqueued, [workflow.id]);
    assert.equal(taskRepo.listByProject(project.id).filter((item) => item.source_message_id === requestMessage.id).length, 0);
    const updatedRun = workflowRepo.getRun(workflow.id);
    assert.equal(updatedRun?.status, 'running');
    const updatedState = parseGraphState(updatedRun?.graph_state ?? null);
    assert.equal(updatedState?.artifactChangeRequestMessageId, requestMessage.id);
    assert.equal(updatedState?.artifactChangeRequestArtifactVersionId, approved.id);
    assert.equal(updatedState?.draftPlanArtifactVersionId, null);
    assert.equal(updatedState?.approvedPlanArtifactVersionId, null);
    assert.equal(updatedState?.planReviewVerdict, null);
    assert.equal(updatedState?.plan, null);
    assert.equal(updatedState?.workflowPlan, null);
    assert.deepEqual(updatedState?.childTaskIds, []);
    assert.deepEqual(updatedState?.childTaskPlanIndexes, {});
    assert.equal(taskRepo.get(child.id), undefined);
    assert.ok(taskRepo.getIncludingDeleted(child.id)?.deleted_at);
    assert.equal(workflowRepo.getStep(dispatchStep.id)?.status, 'skipped');
    assert.equal(workflowRepo.getStep(verifyStep.id)?.status, 'skipped');
    assert.equal(agentRunRepo.get(activeRun.id)?.status, 'interrupted');
    assert.match(agentRunRepo.get(activeRun.id)?.error ?? '', /Superseded by artifact change request/);
    const metadata = JSON.parse(sessionMessageRepo.get(requestMessage.id)?.metadata ?? '{}') as {
      workflow_artifact_change_request?: {
        workflowRunId?: string;
        artifactVersionId?: string;
        artifactType?: string;
      };
    };
    assert.equal(metadata.workflow_artifact_change_request?.workflowRunId, workflow.id);
    assert.equal(metadata.workflow_artifact_change_request?.artifactVersionId, approved.id);
    assert.equal(metadata.workflow_artifact_change_request?.artifactType, 'plan');
  } finally {
    workflowOrchestrator.enqueueExistingGraphRun = originalEnqueue;
    setWorkflowOrchestratorGraphDeps({});
  }
});

test('dispatchSessionUserMessage rejects invalid workflow artifact change requests without starting planner or workflow', async () => {
  const project = projectRepo.create({
    name: 'Invalid Artifact Change Request Project',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-invalid-artifact-change-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Invalid Artifact Change Request Session',
    workspace_path: project.path,
  });

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '请修改这个不存在的计划。',
    workflowArtifactChangeRequest: {
      workflowRunId: 'missing-run',
      artifactVersionId: 'missing-artifact',
      artifactType: 'plan',
    },
  });

  assert.equal(taskRepo.listByProject(project.id).length, 0);
  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  const blocker = sessionEvidenceRepo.listBySession(session.id).find((event) =>
    event.event_type === 'blocker' && /artifact change request rejected/i.test(event.title)
  );
  assert.ok(blocker);
  assert.match(blocker.summary ?? '', /不会启动新的 planner 或 workflow/);
});

test('dispatchSessionUserMessage blocks lightweight plan revisions instead of converting them into normal plans', async () => {
  const project = projectRepo.create({
    name: 'Lightweight Artifact Change Request Project',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-lightweight-artifact-change-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Lightweight Artifact Change Request Session',
    workspace_path: project.path,
  });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '实现一个轻量修复',
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Lightweight artifact room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Lightweight artifact workflow',
    source_message_id: sourceMessage.id,
    created_from: 'chat_plan',
  });
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'blocked',
    current_stage: 'planning',
    approval_required: true,
    graph_version: SUPERPOWERS_V2_GRAPH_VERSION,
    graph_state: serializeGraphState({
      ...emptyAgentWorkflowState({
        workflowRunId: 'pending',
        projectId: project.id,
        roomId: room.id,
        taskId: task.id,
        userGoal: sourceMessage.content,
        projectPath: project.path,
      }),
      workflowRunId: 'pending',
      currentNode: 'approval',
      status: 'blocked',
      error: 'Superpowers dispatch requires approved plan artifact version',
    }),
  });
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'lightweight_plan',
    title: 'Lightweight Plan',
    content: '# Lightweight plan',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  const enqueuedBefore = [...workflowIntakeEnqueueCalls];

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '请修改轻量计划。',
    workflowArtifactChangeRequest: {
      workflowRunId: workflow.id,
      artifactVersionId: draft.id,
      artifactType: 'lightweight_plan',
    },
  });

  assert.deepEqual(workflowIntakeEnqueueCalls, enqueuedBefore);
  const blocker = sessionEvidenceRepo.listBySession(session.id).find((event) =>
    event.event_type === 'blocker' &&
    (event.payload as { reason?: string }).reason === 'lightweight_plan_revision_not_implemented'
  );
  assert.ok(blocker);
  const updatedState = parseGraphState(workflowRepo.getRun(workflow.id)?.graph_state ?? null);
  assert.equal(updatedState?.draftPlanArtifactVersionId, null);
});

function createPlatformSkill(provider: 'codex' | 'claudecode' | 'opencode', name: string, description: string): void {
  const root = provider === 'codex'
    ? join(process.env.CODEX_HOME!, 'skills')
    : provider === 'claudecode'
      ? join(platformSkillsHome, '.claude', 'skills')
      : join(platformSkillsHome, '.config', 'opencode', 'skills');
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `Use ${name}.`,
    '',
  ].join('\n'));
}

const GIT_STATUS_BAR_TASK = '请实现一个开发任务：在会话页面底部状态栏显示当前项目的 Git 分支、未提交改动数量和最后一次提交摘要。后端需要提供读取 Git 状态的接口，前端需要展示并在状态变化后刷新。';
const LOW_RISK_FRONTEND_TASK = '去掉底部状态栏的项目路径';

function createPendingSessionApprovalMessage(input: {
  sessionId: string;
  content: string;
  contextContent?: string;
  taskKind?: 'fullstack_change' | 'frontend_change' | 'backend_change' | 'bug_fix' | 'test_only' | 'ops_or_config';
  riskLevel?: 'medium' | 'high';
  scopeRead?: string[];
  scopeWrite?: string[];
}) {
  const taskKind = input.taskKind ?? 'fullstack_change';
  const riskLevel = input.riskLevel ?? 'medium';
  const scopeRead = input.scopeRead ?? [];
  const scopeWrite = input.scopeWrite ?? [];
  const approvalReason = riskLevel === 'high'
    ? 'dependency/root config changes require approval'
    : 'development task requires approval';
  const riskAssessment = {
    taskKind,
    riskLevel,
    requiresApproval: true,
    approvalReason,
    confidence: 0.9,
    reasons: [approvalReason],
    scopeRead,
    scopeWrite,
    verificationCommands: [],
  };
  const approvalCard = {
    riskLevel,
    taskKind,
    summary: input.content,
    approvalReason,
    agents: pendingApprovalAgentsForTaskKind(taskKind),
    executionMode: taskKind === 'fullstack_change' ? 'hybrid' : 'serial',
    scopeRead,
    scopeWrite,
    verification: [{ command: 'npm run build', reason: '验证开发任务构建通过', required: true }],
    risks: ['历史风险门禁兼容路径。'],
    assumptions: ['该 pending approval 来自旧版本会话。'],
  };
  const message = sessionMessageRepo.create({
    session_id: input.sessionId,
    role: 'user',
    sender_id: 'user',
    sender_name: 'user',
    content: input.content,
    message_type: 'text',
    metadata: {},
  });
  return sessionMessageRepo.updateMetadata(message.id, {
    risk_assessment: riskAssessment,
    approval_card: approvalCard,
    session_approval: {
      status: 'pending',
      sourceMessageId: message.id,
      originalContent: input.content,
      ...(input.contextContent ? { contextContent: input.contextContent } : {}),
      riskAssessment,
      approvalCard,
      workspaceFileRefs: scopeRead,
      libraryFileRefs: [],
      platformSkillRefs: [],
      createdAt: Date.now(),
    },
  }) ?? message;
}

function pendingApprovalAgentsForTaskKind(
  taskKind: 'fullstack_change' | 'frontend_change' | 'backend_change' | 'bug_fix' | 'test_only' | 'ops_or_config',
): string[] {
  if (taskKind === 'fullstack_change') return ['planner', 'frontend-executor', 'backend-executor', 'reviewer', 'acceptor'];
  if (taskKind === 'frontend_change') return ['planner', 'frontend-executor', 'reviewer', 'acceptor'];
  if (taskKind === 'backend_change' || taskKind === 'bug_fix') return ['planner', 'backend-executor', 'reviewer', 'acceptor'];
  return ['planner', 'reviewer', 'acceptor'];
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000, describe?: () => string): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for condition${describe ? `: ${describe()}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertSuperpowersIntakeForMessage(input: {
  projectId: string;
  sessionId: string;
  messageId: string;
}) {
  const workflowTasks = taskRepo.listByProject(input.projectId).filter((task) => task.source_message_id === input.messageId);
  assert.equal(workflowTasks.length, 1);
  const workflowRuns = workflowRepo.listByTask(workflowTasks[0]!.id);
  assert.equal(workflowRuns.length, 1);
  assert.equal(workflowRuns[0]?.graph_version, SUPERPOWERS_V2_GRAPH_VERSION);
  assert.ok(workflowRuns[0]?.workflow_definition_id);
  assert.equal(workflowRuns[0]?.workflow_definition_version, 1);
  const snapshot = JSON.parse(workflowRuns[0]?.workflow_definition_snapshot ?? '{}') as {
    builtinKey?: string;
    definition?: { metadata?: { runtime_profile?: string; gate_policy?: string } };
  };
  assert.equal(snapshot.builtinKey, 'superpowers-development');
  assert.equal(snapshot.definition?.metadata?.runtime_profile, 'superpowers');
  assert.equal(workflowRuns[0]?.current_stage, 'planning');
  assert.equal(parseGraphState(workflowRuns[0]?.graph_state ?? null)?.activeSuperpowersStage, 'intake');
  assert.equal(
    taskEventRepo.listByTask(workflowTasks[0]!.id).filter((event) => event.type === 'workflow_started').length,
    1,
  );

  const updatedTaskMessage = sessionMessageRepo.get(input.messageId);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    session_execution?: {
      executionPath?: string;
      trigger?: string;
      workflowTaskId?: string;
      workflowRunId?: string;
      graphVersion?: string;
      activeSuperpowersStage?: string;
    };
  };
  assert.equal(metadata.session_execution?.executionPath, 'workflow_graph');
  assert.equal(metadata.session_execution?.trigger, 'workflow_intake');
  assert.equal(metadata.session_execution?.workflowTaskId, workflowTasks[0]?.id);
  assert.equal(metadata.session_execution?.workflowRunId, workflowRuns[0]?.id);
  assert.equal(metadata.session_execution?.graphVersion, SUPERPOWERS_V2_GRAPH_VERSION);
  assert.equal(metadata.session_execution?.activeSuperpowersStage, 'intake');
  assert.doesNotMatch(JSON.stringify(metadata), /low_risk_auto/);

  const messages = sessionMessageRepo.listBySession(input.sessionId);
  const workflowMessages = messages.filter((item) =>
    item.sender_id === 'workflow' && /已进入 Superpowers 工作流/.test(item.content)
  );
  const workflowMessageMetadataByMessage = workflowMessages.map((item) => ({
    message: item,
    metadata: JSON.parse(item.metadata ?? '{}') as {
      session_workflow?: {
        trigger?: string;
        graphVersion?: string;
        activeSuperpowersStage?: string;
        workflowRunId?: string;
        sourceMessageId?: string;
      };
    },
  }));
  const workflowMessageWithMetadata = workflowMessageMetadataByMessage.find((item) =>
    item.metadata.session_workflow?.sourceMessageId === input.messageId
  );
  assert.ok(workflowMessageWithMetadata?.message);
  const workflowMessageMetadata = workflowMessageWithMetadata.metadata as {
    session_workflow?: {
      trigger?: string;
      graphVersion?: string;
      activeSuperpowersStage?: string;
      workflowRunId?: string;
      sourceMessageId?: string;
    };
  };
  assert.equal(workflowMessageMetadata.session_workflow?.trigger, 'workflow_intake');
  assert.equal(workflowMessageMetadata.session_workflow?.graphVersion, SUPERPOWERS_V2_GRAPH_VERSION);
  assert.equal(workflowMessageMetadata.session_workflow?.activeSuperpowersStage, 'intake');
  assert.equal(workflowMessageMetadata.session_workflow?.workflowRunId, workflowRuns[0]?.id);
  assert.equal(workflowMessageMetadata.session_workflow?.sourceMessageId, input.messageId);

  const evidence = sessionEvidenceRepo.listBySession(input.sessionId).filter((item) => item.source_message_id === input.messageId);
  assert.ok(evidence.some((item) => {
    const payload = item.payload as { trigger?: string; graph_version?: string };
    return payload.trigger === 'workflow_intake' && payload.graph_version === SUPERPOWERS_V2_GRAPH_VERSION;
  }));

  return { task: workflowTasks[0]!, run: workflowRuns[0]! };
}

function outputForWorkflowStage(stage: string | null | undefined): string {
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
      acceptedCriteria: ['Session workflow dispatch completed'],
      failedCriteria: [],
      notes: 'Accepted by test stub.',
    });
  }
  if (stage === 'implementation') {
    return JSON.stringify({
      tddEvidence: [
        { stage: 'RED', command: 'node --test session-dispatch', passed: false, summary: 'failed as expected' },
        { stage: 'GREEN', command: 'node --test session-dispatch', passed: true, summary: 'passed' },
      ],
      superpowers: {
        tddEvidence: [
          { stage: 'RED', command: 'node --test session-dispatch', passed: false, summary: 'failed as expected' },
          { stage: 'GREEN', command: 'node --test session-dispatch', passed: true, summary: 'passed' },
        ],
      },
    });
  }
  if (stage === 'planning') {
    return [
      'planning completed',
      '',
      '```json',
      JSON.stringify({
        superpowers: {
          designDocPath: 'docs/superpowers/specs/session-dispatch-design.md',
          designReviewVerdict: 'approved',
          worktree: {
            path: '/tmp/open-deep-sea-session-dispatch-test',
            branchName: 'session-dispatch-test',
            baseRef: 'test',
          },
          implementationPlanPath: 'docs/superpowers/plans/session-dispatch-plan.md',
          planReviewVerdict: 'approved',
        },
      }),
      '```',
    ].join('\n');
  }
  return `${stage ?? 'workflow'} completed`;
}
