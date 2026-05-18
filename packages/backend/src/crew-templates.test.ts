import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-crew-templates-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { agentRepo } = await import('./repos/agents.js');
const { roomAgentRepo } = await import('./repos/rooms.js');
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

test('crew template route lists the built-in room crews', async () => {
  const res = await request('/api/crew-templates');
  assert.equal(res.status, 200);
  const body = await res.json() as {
    templates: Array<{ id: string; agent_template_ids: string[]; default: boolean }>;
  };

  assert.deepEqual(
    body.templates.map((template) => template.id),
    ['discussion-only', 'light-implementation', 'fullstack-collaboration'],
  );
  assert.deepEqual(
    body.templates.find((template) => template.id === 'light-implementation')?.agent_template_ids,
    ['planner', 'backend-executor', 'reviewer'],
  );
  assert.equal(body.templates.find((template) => template.id === 'light-implementation')?.default, true);
});

test('room creation applies the selected crew template with executable workflow roles', async () => {
  const project = createProject('Crew Template Project');

  const res = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Implementation Room',
      crew_template_id: 'light-implementation',
    }),
  });
  assert.equal(res.status, 201);
  const room = await res.json() as { id: string };
  const agents = roomAgentRepo.listByRoom(room.id);

  assert.deepEqual(agents.map((agent) => agent.agent_id), ['planner', 'backend-executor', 'reviewer']);
  assert.deepEqual(agents.map((agent) => agent.workflow_role), ['planner', 'executor', 'reviewer']);
  assert.equal(agents.every((agent) => agent.acp_enabled === 1 && agent.acp_backend === 'codex'), true);
  assert.equal(agents.every((agent) => agent.default_runtime === 'acp'), true);

  const planner = agents.find((agent) => agent.agent_id === 'planner');
  const backend = agents.find((agent) => agent.agent_id === 'backend-executor');
  const reviewer = agents.find((agent) => agent.agent_id === 'reviewer');
  assert.equal(planner?.acp_permission_mode, 'read-only');
  assert.deepEqual(planner?.tool_policy, { allowed: ['read_files'] });
  assert.deepEqual(planner?.workspace_policy, { read: ['.'], write: [] });
  assert.equal(planner?.memory_scope, 'room');
  assert.equal(backend?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(backend?.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(backend?.workspace_policy, { read: ['.'], write: ['packages/backend'] });
  assert.equal(backend?.memory_scope, 'agent');
  assert.equal(reviewer?.acp_permission_mode, 'read-only');
  assert.deepEqual(reviewer?.tool_policy, { allowed: ['read_files', 'run_shell'] });
  assert.deepEqual(reviewer?.workspace_policy, { read: ['.'], write: [] });
  assert.equal(reviewer?.memory_scope, 'room');
});

test('room creation uses the default implementation crew when no template is supplied', async () => {
  const project = createProject('Default Template Project');

  const res = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Default Room' }),
  });
  assert.equal(res.status, 201);
  const room = await res.json() as { id: string };
  const agents = roomAgentRepo.listByRoom(room.id);

  assert.deepEqual(agents.map((agent) => agent.agent_id), ['planner', 'backend-executor', 'reviewer']);
  assert.deepEqual(agents.map((agent) => agent.workflow_role), ['planner', 'executor', 'reviewer']);
});

test('batch-adding built-in global agents preserves workflow metadata', async () => {
  const project = createProject('Batch Builtin Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Existing Room', crew_template_id: 'discussion-only' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);

  const addRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [backend.id] }),
  });
  assert.equal(addRes.status, 201);

  const executor = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'backend-executor');
  assert.equal(executor?.workflow_role, 'executor');
  assert.deepEqual(executor?.capabilities, ['backend', 'testing']);
  assert.equal(executor?.default_runtime, 'acp');
  assert.equal(executor?.acp_permission_mode, 'workspace-write');
  assert.equal(executor?.runtime_backend, 'acp');
  assert.deepEqual(executor?.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(executor?.workspace_policy, { read: ['.'], write: ['packages/backend'] });
  assert.equal(executor?.memory_scope, 'agent');
  assert.equal(Object.hasOwn(executor as object, 'runtime_profile_version'), false);
});

