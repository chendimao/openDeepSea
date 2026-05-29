import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-session-handoff-')), 'test.db');

const { agentRepo } = await import('./agents.js');
const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');

test('roomAgentRepo stores pending ACP session handoff state', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-handoff-state-project-'));
  const project = projectRepo.create({ name: 'Handoff State Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Handoff State Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);

  const roomAgent = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: planner.id,
  });
  roomAgentRepo.setAcp(roomAgent.id, {
    acp_enabled: true,
    acp_backend: 'claudecode',
    acp_session_id: 'old-session',
    acp_session_label: null,
    acp_permission_mode: 'read-only',
    acp_writable_dirs: [],
  });

  const pending = roomAgentRepo.setAcpSessionHandoffPending(
    roomAgent.id,
    true,
    'automatic_rotation_after_events',
  );

  assert.equal(pending?.acp_session_handoff_pending, 1);
  assert.equal(pending?.acp_session_handoff_reason, 'automatic_rotation_after_events');

  const cleared = roomAgentRepo.setAcpSessionHandoffPending(roomAgent.id, false, null);

  assert.equal(cleared?.acp_session_handoff_pending, 0);
  assert.equal(cleared?.acp_session_handoff_reason, null);
});
