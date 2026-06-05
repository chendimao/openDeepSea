import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-history-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { sessionRepo } = await import('./sessions.js');
const { historyRecordRepo } = await import('./history-records.js');

test('historyRecordRepo creates records and normalizes JSON array fields', () => {
  const project = projectRepo.create({
    name: 'history project',
    path: mkdtempSync(join(tmpdir(), 'history-project-')),
  });
  const session = sessionRepo.create({
    project_id: project.id,
    title: '实现 Session OS',
    mode: 'code',
  });
  const record = historyRecordRepo.create({
    project_id: project.id,
    session_id: session.id,
    title: '实现 Session OS',
    summary: '完成 schema 和 repo',
    status: 'completed',
    mode: 'code',
    started_at: session.created_at,
    ended_at: session.updated_at + 100,
    key_decisions: ['硬切换 sessions/history_records'],
    changed_files: ['packages/backend/src/db.ts', 'packages/backend/src/repos/sessions.ts'],
    verification_summary: 'node --import tsx --test packages/backend/src/repos/sessions.test.ts',
    commit_refs: ['abc123'],
    resume_brief: '继续实现 API 和 runtime',
    compact_count: 1,
  });

  assert.deepEqual(record.key_decisions, ['硬切换 sessions/history_records']);
  assert.deepEqual(record.changed_files, ['packages/backend/src/db.ts', 'packages/backend/src/repos/sessions.ts']);
  assert.deepEqual(record.commit_refs, ['abc123']);
  assert.equal(historyRecordRepo.getBySession(session.id)?.id, record.id);
  assert.equal(historyRecordRepo.listByProject(project.id)[0]?.resume_brief, '继续实现 API 和 runtime');

  const updated = historyRecordRepo.incrementForkCount(record.id);
  assert.equal(updated?.fork_count, 1);
});
