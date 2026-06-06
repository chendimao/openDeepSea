import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-dispatch-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
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

  dispatchSessionUserMessage({ sessionId: session.id, content: '分析当前项目' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const [run] = sessionRunRepo.listBySession(session.id);
  assert.equal(run?.agent_id, 'planner');
  assert.equal(run?.provider, 'opencode');
  assert.match(run?.runtime_profile_snapshot ?? '', /"backend_source":"project"/);
});
