import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { workflowArtifactVersionRepo, workflowRepo } = await import('./repos/workflows.js');
const { fileRepo } = await import('./repos/files.js');
const { sessionRepo, sessionMessageRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { emptyAgentWorkflowState, parseGraphState, serializeGraphState } = await import('./workflows/graph/state.js');
const { setWorkflowOrchestratorGraphDeps, workflowOrchestrator } = await import('./workflows/orchestrator.js');
const { router } = await import('./routes.js');
const { buildWorkspacePayload } = await import('./session.routes.js');
const express = (await import('express')).default;

const capturedPrompts: string[] = [];
const app = express();
app.use(express.json());
app.use('/api', router);

setSessionRuntimeAdapterForTest({
  backend: 'codex',
  listSessions: async () => [],
  invoke: async ({ prompt, onChunk, onSession }) => {
    capturedPrompts.push(prompt);
    onSession?.('route-test-acp-session');
    onChunk({ stream: 'stdout', channel: 'answer', text: 'ok' });
    return { exitCode: 0, sessionId: 'route-test-acp-session', stderr: '' };
  },
});

test('legacy HTTP session workspace route is removed', async () => {
  const project = projectRepo.create({
    name: 'removed workspace route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-workspace-route-')),
  });

  const res = await request(`/api/projects/${project.id}/session-workspace`);

  assert.equal(res.status, 404);
});

test('legacy HTTP session message route is removed', async () => {
  const project = projectRepo.create({
    name: 'removed message route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-message-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Message Route',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const res = await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'should not work over http' }),
  });

  assert.equal(res.status, 404);
});

