import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-search-')), 'test.db');

const projectDir = join(tmpdir(), `openclaw-room-search-project-${Date.now()}`);
mkdirSync(projectDir, { recursive: true });

const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { searchProjectRooms } = await import('./room-search.js');

function createProjectPath(name: string): string {
  const path = `${projectDir}-${name}`;
  mkdirSync(path, { recursive: true });
  return path;
}

test('keyword room search matches room metadata, messages, and tasks within one project', async () => {
  const project = projectRepo.create({ name: 'Search Project', path: createProjectPath('search') });
  const target = roomRepo.create({ project_id: project.id, name: '页面问题排查', description: '处理 UI 缺陷' });
  const other = roomRepo.create({ project_id: project.id, name: '后端接口', description: 'API discussion' });
  const foreignProject = projectRepo.create({ name: 'Other Project', path: createProjectPath('other') });
  const foreign = roomRepo.create({ project_id: foreignProject.id, name: '页面显示不完整', description: 'foreign room' });

  messageRepo.create({
    room_id: target.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '移动端页面显示不完整，需要修复这个 bug。',
  });
  taskRepo.create({
    project_id: project.id,
    room_id: target.id,
    title: '修复页面显示不完整',
    description: '按钮区域被遮挡',
  });
  messageRepo.create({
    room_id: other.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '接口鉴权讨论',
  });
  messageRepo.create({
    room_id: foreign.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '这个外部项目不能被搜出',
  });

  const result = await searchProjectRooms({
    projectId: project.id,
    query: '修复页面显示不完整的bug的群聊',
    invokeModel: async () => '',
    forceKeywordOnly: true,
  });

  assert.equal(result.mode, 'keyword');
  assert.equal(result.degraded, false);
  assert.deepEqual(result.results.map((item) => item.room.id), [target.id]);
  assert.ok(result.results[0]?.matchedFields.includes('message'));
  assert.ok(result.results[0]?.matchedFields.includes('task_title'));
});

test('semantic room search reranks candidates with model JSON output', async () => {
  const project = projectRepo.create({ name: 'Semantic Project', path: createProjectPath('semantic') });
  const target = roomRepo.create({ project_id: project.id, name: 'UI 回归排查' });
  const other = roomRepo.create({ project_id: project.id, name: '接口联调' });

  messageRepo.create({
    room_id: target.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '页面底部在小屏幕显示不完整。',
  });
  messageRepo.create({
    room_id: other.id,
    sender_type: 'user',
    sender_id: 'user',
    content: '接口鉴权联调。',
  });

  const result = await searchProjectRooms({
    projectId: project.id,
    query: '修复页面显示不完整的bug的群聊',
    invokeModel: async () => JSON.stringify({
      results: [
        { roomId: target.id, score: 0.94, reason: '消息提到页面显示不完整' },
        { roomId: 'missing-room', score: 1, reason: 'invalid' },
        { roomId: other.id, score: 0.1, reason: '弱相关' },
      ],
    }),
  });

  assert.equal(result.mode, 'semantic');
  assert.equal(result.degraded, false);
  assert.deepEqual(result.results.map((item) => item.room.id), [target.id]);
  assert.equal(result.results[0]?.score, 0.94);
});

test('semantic room search falls back to keyword results when model fails', async () => {
  const project = projectRepo.create({ name: 'Fallback Project', path: createProjectPath('fallback') });
  const target = roomRepo.create({ project_id: project.id, name: '页面 bug' });

  const result = await searchProjectRooms({
    projectId: project.id,
    query: '页面 bug',
    invokeModel: async () => {
      throw new Error('model timeout');
    },
  });

  assert.equal(result.mode, 'keyword');
  assert.equal(result.degraded, true);
  assert.equal(result.degradationReason, 'model_failed');
  assert.deepEqual(result.results.map((item) => item.room.id), [target.id]);
});