test('re-adding an existing built-in agent does not overwrite room-level workflow customization', async () => {
  const project = createProject('Builtin Customization Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Customized Room', crew_template_id: 'light-implementation' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const executor = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'backend-executor');
  assert.ok(executor);
  const customized = roomAgentRepo.setWorkflowRole(executor.id, 'reviewer');
  assert.equal(customized?.workflow_role, 'reviewer');
  const runtimeCustomized = roomAgentRepo.setCapabilitiesAndRuntime(executor.id, {
    capabilities: customized?.capabilities ?? [],
    default_runtime: customized?.default_runtime ?? 'acp',
    runtime_backend: 'model',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['docs'], write: [] },
    memory_scope: 'room',
  });
  assert.equal(runtimeCustomized?.runtime_backend, 'model');

  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  const addRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [backend.id] }),
  });
  assert.equal(addRes.status, 201);

  const after = roomAgentRepo.get(executor.id);
  assert.equal(after?.workflow_role, 'reviewer');
  assert.equal(after?.runtime_backend, 'model');
  assert.deepEqual(after?.tool_policy, { allowed: ['read_files'] });
  assert.deepEqual(after?.workspace_policy, { read: ['docs'], write: [] });
  assert.equal(after?.memory_scope, 'room');
});

test('listing a room does not overwrite planner room-level runtime boundary customization', async () => {
  const project = createProject('Planner Runtime Customization Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Planner Runtime Room', crew_template_id: 'discussion-only' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const planner = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'planner');
  assert.ok(planner);

  const customized = roomAgentRepo.setCapabilitiesAndRuntime(planner.id, {
    capabilities: planner.capabilities,
    default_runtime: planner.default_runtime,
    runtime_backend: 'model',
    tool_policy: { allowed: ['read_files'] },
    workspace_policy: { read: ['docs'], write: [] },
    memory_scope: 'agent',
  });
  assert.equal(customized?.runtime_backend, 'model');

  const listed = roomAgentRepo.listByRoom(room.id).find((agent) => agent.id === planner.id);
  assert.equal(listed?.runtime_backend, 'model');
  assert.deepEqual(listed?.workspace_policy, { read: ['docs'], write: [] });
  assert.equal(listed?.memory_scope, 'agent');
});

test('built-in template migrates legacy room runtime policy once without overwriting later customization', async () => {
  const project = createProject('Legacy Room Runtime Migration Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Legacy Runtime Room', crew_template_id: 'discussion-only' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });

  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(agent.id, {
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
    runtime_profile_version: 0,
  });

  const migrated = roomAgentRepo.applyBuiltInTemplate(agent.id, 'backend-executor');
  assert.equal(migrated?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(migrated?.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(migrated?.workspace_policy, { read: ['.'], write: ['packages/backend'] });

  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  const customized = roomAgentRepo.setCapabilitiesAndRuntime(agent.id, {
    capabilities: migrated?.capabilities ?? [],
    default_runtime: migrated?.default_runtime ?? 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
  });
  assert.deepEqual(customized?.tool_policy, { allowed: [] });

  const listed = roomAgentRepo.listByRoom(room.id).find((item) => item.id === agent.id);
  assert.equal(listed?.acp_permission_mode, 'bypass');
  assert.deepEqual(listed?.tool_policy, { allowed: [] });
  assert.deepEqual(listed?.workspace_policy, { read: [], write: [] });
  assert.equal(listed?.memory_scope, 'agent');
});

test('re-adding an existing built-in agent migrates legacy room runtime policy once', async () => {
  const project = createProject('Legacy Room Runtime Readd Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Legacy Runtime Readd Room', crew_template_id: 'discussion-only' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  const agent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });

  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(agent.id, {
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
    runtime_profile_version: 0,
  });

  const addRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [backend.id] }),
  });
  assert.equal(addRes.status, 201);

  const migrated = roomAgentRepo.get(agent.id);
  assert.equal(migrated?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(migrated?.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(migrated?.workspace_policy, { read: ['.'], write: ['packages/backend'] });

  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(agent.id, {
    capabilities: migrated?.capabilities ?? [],
    default_runtime: migrated?.default_runtime ?? 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
  });

  const secondAddRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [backend.id] }),
  });
  assert.equal(secondAddRes.status, 201);

  const afterCustomization = roomAgentRepo.get(agent.id);
  assert.equal(afterCustomization?.acp_permission_mode, 'bypass');
  assert.deepEqual(afterCustomization?.tool_policy, { allowed: [] });
  assert.deepEqual(afterCustomization?.workspace_policy, { read: [], write: [] });
  assert.equal(afterCustomization?.memory_scope, 'agent');
});

