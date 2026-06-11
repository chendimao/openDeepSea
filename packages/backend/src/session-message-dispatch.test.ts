import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
const { roomAgentRepo } = await import('./repos/rooms.js');
const { settingsRepo } = await import('./repos/settings.js');
const { sessionMessageRepo, sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { taskRepo } = await import('./repos/tasks.js');
const { workflowRepo } = await import('./repos/workflows.js');
const {
  dispatchSessionUserMessage,
  recordSessionImageGenerationJobMessage,
  recordSessionImageGenerationToolResultEvidence,
} = await import('./session-message-dispatch.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { setWorkflowOrchestratorGraphDeps, workflowOrchestrator } = await import('./workflows/orchestrator.js');
const { setVerificationCommandRunnerForTests } = await import('./workflows/graph/verification.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
  setWorkflowOrchestratorGraphDeps({});
  setVerificationCommandRunnerForTests(null);
  settingsRepo.updateSystem({ global_session_prompt: null });
});

test('dispatchSessionUserMessage uses project Session Planner backend instead of session provider', async () => {
  const project = projectRepo.create({
    name: 'Dispatch Planner Backend',
    path: mkdtempSync(join(tmpdir(), 'session-dispatch-planner-backend-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Dispatch Session',
    provider: 'codex',
    workspace_path: project.path,
  });

  setSessionRuntimeAdapterForTest({
    backend: 'opencode',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'opencode-session', stderr: '' }),
  });

  await dispatchSessionUserMessage({ sessionId: session.id, content: '分析当前项目' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const [run] = sessionRunRepo.listBySession(session.id);
  assert.equal(run?.agent_id, 'planner');
  assert.equal(run?.provider, 'opencode');
  assert.match(run?.runtime_profile_snapshot ?? '', /"backend_source":"project"/);
});

test('dispatchSessionUserMessage injects explicit planner platform skill refs into runtime prompt', async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 30));

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    platform_skill_refs?: Array<{ provider: string; name: string }>;
  };
  assert.deepEqual(metadata.platform_skill_refs, [{ provider: 'codex', name: 'frontend-design' }]);
  assert.match(prompts[0] ?? '', /## Explicit Platform Skills/);
  assert.match(prompts[0] ?? '', /\$frontend-design/);
  assert.match(prompts[0] ?? '', /Frontend design workflow\./);
});

