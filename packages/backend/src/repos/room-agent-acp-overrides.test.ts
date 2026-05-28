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
