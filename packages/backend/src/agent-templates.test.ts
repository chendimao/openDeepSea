import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBuiltInAgentTemplates } from './agent-templates.js';
import type { WorkflowRole } from './types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-templates-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo } = await import('./repos/rooms.js');
const { roomRepo } = await import('./repos/rooms.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('built-in agent templates include required ACP-only workflow roles', () => {
  const templates = listBuiltInAgentTemplates();
  const roles = new Set(templates.map((template) => template.workflow_role));

  for (const role of ['planner', 'executor', 'reviewer', 'acceptor'] satisfies WorkflowRole[]) {
    assert.equal(roles.has(role), true);
  }

  for (const template of templates) {
    assert.equal(template.acp_enabled, true);
    assert.equal(template.acp_backend, 'codex');
  }
});

test('built-in templates define hard runtime boundaries', () => {
  const templates = Object.fromEntries(listBuiltInAgentTemplates().map((item) => [item.id, item]));

  assert.equal(templates['planner']?.runtime_backend, 'acp');
  assert.equal(templates['planner']?.acp_permission_mode, 'read-only');
  assert.deepEqual(templates['planner']?.tool_policy, { allowed: ['read_files'] });
  assert.deepEqual(templates['planner']?.workspace_policy, { read: ['.'], write: [] });
  assert.equal(templates['planner']?.memory_scope, 'room');

  assert.equal(templates['backend-executor']?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(templates['backend-executor']?.tool_policy, {
    allowed: ['read_files', 'write_files', 'run_shell'],
  });
  assert.deepEqual(templates['backend-executor']?.workspace_policy, {
    read: ['.'],
    write: ['packages/backend'],
  });
  assert.equal(templates['backend-executor']?.memory_scope, 'agent');

  assert.equal(templates['frontend-executor']?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(templates['frontend-executor']?.tool_policy, {
    allowed: ['read_files', 'write_files', 'run_shell', 'browser', 'image_input'],
  });
  assert.deepEqual(templates['frontend-executor']?.workspace_policy, {
    read: ['.'],
    write: ['packages/frontend'],
  });
  assert.equal(templates['frontend-executor']?.memory_scope, 'agent');

  assert.equal(templates['reviewer']?.acp_permission_mode, 'read-only');
  assert.deepEqual(templates['reviewer']?.tool_policy, { allowed: ['read_files', 'run_shell'] });
  assert.deepEqual(templates['reviewer']?.workspace_policy, { read: ['.'], write: [] });
  assert.equal(templates['reviewer']?.memory_scope, 'room');

  assert.equal(templates['acceptor']?.acp_permission_mode, 'read-only');
  assert.deepEqual(templates['acceptor']?.tool_policy, { allowed: ['read_files'] });
  assert.deepEqual(templates['acceptor']?.workspace_policy, { read: ['.'], write: [] });
  assert.equal(templates['acceptor']?.memory_scope, 'room');
});

test('specialist built-in templates use conservative runtime boundaries', () => {
  const specialTemplateIds = [
    'ui-designer',
    'data-analyst',
    'computer-assistant',
    'product-manager',
    'qa-tester',
    'devops-engineer',
    'security-reviewer',
    'technical-writer',
    'accounting-advisor',
    'legal-assistant',
    'medical-assistant',
    'marketing-strategist',
    'sales-assistant',
  ];
  const templates = new Map(listBuiltInAgentTemplates().map((template) => [template.id, template]));

  for (const id of specialTemplateIds) {
    const template = templates.get(id);
    assert.ok(template);
    assert.equal(template.runtime_backend, 'acp');
    assert.equal(template.acp_permission_mode, 'read-only');
    assert.deepEqual(template.tool_policy, { allowed: ['read_files'] });
    assert.deepEqual(template.workspace_policy, { read: ['.'], write: [] });
    assert.equal(template.memory_scope, 'room');
  }
});

test('built-in agent templates include broader specialist roles', () => {
  const templates = listBuiltInAgentTemplates();
  const ids = templates.map((template) => template.id);
  const uniqueIds = new Set(ids);

  assert.equal(uniqueIds.size, ids.length);

  for (const id of [
    'ui-designer',
    'data-analyst',
    'computer-assistant',
    'product-manager',
    'qa-tester',
    'devops-engineer',
    'security-reviewer',
    'technical-writer',
    'accounting-advisor',
    'legal-assistant',
    'medical-assistant',
    'marketing-strategist',
    'sales-assistant',
  ]) {
    assert.equal(uniqueIds.has(id), true);
  }

  const uiDesigner = templates.find((template) => template.id === 'ui-designer');
  assert.equal(uiDesigner?.workflow_role, 'planner');
  assert.deepEqual(uiDesigner?.capabilities, ['design', 'ui', 'ux', 'accessibility']);

  const dataAnalyst = templates.find((template) => template.id === 'data-analyst');
  assert.equal(dataAnalyst?.workflow_role, 'analyst');
  assert.equal(dataAnalyst?.capabilities.includes('data-analysis'), true);
});

test('built-in agent templates use Chinese display names by default', () => {
  const templates = listBuiltInAgentTemplates();

  for (const template of templates) {
    assert.doesNotMatch(template.name, /^[A-Za-z]/);
  }

  const names = new Map(templates.map((template) => [template.id, template.name]));
  assert.equal(names.get('planner'), '规划师');
  assert.equal(names.get('ui-designer'), '界面设计师');
  assert.equal(names.get('data-analyst'), '数据分析师');
  assert.equal(names.get('computer-assistant'), '电脑助手');
  assert.equal(names.get('accounting-advisor'), '会计顾问');
  assert.equal(names.get('legal-assistant'), '法律助手');
  assert.equal(names.get('medical-assistant'), '医疗助手');
});

test('high-risk professional templates include explicit advisory boundaries', () => {
  const templates = listBuiltInAgentTemplates();

  const accountingAdvisor = templates.find((template) => template.id === 'accounting-advisor');
  const legalAssistant = templates.find((template) => template.id === 'legal-assistant');
  const medicalAssistant = templates.find((template) => template.id === 'medical-assistant');

  assert.match(accountingAdvisor?.rules ?? '', /不能替代注册会计师/);
  assert.match(legalAssistant?.rules ?? '', /不能替代律师意见/);
  assert.match(medicalAssistant?.rules ?? '', /不能诊断、开药或替代医生/);
});

test('agent template routes list and create ACP-only room agents', async () => {
  const projectPath = join(tmpdir(), `openclaw-room-template-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({
    name: 'Template API Project',
    path: projectPath,
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Template Room' });

  const listRes = await request('/api/agent-templates');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as { templates: Array<{ id: string }> };
  assert.ok(listed.templates.some((template) => template.id === 'backend-executor'));

  const createRes = await request(`/api/rooms/${room.id}/agents/from-template`, {
    method: 'POST',
    body: JSON.stringify({ template_id: 'backend-executor' }),
  });
  assert.equal(createRes.status, 201);
  const agent = await createRes.json() as {
    agent_id: string;
    workflow_role: string;
    acp_enabled: 0 | 1;
    acp_backend: string;
    acp_permission_mode: string;
    default_runtime: string;
    runtime_backend: string | null;
    tool_policy: { allowed: string[] } | null;
    workspace_policy: { read: string[]; write: string[] } | null;
    memory_scope: string | null;
    capabilities: string[];
  };
  assert.equal(agent.agent_id, 'backend-executor');
  assert.equal(agent.workflow_role, 'executor');
  assert.equal(agent.acp_enabled, 1);
  assert.equal(agent.acp_backend, 'codex');
  assert.equal(agent.acp_permission_mode, 'workspace-write');
  assert.equal(agent.default_runtime, 'acp');
  assert.equal(agent.runtime_backend, 'acp');
  assert.deepEqual(agent.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(agent.workspace_policy, { read: ['.'], write: ['packages/backend'] });
  assert.equal(agent.memory_scope, 'agent');
  assert.deepEqual(agent.capabilities, ['backend', 'testing']);

  const duplicateRes = await request(`/api/rooms/${room.id}/agents/from-template`, {
    method: 'POST',
    body: JSON.stringify({ template_id: 'backend-executor' }),
  });
  assert.equal(duplicateRes.status, 201);
  const duplicate = await duplicateRes.json() as {
    agent_id: string;
    runtime_backend: string | null;
    workspace_policy: { read: string[]; write: string[] } | null;
  };
  assert.equal(duplicate.agent_id, 'backend-executor');
  assert.equal(duplicate.runtime_backend, 'acp');
  assert.deepEqual(duplicate.workspace_policy, { read: ['.'], write: ['packages/backend'] });
});

test('agent template route rejects unknown templates and mirrors missing room errors', async () => {
  const invalidTemplateRes = await request('/api/rooms/room-1/agents/from-template', {
    method: 'POST',
    body: JSON.stringify({ template_id: 'missing-template' }),
  });
  assert.equal(invalidTemplateRes.status, 404);

  const missingRoomRes = await request('/api/rooms/missing-room/agents/from-template', {
    method: 'POST',
    body: JSON.stringify({ template_id: 'planner' }),
  });
  assert.equal(missingRoomRes.status, 400);
});

test('manual room agents default to no runtime', () => {
  const projectPath = join(tmpdir(), `openclaw-room-manual-agent-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({
    name: 'Manual Agent Project',
    path: projectPath,
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Manual Agent Room' });

  const agent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'manual',
    agent_name: 'Manual',
  });

  assert.equal(agent.default_runtime, 'none');
});