test('dispatchSessionUserMessage gates medium-risk development tasks before starting planner', async () => {
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
  assert.ok(gateMessage);
  assert.match(gateMessage.content, /风险确认/);
  assert.match(gateMessage.content, /回复“确认”/);

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    risk_assessment?: { riskLevel?: string; requiresApproval?: boolean };
    approval_card?: { riskLevel?: string; taskKind?: string; agents?: string[] };
    session_approval?: { status?: string; originalContent?: string };
  };
  assert.equal(metadata.risk_assessment?.riskLevel, 'medium');
  assert.equal(metadata.risk_assessment?.requiresApproval, true);
  assert.equal(metadata.approval_card?.riskLevel, 'medium');
  assert.deepEqual(metadata.approval_card?.agents, [
    'planner',
    'frontend-executor',
    'backend-executor',
    'reviewer',
    'acceptor',
  ]);
  assert.equal(metadata.session_approval?.status, 'pending');
  assert.equal(metadata.session_approval?.originalContent, GIT_STATUS_BAR_TASK);
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
  setWorkflowOrchestratorGraphDeps({
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

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
  });
  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '确认',
  });
  await waitFor(
    () => workflowAgentCalls.some((call) => call.stage === 'acceptance'),
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

  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assert.deepEqual(
    workflowAgentCalls
      .filter((call) => call.stage !== 'planning')
      .map((call) => `${call.stage}:${call.agentId}`),
    [
      'implementation:backend-executor',
      'implementation:frontend-executor',
      'code_review:reviewer',
      'code_review:reviewer',
      'acceptance:acceptor',
    ],
  );

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  assert.equal(workflowTasks[0]?.title, GIT_STATUS_BAR_TASK);
  assert.match(workflowTasks[0]?.description ?? '', /产品经理方案背景/);

  const workflowRuns = workflowRepo.listByTask(workflowTasks[0]!.id);
  assert.equal(workflowRuns.length, 1);
  assert.equal(typeof workflowRuns[0]?.graph_version, 'string');
  assert.equal(workflowRuns[0]?.approved_by, 'session-risk-gate');

  const agents = roomAgentRepo.listByRoom(workflowTasks[0]!.room_id).map((agent) => agent.agent_id);
  assert.deepEqual(agents, ['planner', 'backend-executor', 'frontend-executor', 'reviewer', 'acceptor']);

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
  setWorkflowOrchestratorGraphDeps({
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

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '帮我修复这个问题',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

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
  setWorkflowOrchestratorGraphDeps({
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
  await waitFor(
    () => workflowAgentCalls.some((call) => call.stage === 'acceptance'),
    1000,
    () => `calls=${JSON.stringify(workflowAgentCalls)}`,
  );

  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);
  assert.deepEqual(
    workflowAgentCalls
      .filter((call) => call.stage !== 'planning')
      .map((call) => `${call.stage}:${call.agentId}`),
    [
      'implementation:frontend-executor',
      'code_review:reviewer',
      'code_review:reviewer',
      'acceptance:acceptor',
    ],
  );

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  const workflowRuns = workflowRepo.listByTask(workflowTasks[0]!.id);
  assert.equal(workflowRuns.length, 1);
  assert.equal(workflowRuns[0]?.approved_by, null);

  const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    session_execution?: {
      executionPath?: string;
      trigger?: string;
      workflowTaskId?: string;
      workflowRunId?: string;
    };
  };
  assert.equal(metadata.session_execution?.executionPath, 'workflow_graph');
  assert.equal(metadata.session_execution?.trigger, 'low_risk_auto');
  assert.equal(metadata.session_execution?.workflowTaskId, workflowTasks[0]?.id);
  assert.equal(metadata.session_execution?.workflowRunId, workflowRuns[0]?.id);
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
  setWorkflowOrchestratorGraphDeps({
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
  await waitFor(
    () => workflowAgentCalls.some((call) => call.stage === 'acceptance'),
    1000,
    () => `calls=${JSON.stringify(workflowAgentCalls)}`,
  );

  assert.equal(plannerPrompts.length, 1);
  assert.deepEqual(
    workflowAgentCalls
      .filter((call) => call.stage !== 'planning')
      .map((call) => `${call.stage}:${call.agentId}`),
    [
      'implementation:frontend-executor',
      'code_review:reviewer',
      'code_review:reviewer',
      'acceptance:acceptor',
    ],
  );

  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  assert.equal(workflowTasks.length, 1);
  assert.equal(workflowTasks[0]?.title, '帮我修复这个问题');
  assert.match(workflowTasks[0]?.description ?? '', /会话页面右侧栏/);

  const workflowRuns = workflowRepo.listByTask(workflowTasks[0]!.id);
  assert.equal(workflowRuns.length, 1);

  const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
  const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
    risk_assessment?: { taskKind?: string; riskLevel?: string };
    session_execution?: {
      executionPath?: string;
      trigger?: string;
      workflowTaskId?: string;
      workflowRunId?: string;
    };
  };
  assert.equal(metadata.risk_assessment?.taskKind, 'frontend_change');
  assert.equal(metadata.risk_assessment?.riskLevel, 'low');
  assert.equal(metadata.session_execution?.executionPath, 'workflow_graph');
  assert.equal(metadata.session_execution?.trigger, 'low_risk_auto');
  assert.equal(metadata.session_execution?.workflowTaskId, workflowTasks[0]?.id);
  assert.equal(metadata.session_execution?.workflowRunId, workflowRuns[0]?.id);
});

test('dispatchSessionUserMessage records low-risk workflow run before background graph planning completes', async () => {
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
  setWorkflowOrchestratorGraphDeps({
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
  await waitFor(() => {
    const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
    if (workflowTasks.length !== 1) return false;
    const workflowRuns = workflowRepo.listByTask(workflowTasks[0]!.id);
    if (workflowRuns.length !== 1) return false;
    const updatedTaskMessage = sessionMessageRepo.get(taskMessage.id);
    const metadata = JSON.parse(updatedTaskMessage?.metadata ?? '{}') as {
      session_execution?: { workflowRunId?: string };
    };
    return metadata.session_execution?.workflowRunId === workflowRuns[0]?.id;
  });

  assert.equal(sessionRunRepo.listBySession(session.id).length, 0);

  const messages = sessionMessageRepo.listBySession(session.id);
  const workflowMessage = messages.find((item) => item.sender_id === 'workflow');
  assert.ok(workflowMessage);
  assert.equal(workflowMessage.message_type, 'system');
  assert.match(workflowMessage.content, /已进入自动工作流/);
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
      sourceMessageId?: string;
    };
  };
  const workflowTasks = taskRepo.listByProject(project.id).filter((task) => task.source_message_id === taskMessage.id);
  const workflowRuns = workflowTasks.flatMap((task) => workflowRepo.listByTask(task.id));
  assert.equal(workflowMessageMetadata.session_workflow?.executionPath, 'workflow_graph');
  assert.equal(workflowMessageMetadata.session_workflow?.trigger, 'low_risk_auto');
  assert.equal(workflowMessageMetadata.session_workflow?.workflowRoomId, workflowTasks[0]?.room_id);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowTaskId, workflowTasks[0]?.id);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowRunId, workflowRuns[0]?.id);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowStatus, workflowRuns[0]?.status);
  assert.equal(workflowMessageMetadata.session_workflow?.workflowStage, workflowRuns[0]?.current_stage);
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

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
  });

  const originalStart = workflowOrchestrator.start;
  const originalApprovePlan = workflowOrchestrator.approvePlan;
  let approveCalls = 0;
  workflowOrchestrator.start = async (taskId) => {
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
    workflowOrchestrator.start = originalStart;
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

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
  });

  const originalStart = workflowOrchestrator.start;
  workflowOrchestrator.start = async () => {
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
    workflowOrchestrator.start = originalStart;
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

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
  });

  const originalStart = workflowOrchestrator.start;
  const originalApprovePlan = workflowOrchestrator.approvePlan;
  let workflowRunId: string | undefined;
  let approveStarted = false;
  let releaseApprove: (() => void) | undefined;
  workflowOrchestrator.start = async (taskId) => {
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
    workflowOrchestrator.start = originalStart;
    workflowOrchestrator.approvePlan = originalApprovePlan;
  }
});

