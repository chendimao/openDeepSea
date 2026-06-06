import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import type { WebSocket } from 'ws';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-session-socket-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { fileRepo } = await import('./repos/files.js');
const { historyRecordRepo } = await import('./repos/history-records.js');
const { sessionCheckpointRepo } = await import('./repos/session-checkpoints.js');
const { sessionCompactionRepo } = await import('./repos/session-compactions.js');
const { sessionContextRepo } = await import('./repos/session-context.js');
const { sessionEvidenceRepo } = await import('./repos/session-evidence.js');
const { sessionRepo, sessionMessageRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');
const { handleSessionSocketEvent } = await import('./session-socket-controller.js');

afterEach(() => setSessionRuntimeAdapterForTest(undefined));

function createSocket() {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;
  return { socket, sent };
}

async function waitFor(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(assertion(), true);
}

test('websocket message send starts planner run and sends no HTTP response object', async () => {
  const project = projectRepo.create({
    name: 'socket message project',
    path: mkdtempSync(join(tmpdir(), 'socket-message-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Socket Message',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const seenPrompts: string[] = [];
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async ({ prompt, onSession }) => {
      seenPrompts.push(prompt);
      onSession?.('socket-acp');
      return { exitCode: 0, sessionId: 'socket-acp', stderr: '' };
    },
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.message.send',
    sessionId: session.id,
    content: '继续实现',
    agentId: 'planner',
  });

  await waitFor(() => sessionRunRepo.listBySession(session.id).length === 1);
  const run = sessionRunRepo.listBySession(session.id)[0]!;
  assert.equal(run.agent_id, 'planner');
  assert.match(seenPrompts[0] ?? '', /继续实现/);
  assert.equal(sent.some((payload) => JSON.parse(payload).type === 'session_error'), false);
});

test('websocket message send stores normalized file refs in message metadata', async () => {
  const project = projectRepo.create({
    name: 'socket message file refs project',
    path: mkdtempSync(join(tmpdir(), 'socket-message-file-refs-')),
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
    title: 'Socket Message File Refs',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'socket-acp', stderr: '' }),
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.message.send',
    sessionId: session.id,
    content: '结合这些文件分析',
    workspaceFileRefs: [' ./src/../src/app.ts ', 'src/app.ts'],
    libraryFileRefs: [libraryFile.id, libraryFile.id],
  });

  await waitFor(() => sessionMessageRepo.listBySession(session.id).length === 1);
  const [message] = sessionMessageRepo.listBySession(session.id);
  const metadata = JSON.parse(message?.metadata ?? '{}') as {
    workspace_file_refs?: string[];
    library_file_refs?: string[];
  };
  assert.deepEqual(metadata.workspace_file_refs, ['src/app.ts']);
  assert.deepEqual(metadata.library_file_refs, [libraryFile.id]);
  assert.equal(sent.some((payload) => JSON.parse(payload).type === 'session_error'), false);
});

test('websocket message send rejects foreign library refs without creating a message', async () => {
  const project = projectRepo.create({
    name: 'socket reject file refs project',
    path: mkdtempSync(join(tmpdir(), 'socket-reject-file-refs-')),
  });
  const otherProject = projectRepo.create({
    name: 'socket foreign library project',
    path: mkdtempSync(join(tmpdir(), 'socket-foreign-library-')),
  });
  const foreignFile = fileRepo.createAgentDocument({
    project_id: otherProject.id,
    title: 'foreign.md',
    content: '其它项目的资料',
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Socket Reject File Refs',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  setSessionRuntimeAdapterForTest({
    backend: 'codex',
    listSessions: async () => [],
    invoke: async () => ({ exitCode: 0, sessionId: 'socket-acp', stderr: '' }),
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.message.send',
    sessionId: session.id,
    content: '不要创建这条消息',
    libraryFileRefs: [foreignFile.id],
  });

  await waitFor(() => (
    sent.some((payload) => JSON.parse(payload).type === 'session_error') ||
    sessionMessageRepo.listBySession(session.id).length > 0
  ));
  assert.equal(sessionMessageRepo.listBySession(session.id).length, 0);
  const error = sent.map((payload) => JSON.parse(payload)).find((event) => event.type === 'session_error');
  assert.match(error?.error ?? '', /library file reference is not available/);
});

test('websocket workspace request returns a session workspace snapshot event', () => {
  const project = projectRepo.create({
    name: 'socket snapshot project',
    path: mkdtempSync(join(tmpdir(), 'socket-snapshot-project-')),
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.workspace.request',
    projectId: project.id,
  });

  const event = JSON.parse(sent[0]!);
  assert.equal(event.type, 'session_workspace:snapshot');
  assert.equal(event.payload.project.id, project.id);
  assert.equal(event.payload.activeSession.session.project_id, project.id);
});

test('websocket workspace request marks the focused session as viewed before returning active summaries', () => {
  const project = projectRepo.create({
    name: 'socket viewed project',
    path: mkdtempSync(join(tmpdir(), 'socket-viewed-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Viewed Snapshot',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionRepo.update(session.id, { last_viewed_at: 1 });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'assistant',
    sender_id: 'planner',
    content: '已经有新的消息',
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'status',
    title: '新证据',
    summary: '有新的证据事件',
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.workspace.request',
    projectId: project.id,
    sessionId: session.id,
  });

  const event = JSON.parse(sent[0]!);
  const viewed = sessionRepo.get(session.id);
  const activeSummary = event.payload.activeSessions.find((item: { id: string }) => item.id === session.id);
  assert.equal(event.type, 'session_workspace:snapshot');
  assert.ok((viewed?.last_viewed_at ?? 0) > 1);
  assert.equal(activeSummary?.unread_count, 0);
});

test('websocket pause marks the active run as paused instead of cancelled', () => {
  const project = projectRepo.create({
    name: 'socket pause project',
    path: mkdtempSync(join(tmpdir(), 'socket-pause-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Socket Pause',
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
  });
  const { socket } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'agent.run.pause',
    sessionId: session.id,
    agentId: 'planner',
    runId: run.id,
  });

  assert.equal(sessionRunRepo.get(run.id)?.status, 'paused');
});

test('websocket run controls reject mismatched session or agent ids', () => {
  const project = projectRepo.create({
    name: 'socket ownership project',
    path: mkdtempSync(join(tmpdir(), 'socket-ownership-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Socket Ownership',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const otherSession = sessionRepo.create({
    project_id: project.id,
    title: 'Other Socket Ownership',
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
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'agent.run.cancel',
    sessionId: otherSession.id,
    agentId: 'planner',
    runId: run.id,
  });
  handleSessionSocketEvent(socket, {
    type: 'agent.run.cancel',
    sessionId: session.id,
    agentId: 'reviewer',
    runId: run.id,
  });

  assert.equal(sessionRunRepo.get(run.id)?.status, 'running');
  assert.equal(sent.map((payload) => JSON.parse(payload).type).filter((type) => type === 'session_error').length, 2);
});

test('websocket command new returns a fresh workspace snapshot', () => {
  const project = projectRepo.create({
    name: 'socket new command project',
    path: mkdtempSync(join(tmpdir(), 'socket-new-command-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Old Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.command.run',
    sessionId: session.id,
    command: '/new',
  });

  const event = JSON.parse(sent.at(-1)!);
  assert.equal(event.type, 'session_workspace:snapshot');
  assert.notEqual(event.payload.activeSession.session.id, session.id);
  assert.equal(historyRecordRepo.getBySession(session.id), undefined);
  assert.equal(sessionRepo.get(session.id)?.closed_at, null);
  assert.equal(sessionEvidenceRepo.listBySession(event.payload.activeSession.session.id).at(-1)?.event_type, 'new');
});

test('websocket command status sends a status snapshot event', () => {
  const project = projectRepo.create({
    name: 'socket status command project',
    path: mkdtempSync(join(tmpdir(), 'socket-status-command-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Status Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.command.run',
    sessionId: session.id,
    command: '/status',
  });

  const event = JSON.parse(sent.at(-1)!);
  assert.equal(event.type, 'session_status:snapshot');
  assert.equal(event.sessionId, session.id);
});

test('websocket command new title names a fresh session without archiving current session', () => {
  const project = projectRepo.create({
    name: 'socket titled new command project',
    path: mkdtempSync(join(tmpdir(), 'socket-titled-new-command-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Archive Session',
    current_goal: '完成 WebSocket-only 会话',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '修复发送消息',
  });
  sessionEvidenceRepo.create({
    session_id: session.id,
    event_type: 'file_diff',
    title: 'Updated file',
    payload: { path: 'packages/frontend/src/pages/SessionWorkspacePage.tsx' },
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.command.run',
    sessionId: session.id,
    command: '/new title: WebSocket 新会话',
  });

  const event = JSON.parse(sent.at(-1)!);
  assert.equal(event.type, 'session_workspace:snapshot');
  assert.equal(event.payload.activeSession.session.title, 'WebSocket 新会话');
  assert.notEqual(event.payload.activeSession.session.id, session.id);
  assert.equal(historyRecordRepo.getBySession(session.id), undefined);
  assert.equal(sessionRepo.get(session.id)?.closed_at, null);
});

test('websocket fork from history inherits resume brief context and increments fork count', () => {
  const project = projectRepo.create({
    name: 'socket history fork project',
    path: mkdtempSync(join(tmpdir(), 'socket-history-fork-')),
  });
  const source = sessionRepo.create({
    project_id: project.id,
    title: 'Source Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const record = historyRecordRepo.create({
    project_id: project.id,
    session_id: source.id,
    title: '历史任务',
    summary: '已完成主要实现',
    status: 'archived',
    mode: 'code',
    started_at: source.created_at,
    ended_at: Date.now(),
    key_decisions: [],
    changed_files: [],
    verification_summary: null,
    commit_refs: [],
    resume_brief: '目标：继续历史任务\n最近验证：build passed',
    compact_count: 0,
  });
  const { socket, sent } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.command.run',
    sessionId: source.id,
    command: `/fork history:${record.id}`,
  });

  const event = JSON.parse(sent.at(-1)!);
  const forkSessionId = event.payload.activeSession.session.id;
  assert.equal(historyRecordRepo.get(record.id)?.fork_count, 1);
  assert.equal(sessionContextRepo.getLatestBySession(forkSessionId)?.sources[0]?.source_type, 'history');
  assert.equal(sessionEvidenceRepo.listBySession(forkSessionId).at(-1)?.event_type, 'fork');
});

test('websocket checkpoint command creates checkpoint through websocket path', async () => {
  const project = projectRepo.create({
    name: 'socket checkpoint project',
    path: mkdtempSync(join(tmpdir(), 'socket-checkpoint-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Checkpoint Session',
    mode: 'code',
    provider: 'codex',
    workspace_path: project.path,
  });
  const { socket } = createSocket();

  handleSessionSocketEvent(socket, {
    type: 'session.command.run',
    sessionId: session.id,
    command: '/checkpoint 保存当前状态',
  });

  await waitFor(() => sessionCheckpointRepo.listBySession(session.id).length === 1);
  assert.equal(sessionCheckpointRepo.listBySession(session.id)[0]?.title, '保存当前状态');
  assert.equal(sessionEvidenceRepo.listBySession(session.id).at(-1)?.event_type, 'checkpoint');
});