test('listing a room migrates legacy non-planner built-in runtime policy without exposing migration marker', async () => {
  const project = createProject('Legacy Non Planner List Migration Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Legacy Non Planner Room', crew_template_id: 'light-implementation' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const backend = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'backend-executor');
  assert.ok(backend);

  roomAgentRepo.setAcp(backend.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
    runtime_profile_version: 0,
  });

  const listed = roomAgentRepo.listByRoom(room.id).find((agent) => agent.id === backend.id);
  assert.equal(listed?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(listed?.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(listed?.workspace_policy, { read: ['.'], write: ['packages/backend'] });
  assert.equal(Object.hasOwn(listed as object, 'runtime_profile_version'), false);

  const reviewer = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'reviewer');
  assert.ok(reviewer);
  roomAgentRepo.setCapabilitiesAndRuntime(reviewer.id, {
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
    runtime_profile_version: 0,
  });
  const migratedReviewer = roomAgentRepo.listByRoom(room.id).find((agent) => agent.id === reviewer.id);
  assert.equal(migratedReviewer?.memory_scope, 'room');
  assert.deepEqual(migratedReviewer?.tool_policy, { allowed: ['read_files', 'run_shell'] });

  roomAgentRepo.setAcp(backend.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(backend.id, {
    capabilities: listed?.capabilities ?? [],
    default_runtime: listed?.default_runtime ?? 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
  });

  const customized = roomAgentRepo.listByRoom(room.id).find((agent) => agent.id === backend.id);
  assert.equal(customized?.acp_permission_mode, 'bypass');
  assert.deepEqual(customized?.tool_policy, { allowed: [] });
  assert.deepEqual(customized?.workspace_policy, { read: [], write: [] });
});

test('listing a room links and migrates legacy built-in room agent without global reference', async () => {
  const project = createProject('Legacy Unlinked Builtin Migration Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Legacy Unlinked Room', crew_template_id: 'discussion-only' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const legacy = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'backend-executor',
    agent_name: 'Backend Executor',
    agent_role: '旧版后端执行智能体。',
  });
  roomAgentRepo.setAcp(legacy.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
    acp_permission_mode: 'bypass',
    acp_writable_dirs: [],
  });
  roomAgentRepo.setCapabilitiesAndRuntime(legacy.id, {
    capabilities: [],
    default_runtime: 'acp',
    runtime_backend: 'acp',
    tool_policy: { allowed: [] },
    workspace_policy: { read: [], write: [] },
    memory_scope: 'agent',
    runtime_profile_version: 0,
  });

  const listed = roomAgentRepo.listByRoom(room.id).find((agent) => agent.id === legacy.id);
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  assert.equal(listed?.global_agent_id, backend.id);
  assert.equal(listed?.acp_permission_mode, 'workspace-write');
  assert.deepEqual(listed?.tool_policy, { allowed: ['read_files', 'write_files', 'run_shell'] });
  assert.deepEqual(listed?.workspace_policy, { read: ['.'], write: ['packages/backend'] });
  assert.equal(Object.hasOwn(listed as object, 'runtime_profile_version'), false);
});

function createProject(name: string) {
  const projectPath = join(tmpdir(), `${name.replace(/\W+/g, '-').toLowerCase()}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  return projectRepo.create({ name, path: projectPath });
}
