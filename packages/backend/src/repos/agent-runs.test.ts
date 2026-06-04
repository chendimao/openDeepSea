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

test('agentRunRepo listForClientByRoom truncates prompts for room run lists', () => {
  const project = projectRepo.create({
    name: `agent-runs-client-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-client-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner-client', agent_name: 'Planner' });
  const prompt = `请分析：${'x'.repeat(2000)}`;

  const run = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: 'planner-client',
    backend: 'codex',
    prompt,
  });

  assert.equal(agentRunRepo.get(run.id)?.prompt, prompt);

  const [listed] = agentRunRepo.listForClientByRoom(room.id);
  assert.ok(listed);
  assert.ok(listed.prompt.length < 200);
  assert.match(listed.prompt, /^请分析：/);
  assert.match(listed.prompt, /truncated/);
});

test('agentRunRepo listForClientByRoom includes active runs outside the recent limit', () => {
  const project = projectRepo.create({
    name: `agent-runs-active-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-active-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner-active', agent_name: 'Planner' });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: 'planner-active',
    backend: 'codex',
    prompt: 'active prompt',
    status: 'running',
  });
  for (let index = 0; index < 3; index += 1) {
    const run = agentRunRepo.create({
      room_id: room.id,
      room_agent_id: agent.id,
      agent_id: `recent-${index}`,
      backend: 'codex',
      prompt: `recent ${index}`,
      status: 'running',
    });
    agentRunRepo.updateStatus(run.id, 'completed');
  }

  const listed = agentRunRepo.listForClientByRoom(room.id, 1);

  assert.equal(listed.some((run) => run.id === activeRun.id), true);
  assert.ok(listed.length > 1);
});

test('agentRunRepo does not let late active updates overwrite terminal status', () => {
  const project = projectRepo.create({
    name: `agent-runs-terminal-${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-agent-runs-terminal-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner-terminal', agent_name: 'Planner' });
  const run = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: 'planner-terminal',
    backend: 'codex',
    prompt: 'prompt',
  });

  const failed = agentRunRepo.updateStatus(run.id, 'failed', { error: 'ACP prompt timed out' });
  assert.equal(failed?.status, 'failed');
  assert.equal(typeof failed?.completed_at, 'number');

  const retrying = agentRunRepo.updateStatus(run.id, 'retrying');

  assert.equal(retrying?.status, 'failed');
  assert.equal(retrying?.error, 'ACP prompt timed out');
  assert.equal(retrying?.completed_at, failed?.completed_at);
});
