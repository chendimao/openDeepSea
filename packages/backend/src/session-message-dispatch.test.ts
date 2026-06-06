import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-dispatch-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { fileRepo } = await import('./repos/files.js');
const { settingsRepo } = await import('./repos/settings.js');
const { sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { dispatchSessionUserMessage } = await import('./session-message-dispatch.js');
const { setSessionRuntimeAdapterForTest } = await import('./session-runtime.js');

afterEach(() => {
  setSessionRuntimeAdapterForTest(undefined);
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
