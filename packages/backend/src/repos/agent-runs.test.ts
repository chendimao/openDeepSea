import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-')), 'test.db');

const { agentRunRepo } = await import('./agent-runs.js');
const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');

test('agentRunRepo persists superpowers bootstrap evidence', () => {
  const project = projectRepo.create({
    name: `agent-runs-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner-test', agent_name: 'Planner' });

  const run = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: 'planner',
    backend: 'codex',
    prompt: 'prompt',
    superpowers_bootstrap_owner: 'project',
    superpowers_bootstrap_injected: true,
    superpowers_bootstrap_skill: 'superpowers:using-superpowers',
    superpowers_bootstrap_skip_reason: null,
  });

  assert.equal(run.superpowers_bootstrap_owner, 'project');
  assert.equal(run.superpowers_bootstrap_injected, 1);
  assert.equal(run.superpowers_bootstrap_skill, 'superpowers:using-superpowers');
  assert.equal(run.superpowers_bootstrap_skip_reason, null);
});
