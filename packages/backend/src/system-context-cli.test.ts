import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-system-context-cli-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');

function createProjectPath(name: string): string {
  const path = join(tmpdir(), `openclaw-room-context-cli-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/system-context-cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('system context CLI prints room overview JSON with deterministic task count', () => {
  const project = projectRepo.create({ name: 'Context CLI Project', path: createProjectPath('project') });
  const room = roomRepo.create({ project_id: project.id, name: 'Context CLI Room' });
  taskRepo.create({ project_id: project.id, room_id: room.id, title: 'CLI task' });

  const result = runCli(['room-overview', room.id]);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout) as {
    source: string;
    scope: { room_id: string };
    counts: { tasks: number };
  };
  assert.equal(body.source, 'openclaw.system_context.room_overview');
  assert.equal(body.scope.room_id, room.id);
  assert.equal(body.counts.tasks, 1);
});

test('system context CLI reports structured error for missing resources', () => {
  const result = runCli(['room-overview', 'missing-room']);

  assert.equal(result.status, 1);
  const body = JSON.parse(result.stderr) as { error: string };
  assert.deepEqual(body, { error: 'room not found' });
});