test('legacy HTTP session run control routes are removed', async () => {
  const project = projectRepo.create({
    name: 'removed run route project',
    path: mkdtempSync(join(tmpdir(), 'removed-session-run-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Run Route',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const run = sessionRunRepo.create({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    mode: 'code',
    status: 'running',
    prompt: 'long task',
    acp_session_id: 'removed-acp',
  });

  for (const suffix of ['cancel', 'retry', 'pause', 'resume']) {
    const res = await request(`/api/session-runs/${run.id}/${suffix}`, { method: 'POST' });
    assert.equal(res.status, 404);
  }
});

test('legacy HTTP session command routes are removed', async () => {
  const project = projectRepo.create({
    name: 'removed command route project',
    path: mkdtempSync(join(tmpdir(), 'removed-command-route-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Removed Commands',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  for (const path of [
    `/api/projects/${project.id}/session-workspace`,
    `/api/sessions/${session.id}/new`,
    `/api/sessions/${session.id}/compact/preview`,
    `/api/sessions/${session.id}/compact/apply`,
    `/api/sessions/${session.id}/compact/discard`,
    `/api/sessions/${session.id}/contract`,
    `/api/sessions/${session.id}/status`,
    `/api/sessions/${session.id}/context`,
    `/api/sessions/${session.id}/evidence`,
    `/api/sessions/${session.id}/checkpoints`,
    `/api/sessions/${session.id}/fork`,
    `/api/projects/${project.id}/history-records`,
  ]) {
    const method = path.includes('/session-workspace') ||
      path.endsWith('/status') ||
      path.endsWith('/context') ||
      path.endsWith('/evidence') ||
      path.endsWith('/history-records')
      ? 'GET'
      : path.endsWith('/contract')
        ? 'PATCH'
        : 'POST';
    const res = await request(path, { method });
    assert.equal(res.status, 404);
  }
});

test('session PATCH updates pinned_at for active session ordering', async () => {
  const project = projectRepo.create({
    name: 'session pin patch project',
    path: mkdtempSync(join(tmpdir(), 'session-pin-patch-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Pin Me',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });

  const pinnedAt = Date.now();
  const pinRes = await request(`/api/sessions/${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned_at: pinnedAt }),
  });

  assert.equal(pinRes.status, 200);
  const pinned = await pinRes.json() as { pinned_at: number | null };
  assert.equal(pinned.pinned_at, pinnedAt);
  assert.equal(sessionRepo.get(session.id)?.pinned_at, pinnedAt);

  const unpinRes = await request(`/api/sessions/${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned_at: null }),
  });

  assert.equal(unpinRes.status, 200);
  const unpinned = await unpinRes.json() as { pinned_at: number | null };
  assert.equal(unpinned.pinned_at, null);
  assert.equal(sessionRepo.get(session.id)?.pinned_at, null);
});

test('session todo stats endpoint returns open plan item counts from inspector plan updates', async () => {
  const project = projectRepo.create({
    name: 'todo stats project',
    path: mkdtempSync(join(tmpdir(), 'session-todo-stats-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Todo Stats',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: '计划更新',
    payload: {
      event: {
        type: 'plan_update',
        payload: {
          entries: [
            { id: 'read-context', title: '读取上下文', status: 'completed' },
            { id: 'wire-api', title: '接入统计 API', status: 'in_progress' },
            { id: 'render-badge', title: '渲染标题徽标', status: 'pending' },
            { id: 'blocked-review', title: '等待评审', status: 'blocked' },
            { id: 'retry-style', title: '修复样式回归', status: 'failed' },
            { id: 'skip-extra', title: '跳过扩展筛选', status: 'skipped' },
          ],
        },
      },
    },
  });

  const res = await request(`/api/sessions/${session.id}/todo-stats`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    sessionId: session.id,
    total: 6,
    open: 4,
    pending: 1,
    inProgress: 1,
    blocked: 1,
    failed: 1,
    completed: 1,
    skipped: 1,
  });
});

test('session todo stats endpoint returns 404 for missing sessions', async () => {
  const res = await request('/api/sessions/missing-session/todo-stats');

  assert.equal(res.status, 404);
});

test('session workspace payload backfills attachments from legacy library file refs', () => {
  const project = projectRepo.create({
    name: 'legacy attachment refs project',
    path: mkdtempSync(join(tmpdir(), 'legacy-session-attachment-refs-')),
  });
  const uploadedFile = fileRepo.create({
    project_id: project.id,
    original_name: 'screen.png',
    stored_name: 'stored-screen.png',
    mime_type: 'image/png',
    size: 2048,
    url: `/uploads/files/${project.id}/stored-screen.png`,
    storage_path: join(project.path, 'stored-screen.png'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Legacy Attachment Refs',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '分析内容',
    metadata: {
      target_agent_id: 'planner',
      library_file_refs: [uploadedFile.id],
    },
  });

  const payload = buildWorkspacePayload(project, session);
  const [message] = payload.activeSession.messages;
  assert.ok(message?.metadata);
  const metadata = JSON.parse(message.metadata) as {
    attachments?: Array<{ fileId: string; name: string; url: string; isImage: boolean }>;
  };
  assert.deepEqual(metadata.attachments, [{
    id: uploadedFile.id,
    fileId: uploadedFile.id,
    name: 'screen.png',
    mimeType: 'image/png',
    size: 2048,
    url: `/uploads/files/${project.id}/stored-screen.png`,
    isImage: true,
    deleted: false,
  }]);
  const storedMessage = sessionMessageRepo.get(message.id);
  assert.ok(storedMessage?.metadata);
  assert.deepEqual(JSON.parse(storedMessage.metadata).attachments, metadata.attachments);
});

test('session workspace payload exposes workflow artifact versions and approval gate', () => {
  const project = projectRepo.create({
    name: 'artifact project',
    path: mkdtempSync(join(tmpdir(), 'session-artifacts-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Artifact Room' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Artifact Session',
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
    title: 'Artifact workflow',
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
    graph_version: 'superpowers-v2',
    graph_state: serializeGraphState({
      ...state,
      status: 'awaiting_approval',
      activeSuperpowersStage: 'writing_plans',
    }),
  });
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...state,
    workflowRunId: workflow.id,
    status: 'awaiting_approval',
    activeSuperpowersStage: 'writing_plans',
  }));
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });

  const payload = buildWorkspacePayload(project, session);

  assert.equal(payload.activeSession.workflowArtifacts?.[0]?.id, draft.id);
  assert.deepEqual(payload.activeSession.workflowArtifacts?.[0]?.structured_data, { tasks: [] });
  assert.equal(payload.activeSession.workflowGates?.some((gate) => gate.kind === 'plan_confirm'), true);
});

test('session workspace payload exposes workflow controller and agent assignments', () => {
  const project = projectRepo.create({
    name: 'assignment payload project',
    path: mkdtempSync(join(tmpdir(), 'session-assignment-payload-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Assignment Payload Room' });
  const fullstack = roomAgentRepo.ensureBuiltInAgent(room.id, 'fullstack-engineer');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Assignment Payload Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '实现 workflow assignment payload',
    metadata: {},
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Assignment workflow',
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
    status: 'running',
    current_stage: 'assignment',
    approval_required: false,
    graph_version: 'superpowers-v2',
    graph_state: serializeGraphState(state),
  });
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...state,
    workflowRunId: workflow.id,
    currentNode: 'agent_assignment',
    selectedIntent: 'standard_development',
    activeSuperpowersStage: 'agent_assignment',
    plan: {
      goal: '实现 workflow assignment payload',
      summary: '实现 workflow assignment payload',
      assumptions: [],
      tasks: [{
        title: '实现 assignment payload',
        description: '后端暴露 workflow assignment',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['payload 包含 assignment'],
        scopeRead: ['packages/backend/src/session.routes.ts'],
        scopeWrite: ['packages/backend/src/session.routes.ts'],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: ['node --import tsx --test packages/backend/src/session.routes.test.ts'],
      verificationCommands: [{
        command: 'node --import tsx --test packages/backend/src/session.routes.test.ts',
        reason: 'session payload regression',
        required: true,
      }],
      risks: [],
      needsApproval: true,
    },
    agentAssignments: [{
      taskId: 'task-1',
      assignedAgentId: fullstack.agent_id,
      fallbackAgentIds: [fullstack.agent_id],
      fallbackReason: '未找到更匹配的专门子代理，使用全栈工程师兜底执行',
      executionMode: 'parallel',
      scopeRead: ['packages/backend/src/session.routes.ts'],
      scopeWrite: ['packages/backend/src/session.routes.ts'],
    }],
  }));

  const payload = buildWorkspacePayload(project, session);

  assert.equal(payload.activeSession.workflowController?.workflow_run_id, workflow.id);
  assert.equal(payload.activeSession.workflowController?.selected_intent, 'standard_development');
  assert.equal(payload.activeSession.workflowController?.active_stage, 'agent_assignment');
  assert.equal(payload.activeSession.workflowController?.controller, 'planner');
  assert.equal(payload.activeSession.workflowController?.next_action, '生成并冻结子任务执行智能体分配。');
  assert.deepEqual(payload.activeSession.workflowAgentAssignments, [{
    task_id: 'task-1',
    task_title: '实现 assignment payload',
    role: 'executor',
    assigned_agent_id: 'fullstack-engineer',
    assigned_agent_name: '全栈工程师',
    backend: fullstack.acp_backend,
    fallback_reason: '未找到更匹配的专门子代理，使用全栈工程师兜底执行',
    execution_mode: 'parallel',
    scope_write: ['packages/backend/src/session.routes.ts'],
  }]);
});

test('session workflow artifact approve endpoint approves linked artifact and updates graph state', async () => {
  const project = projectRepo.create({
    name: 'artifact approve project',
    path: mkdtempSync(join(tmpdir(), 'session-artifact-approve-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Artifact Approve Room' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Artifact Approve Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '确认 plan',
    metadata: {},
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Artifact approve workflow',
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
    graph_version: 'superpowers-v2',
    graph_state: serializeGraphState(state),
  });
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...state,
    workflowRunId: workflow.id,
    draftPlanArtifactVersionId: draft.id,
    activeSuperpowersStage: 'writing_plans',
  }));

  const res = await request(`/api/sessions/${session.id}/workflow-artifacts/${draft.id}/approve`, {
    method: 'POST',
  });

  assert.equal(res.status, 200);
  const approved = await res.json() as { id: string; status: string; structured_data: unknown };
  assert.equal(approved.id, draft.id);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.structured_data, { tasks: [] });
  const graphState = parseGraphState(workflowRepo.getRun(workflow.id)?.graph_state ?? null);
  assert.equal(graphState?.approvedPlanArtifactVersionId, draft.id);
  assert.equal(graphState?.draftPlanArtifactVersionId, null);
  assert.equal(workflowRepo.getRun(workflow.id)?.status, 'running');
  const payload = buildWorkspacePayload(project, session);
  assert.equal(payload.activeSession.workflowArtifacts?.find((item) => item.id === draft.id)?.status, 'approved');
  const approvedPlanGate = payload.activeSession.workflowGates?.find((gate) => gate.artifact_version_id === draft.id);
  assert.equal(approvedPlanGate?.kind, 'plan_confirm');
  assert.equal(approvedPlanGate?.status, 'approved');
});

test('session workflow artifact approve endpoint resumes blocked workflow after plan approval', async () => {
  const project = projectRepo.create({
    name: 'artifact approve resume project',
    path: mkdtempSync(join(tmpdir(), 'session-artifact-approve-resume-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Artifact Approve Resume Room' });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Artifact Approve Resume Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    sender_name: null,
    content: '确认 plan 后继续执行',
    metadata: {},
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Artifact approve resume workflow',
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
  const workflowSeed = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'blocked',
    current_stage: 'planning',
    approval_required: true,
    graph_version: 'superpowers-v2',
    graph_state: serializeGraphState(state),
  });
  const workflow = workflowRepo.updateRun(workflowSeed.id, {
    status: 'blocked',
    error: 'Superpowers dispatch requires approved plan artifact version',
  }) ?? workflowSeed;
  const draft = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan',
    structured_data: { tasks: [] },
    created_by_agent_id: 'planner',
  });
  workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...state,
    workflowRunId: workflow.id,
    currentNode: 'dispatch',
    draftPlanArtifactVersionId: draft.id,
    implementationPlanPath: 'docs/superpowers/plans/test.md',
    planReviewVerdict: 'approved',
    activeSuperpowersStage: 'plan_review',
    status: 'blocked',
    error: 'Superpowers dispatch requires approved plan artifact version',
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
    const res = await request(`/api/sessions/${session.id}/workflow-artifacts/${draft.id}/approve`, {
      method: 'POST',
    });

    assert.equal(res.status, 200);
    assert.deepEqual(enqueued, [workflow.id]);
    const updatedRun = workflowRepo.getRun(workflow.id);
    assert.equal(updatedRun?.status, 'running');
    assert.equal(updatedRun?.error, null);
    const graphState = parseGraphState(updatedRun?.graph_state ?? null);
    assert.equal(graphState?.approvedPlanArtifactVersionId, draft.id);
    assert.equal(graphState?.status, 'running');
    assert.equal(graphState?.error, null);
  } finally {
    workflowOrchestrator.enqueueExistingGraphRun = originalEnqueue;
    setWorkflowOrchestratorGraphDeps({});
  }
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
