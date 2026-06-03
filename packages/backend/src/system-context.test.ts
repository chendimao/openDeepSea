import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-system-context-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { fileRepo } = await import('./repos/files.js');
const { messageRepo } = await import('./repos/messages.js');
const {
  getProjectOverview,
  getRoomOverview,
  getSystemOverview,
  listRoomAgents,
  listRoomTasks,
} = await import('./system-context.js');

function createProjectPath(name: string): string {
  const path = join(tmpdir(), `openclaw-room-system-context-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

test('getRoomOverview returns deterministic task, agent, file, and message facts without sensitive ACP fields', () => {
  const project = projectRepo.create({ name: 'Context Project', path: createProjectPath('room-overview') });
  const room = roomRepo.create({ project_id: project.id, name: 'Context Room', description: '系统上下文测试群聊' });
  const agent = roomAgentRepo.listByRoom(room.id).find((item) => item.agent_id === 'planner');
  assert.ok(agent);
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: 'sensitive-session-id',
    acp_session_label: 'Sensitive Label',
  });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: '统计当前群聊任务',
    description: '需要从数据库查询任务数量',
  });
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'context-note.md',
    stored_name: 'stored-context-note.md',
    mime_type: 'text/markdown',
    size: 32,
    url: '/uploads/context-note.md',
    storage_path: '/tmp/context-note.md',
    uploaded_by_id: 'user',
    uploaded_by_name: '用户',
  });
  const message = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '当前群聊有几个任务？',
  });
  fileRepo.addMessageRefs({
    project_id: project.id,
    room_id: room.id,
    message_id: message.id,
    file_ids: [file.id],
  });

  const overview = getRoomOverview(room.id);

  assert.equal(overview.source, 'openclaw.system_context.room_overview');
  assert.equal(overview.scope.project_id, project.id);
  assert.equal(overview.scope.room_id, room.id);
  assert.equal(overview.counts?.tasks, 1);
  assert.equal(overview.counts?.agents, 1);
  assert.equal(overview.counts?.files, 1);
  assert.equal(overview.counts?.recent_messages, 1);
  assert.deepEqual(overview.results.tasks.map((item) => item.id), [task.id]);
  assert.deepEqual(overview.results.agents.map((item) => item.agent_id), ['planner']);
  assert.deepEqual(overview.results.files.map((item) => item.name), ['context-note.md']);
  assert.equal(overview.results.recent_messages[0]?.content, '当前群聊有几个任务？');

  const serialized = JSON.stringify(overview);
  assert.equal(serialized.includes('sensitive-session-id'), false);
  assert.equal(serialized.includes('acp_session_id'), false);
  assert.equal(serialized.includes('/tmp/context-note.md'), false);
});

test('system and project overviews expose aggregate counts and scoped lists', () => {
  const firstProject = projectRepo.create({ name: 'First Project', path: createProjectPath('system-first') });
  const secondProject = projectRepo.create({ name: 'Second Project', path: createProjectPath('system-second') });
  const firstRoom = roomRepo.create({ project_id: firstProject.id, name: 'First Room' });
  roomRepo.create({ project_id: secondProject.id, name: 'Second Room' });
  taskRepo.create({ project_id: firstProject.id, room_id: firstRoom.id, title: 'First task' });

  const system = getSystemOverview();
  const project = getProjectOverview(firstProject.id);
  const tasks = listRoomTasks(firstRoom.id);
  const agents = listRoomAgents(firstRoom.id);

  assert.equal(system.source, 'openclaw.system_context.system_overview');
  assert.equal((system.counts?.projects ?? 0) >= 2, true);
  assert.equal((system.counts?.rooms ?? 0) >= 2, true);
  assert.equal(system.results.projects.some((item) => item.id === firstProject.id), true);
  assert.equal(project.scope.project_id, firstProject.id);
  assert.equal(project.counts?.rooms, 1);
  assert.equal(project.counts?.tasks, 1);
  assert.deepEqual(tasks.map((item) => item.title), ['First task']);
  assert.deepEqual(agents.map((item) => item.agent_id), ['planner']);
});
