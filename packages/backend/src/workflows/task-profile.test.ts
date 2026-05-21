import assert from 'node:assert/strict';
import test from 'node:test';
import { inferTaskProfile } from './task-profile.js';

test('classifies recent room sidebar task as frontend feature', () => {
  const profile = inferTaskProfile({
    title: '最近群聊指的是最近访问过的群聊',
    description: '在侧边栏最近项目下方展示当前用户最近访问过的群聊，补充 i18n 文案、空态和跳转高亮处理。',
    scopeRead: [],
    scopeWrite: [],
    acceptance: ['侧边栏最近群聊按访问时间倒序展示'],
  });

  assert.equal(profile.taskType, 'frontend_feature');
  assert.deepEqual(profile.domains, ['frontend', 'ui']);
  assert.equal(profile.workflowTemplate, 'frontend_feature');
  assert.equal(profile.recommendedTemplateId, 'frontend-executor');
  assert.ok(profile.requiredCapabilities.includes('frontend'));
});

test('classifies product report PPT as presentation without frontend or backend template', () => {
  const profile = inferTaskProfile({
    title: '制作一个产品汇报 PPT',
    description: '整理项目目标、核心功能、截图说明和验收结论，输出演示文稿。',
    scopeRead: [],
    scopeWrite: [],
    acceptance: ['PPT 可以用于产品汇报'],
  });

  assert.equal(profile.taskType, 'presentation');
  assert.deepEqual(profile.domains, ['presentation']);
  assert.equal(profile.workflowTemplate, 'presentation');
  assert.equal(profile.recommendedTemplateId, 'technical-writer');
  assert.notEqual(profile.recommendedTemplateId, 'frontend-executor');
  assert.notEqual(profile.recommendedTemplateId, 'backend-executor');
});

test('classifies sqlite api task as backend feature', () => {
  const profile = inferTaskProfile({
    title: '新增 SQLite 表和 API',
    description: '在 packages/backend 中增加数据库仓储、Express route 和接口测试。',
    scopeRead: ['packages/backend/src/db.ts'],
    scopeWrite: ['packages/backend/src/repos/recent-rooms.ts', 'packages/backend/src/recent-rooms.routes.ts'],
    acceptance: ['API 返回最近访问群聊'],
  });

  assert.equal(profile.taskType, 'backend_feature');
  assert.deepEqual(profile.domains, ['backend']);
  assert.equal(profile.recommendedTemplateId, 'backend-executor');
});

test('classifies upload integration bugfix as fullstack bugfix', () => {
  const profile = inferTaskProfile({
    title: '修复文件上传前后端联调 bug',
    description: '修复 React 上传组件调用 backend API 时的报错，并补充回归测试。',
    scopeRead: ['packages/frontend/src/pages/FilesPage.tsx', 'packages/backend/src/files.routes.ts'],
    scopeWrite: ['packages/frontend/src/pages/FilesPage.tsx', 'packages/backend/src/files.routes.ts'],
    acceptance: ['文件上传前后端联调通过'],
  });

  assert.equal(profile.taskType, 'bugfix');
  assert.deepEqual(profile.domains, ['frontend', 'backend']);
  assert.ok(profile.requiredCapabilities.includes('testing'));
});

test('classifies readme update as documentation', () => {
  const profile = inferTaskProfile({
    title: '整理 README',
    description: '更新 docs/ 和 README.md 中的安装说明。',
    scopeRead: ['README.md'],
    scopeWrite: ['README.md'],
    acceptance: ['文档说明清晰'],
  });

  assert.equal(profile.taskType, 'documentation');
  assert.deepEqual(profile.domains, ['documentation']);
  assert.equal(profile.recommendedTemplateId, 'technical-writer');
});
