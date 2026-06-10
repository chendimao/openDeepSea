import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-planner-runtime-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { agentRepo } = await import('./repos/agents.js');
const { settingsRepo } = await import('./repos/settings.js');
const { buildSessionPlannerRuntimeSnapshot, resolveSessionPlannerRuntime } = await import('./session-planner-runtime.js');

test('resolveSessionPlannerRuntime inherits built-in planner backend and profile', () => {
  const project = projectRepo.create({
    name: 'Planner Runtime Inherit',
    path: mkdtempSync(join(tmpdir(), 'session-planner-runtime-inherit-')),
  });
  const planner = agentRepo.getByBuiltinKey('planner') ?? agentRepo.getByAgentId('planner');
  assert.ok(planner);

  const runtime = resolveSessionPlannerRuntime(project.id);

  assert.equal(runtime.agent.id, planner.id);
  assert.equal(runtime.agentId, 'planner');
  assert.equal(runtime.backend, planner.default_acp_backend);
  assert.equal(runtime.backendSource, 'builtin');
  assert.equal(runtime.projectOverrideBackend, null);
  assert.equal(runtime.permissionMode, planner.default_acp_permission_mode);
  assert.equal(runtime.runtimeBackend, planner.default_runtime_backend);
  assert.deepEqual(runtime.toolPolicy, planner.default_tool_policy);
  assert.deepEqual(runtime.workspacePolicy, planner.default_workspace_policy);
  assert.equal(runtime.memoryScope, planner.default_memory_scope);
});

test('resolveSessionPlannerRuntime gives the session planner workspace write permission', () => {
  const project = projectRepo.create({
    name: 'Planner Runtime Workspace Write',
    path: mkdtempSync(join(tmpdir(), 'session-planner-runtime-write-')),
  });

  const runtime = resolveSessionPlannerRuntime(project.id);

  assert.equal(runtime.permissionMode, 'workspace-write');
  assert.ok(runtime.workspacePolicy.write.includes('.'));
});

test('resolveSessionPlannerRuntime prefers project backend override', () => {
  const project = projectRepo.create({
    name: 'Planner Runtime Override',
    path: mkdtempSync(join(tmpdir(), 'session-planner-runtime-override-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });

  const runtime = resolveSessionPlannerRuntime(project.id);

  assert.equal(runtime.backend, 'opencode');
  assert.equal(runtime.backendSource, 'project');
  assert.equal(runtime.projectOverrideBackend, 'opencode');
});

test('resolveSessionPlannerRuntime builds a stable runtime snapshot', () => {
  const project = projectRepo.create({
    name: 'Planner Runtime Snapshot',
    path: mkdtempSync(join(tmpdir(), 'session-planner-runtime-snapshot-')),
  });
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'claudecode' });

  const runtime = resolveSessionPlannerRuntime(project.id);
  const snapshot = JSON.parse(buildSessionPlannerRuntimeSnapshot(runtime)) as Record<string, unknown>;

  assert.equal(snapshot.agent_id, 'planner');
  assert.equal(snapshot.agent_global_id, runtime.agent.id);
  assert.equal(snapshot.backend, 'claudecode');
  assert.equal(snapshot.backend_source, 'project');
  assert.deepEqual(snapshot.tool_policy, runtime.toolPolicy);
  assert.deepEqual(snapshot.workspace_policy, runtime.workspacePolicy);
});

test('resolveSessionPlannerRuntime throws when project is missing', () => {
  assert.throws(() => resolveSessionPlannerRuntime('missing-project'), /project not found/);
});
