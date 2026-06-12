import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-fullstack-engineer-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { ensureFullstackEngineerRoomAgent, getGlobalFullstackEngineer } = await import('./fullstack-engineer.js');

test('ensureFullstackEngineerRoomAgent joins global fullstack engineer to room', () => {
  const projectPath = join(tmpdir(), `opendeepsea-fullstack-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = ensureFullstackEngineerRoomAgent(room.id);

  assert.equal(agent.agent_id, 'fullstack-engineer');
  assert.equal(agent.workflow_role, 'executor');
  assert.equal(agent.acp_enabled, 1);
  assert.equal(getGlobalFullstackEngineer()?.agent_id, 'fullstack-engineer');
});
