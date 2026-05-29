import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-acp-overrides-')), 'test.db');

const { agentRepo } = await import('./agents.js');
const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');

test('listByRoom preserves manually selected ACP backend on built-in planner', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-planner-acp-project-'));
  const project = projectRepo.create({ name: 'Planner ACP Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Planner ACP Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);

  const roomAgent = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: planner.id,
  });
  assert.equal(roomAgent.acp_backend, 'codex');

  const saved = roomAgentRepo.setAcp(roomAgent.id, {
    acp_enabled: true,
    acp_backend: 'claudecode',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  assert.equal(saved?.acp_backend, 'claudecode');

  const refreshed = roomAgentRepo.listByRoom(room.id).find((agent) => agent.id === roomAgent.id);
  assert.equal(refreshed?.acp_backend, 'claudecode');
  assert.equal(refreshed?.acp_permission_mode, 'read-only');
});

test('applyBuiltInTemplate upgrades legacy default ACP backend to template backend', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-legacy-acp-project-'));
  const project = projectRepo.create({ name: 'Legacy ACP Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Legacy ACP Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);

  const roomAgent = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: planner.id,
  });
  assert.equal(roomAgent.acp_backend, 'codex');

  roomAgentRepo.setAcp(roomAgent.id, {
    acp_enabled: true,
    acp_backend: 'claudecode',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(roomAgent.id, {
    capabilities: roomAgent.capabilities,
    default_runtime: roomAgent.default_runtime,
    runtime_backend: roomAgent.runtime_backend,
    tool_policy: roomAgent.tool_policy,
    workspace_policy: roomAgent.workspace_policy,
    memory_scope: roomAgent.memory_scope,
    runtime_profile_version: 0,
  });

  const migrated = roomAgentRepo.applyBuiltInTemplate(roomAgent.id, 'planner');

  assert.equal(migrated?.acp_enabled, 1);
  assert.equal(migrated?.acp_backend, 'codex');
  assert.equal(migrated?.acp_permission_mode, 'read-only');
});