test('dispatchSessionUserMessage gates high-risk referenced files for edit requests', async () => {
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

  const updatedMessage = sessionMessageRepo.get(message.id);
  const metadata = JSON.parse(updatedMessage?.metadata ?? '{}') as {
    risk_assessment?: { riskLevel?: string; approvalReason?: string; scopeWrite?: string[] };
    approval_card?: { riskLevel?: string; scopeWrite?: string[] };
  };
  assert.equal(metadata.risk_assessment?.riskLevel, 'high');
  assert.equal(metadata.risk_assessment?.approvalReason, 'dependency/root config changes require approval');
  assert.deepEqual(metadata.risk_assessment?.scopeWrite, ['package.json']);
  assert.deepEqual(metadata.approval_card?.scopeWrite, ['package.json']);
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

  const taskMessage = await dispatchSessionUserMessage({
    sessionId: session.id,
    content: GIT_STATUS_BAR_TASK,
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

test('dispatchSessionUserMessage prepends global session prompt before context and user request', async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 30));

  const prompt = prompts[0] ?? '';
  assert.equal(message.content, '分析当前状态');
  assert.ok(prompt.startsWith('## Global Session Instruction\n全局规则：先遵循系统设置注入。'));
  assert.ok(
    prompt.indexOf('## Global Session Instruction') <
      prompt.indexOf('本轮 prompt 来源由 SessionOS Context Inspector 记录。'),
  );
  assert.ok(
    prompt.indexOf('本轮 prompt 来源由 SessionOS Context Inspector 记录。') <
      prompt.indexOf('当前目标：完成会话提示词验收'),
  );
  assert.ok(prompt.indexOf('当前目标：完成会话提示词验收') < prompt.indexOf('## User Request'));
  assert.ok(prompt.includes('## User Request\n\n分析当前状态'));
  assert.ok(prompt.indexOf('## User Request\n\n分析当前状态') < prompt.indexOf('<opendeepsea-session-tools>'));
});

test('dispatchSessionUserMessage injects knowledge tool prompt into runtime prompt', async () => {
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

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '查询项目知识库里的验收记录',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const prompt = prompts[0] ?? '';
  assert.match(prompt, /OpenDeepSea 知识库工具/);
  assert.ok(prompt.includes(`npm run openclaw:knowledge -- search --project ${project.id} --query`));
  assert.match(prompt, /citation key/);
});

test('dispatchSessionUserMessage omits global session prompt block when setting is empty', async () => {
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

  await dispatchSessionUserMessage({ sessionId: session.id, content: '保持现有 prompt' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.doesNotMatch(prompts[0] ?? '', /## Global Session Instruction/);
  assert.match(prompts[0] ?? '', /## User Request\n\n保持现有 prompt/);
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

test('dispatchSessionUserMessage injects referenced file context into runtime prompt', async () => {
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

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析引用',
    workspaceFileRefs: ['src/app.ts'],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.match(prompts[0] ?? '', /## Referenced Files/);
  assert.match(prompts[0] ?? '', /Source: src\/app\.ts/);
  assert.match(prompts[0] ?? '', /export const app = true/);
});

test('dispatchSessionUserMessage injects uploaded text content and image project files into runtime context', async () => {
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

  await dispatchSessionUserMessage({
    sessionId: session.id,
    content: '分析粘贴附件',
    libraryFileRefs: [textFile.id, imageFile.id],
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.match(captured[0]?.prompt ?? '', /Library: notes\.md/);
  assert.match(captured[0]?.prompt ?? '', /请读取这段内容/);
  assert.match(captured[0]?.prompt ?? '', /Library Metadata: screen\.png/);
  assert.deepEqual(captured[0]?.imagePaths, [realpathSync(imagePath)]);
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000, describe?: () => string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for condition${describe ? `: ${describe()}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    return [
      'implementation completed',
      '',
      '```json',
      JSON.stringify({
        superpowers: {
          tddEvidence: [
            { stage: 'RED', command: 'node --test session-dispatch', passed: false, summary: 'failed as expected' },
            { stage: 'GREEN', command: 'node --test session-dispatch', passed: true, summary: 'passed' },
          ],
        },
      }),
      '```',
    ].join('\n');
  }
  return `${stage ?? 'workflow'} completed`;
}
