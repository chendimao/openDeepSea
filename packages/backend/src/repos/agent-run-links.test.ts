import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-run-links-')), 'test.db');

const { agentRunLinkRepo } = await import('./agent-run-links.js');

test('agentRunLinkRepo creates and lists child run links', () => {
  const link = agentRunLinkRepo.create({
    room_id: 'room-1',
    task_id: 'task-1',
    parent_run_id: 'parent-run',
    child_run_id: 'child-run',
    relationship: 'subagent',
    role: 'implementer',
  });

  assert.equal(link.room_id, 'room-1');
  assert.equal(link.task_id, 'task-1');
  assert.equal(link.parent_run_id, 'parent-run');
  assert.equal(link.child_run_id, 'child-run');
  assert.equal(link.relationship, 'subagent');
  assert.equal(link.role, 'implementer');

  assert.deepEqual(agentRunLinkRepo.listByParentRun('parent-run').map((item) => item.id), [link.id]);
  assert.deepEqual(agentRunLinkRepo.listByTask('task-1').map((item) => item.id), [link.id]);
});
