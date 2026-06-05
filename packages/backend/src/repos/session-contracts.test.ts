import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-session-contracts-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { sessionRepo } = await import('./sessions.js');
const { sessionContractRepo } = await import('./session-contracts.js');

test('sessionContractRepo creates an empty contract from session objective', () => {
  const project = projectRepo.create({
    name: 'contract project',
    path: mkdtempSync(join(tmpdir(), 'session-contract-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Contract Session',
    current_goal: '补齐后端接入',
  });

  const contract = sessionContractRepo.getOrCreate(session);

  assert.equal(contract.sessionId, session.id);
  assert.equal(contract.objective, '补齐后端接入');
  assert.equal(contract.scope, null);
  assert.deepEqual(contract.risks, []);
  assert.deepEqual(contract.acceptanceCriteria, []);
});

test('sessionContractRepo upserts scope risks and acceptance criteria', () => {
  const project = projectRepo.create({
    name: 'contract update project',
    path: mkdtempSync(join(tmpdir(), 'session-contract-update-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Update Contract',
  });

  const updated = sessionContractRepo.upsert(session, {
    scope: '只改 Session OS 后端接入',
    risks: ['retry 会重复执行 prompt'],
    acceptanceCriteria: ['页面不显示静态 mock 数据'],
  });

  assert.equal(updated.objective, 'Update Contract');
  assert.equal(updated.scope, '只改 Session OS 后端接入');
  assert.deepEqual(updated.risks, ['retry 会重复执行 prompt']);
  assert.deepEqual(updated.acceptanceCriteria, ['页面不显示静态 mock 数据']);
  assert.ok(updated.updated_at > 0);
});
