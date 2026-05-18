import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agents-')), 'test.db');

const { agentRepo } = await import('./agents.js');
const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');

test('agentRepo creates, updates, references, and deletes global agents', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-project-'));
  const project = projectRepo.create({ name: 'Agent Library', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Agent Room' });

  const agent = agentRepo.create({
    agent_id: 'frontend-lead',
    name: '前端执行官',
    description: '负责前端实现和验收。',
    preferred_user_name: '陈工',
    personality: '严谨、直接，会主动指出风险。',
    rules: '完成前必须运行构建验证。',
    responsibilities: '前端实现、交互修复、UI 验收。',
    default_acp_backend: 'codex',
    default_acp_permission_mode: 'workspace-write',
  });

  assert.equal(agent.agent_id, 'frontend-lead');
  assert.equal(agent.name, '前端执行官');
  assert.equal(agent.reference_count, 0);

  const updated = agentRepo.update(agent.id, {
    personality: '冷静、务实、重视边界。',
    rules: '不要修改无关文件。',
  });
  assert.equal(updated?.personality, '冷静、务实、重视边界。');
  assert.equal(updated?.rules, '不要修改无关文件。');

  const roomAgent = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: agent.id,
  });
  assert.equal(roomAgent.global_agent_id, agent.id);
  assert.equal(roomAgent.agent_id, 'frontend-lead');
  assert.equal(roomAgent.agent_name, '前端执行官');
  assert.equal(roomAgent.preferred_user_name, '陈工');
  assert.equal(roomAgent.personality, '冷静、务实、重视边界。');
  assert.equal(roomAgent.responsibilities, '前端实现、交互修复、UI 验收。');
  assert.equal(roomAgent.acp_backend, 'codex');
  assert.equal(roomAgent.acp_permission_mode, 'workspace-write');

  const referenced = agentRepo.delete(agent.id);
  assert.equal(referenced.ok, false);
  assert.equal(referenced.reason, 'in_use');
  assert.equal(referenced.references.length, 1);
  assert.equal(referenced.references[0]?.room_id, room.id);

  assert.equal(roomAgentRepo.remove(roomAgent.id), true);

  const stillReferenced = agentRepo.delete(agent.id);
  assert.equal(stillReferenced.ok, false);
  assert.equal(stillReferenced.reason, 'in_use');
  assert.equal(agentRepo.get(agent.id)?.id, agent.id);
});

test('roomAgentRepo migrates legacy room agents into reusable global agents', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-legacy-project-'));
  const project = projectRepo.create({ name: 'Legacy Agent Library', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Legacy Agent Room' });

  const legacy = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'reviewer',
    agent_name: 'Reviewer',
    agent_role: '审查代码、风险和验证缺口。',
  });

  assert.equal(legacy.global_agent_id, null);

  const migrated = roomAgentRepo.ensureGlobalAgent(legacy.id);
  assert.ok(migrated?.global_agent_id);
  assert.equal(migrated?.agent_id, 'reviewer');
  assert.equal(migrated?.agent_name, '审查员');
  assert.equal(migrated?.responsibilities, '代码审查、风险识别、测试缺口分析、验收前质量把关。');

  const global = migrated?.global_agent_id ? agentRepo.get(migrated.global_agent_id) : undefined;
  assert.equal(global?.agent_id, 'reviewer');
  assert.equal(global?.name, '审查员');
});

test('built-in agents are seeded into the global library and can be restored', () => {
  const builtIns = agentRepo.list().filter((agent) => agent.is_builtin);
  assert.ok(builtIns.length >= 5);

  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  assert.equal(planner.is_builtin, 1);
  assert.equal(planner.builtin_key, 'planner');

  const updated = agentRepo.update(planner.id, {
    personality: '临时修改的性格。',
    responsibilities: '临时修改的职责。',
  });
  assert.equal(updated?.personality, '临时修改的性格。');
  assert.equal(updated?.responsibilities, '临时修改的职责。');

  const deleted = agentRepo.delete(planner.id);
  assert.equal(deleted.ok, false);
  assert.equal(deleted.reason, 'builtin');

  const restored = agentRepo.restoreBuiltInDefaults(planner.id);
  assert.ok(restored);
  assert.equal(restored.is_builtin, 1);
  assert.notEqual(restored.personality, '临时修改的性格。');
  assert.notEqual(restored.responsibilities, '临时修改的职责。');
});

test('built-in agent identity is stable across edits and seed re-runs', () => {
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);

  assert.throws(
    () => agentRepo.update(planner.id, { agent_id: 'custom-planner' }),
    /builtin agent id cannot be changed/,
  );
  assert.equal(agentRepo.get(planner.id)?.agent_id, 'planner');

  agentRepo.ensureBuiltInAgents();
  const planners = agentRepo.list().filter((agent) => agent.builtin_key === 'planner');
  assert.equal(planners.length, 1);
  assert.equal(planners[0]?.id, planner.id);
});

test('built-in agent seeding migrates legacy English names without overwriting custom names', () => {
  const planner = agentRepo.getByAgentId('planner');
  const reviewer = agentRepo.getByAgentId('reviewer');
  assert.ok(planner);
  assert.ok(reviewer);

  agentRepo.update(planner.id, { name: 'Planner' });
  agentRepo.update(reviewer.id, { name: '我的审查员' });

  agentRepo.ensureBuiltInAgents();

  assert.equal(agentRepo.get(planner.id)?.name, '规划师');
  assert.equal(agentRepo.get(reviewer.id)?.name, '我的审查员');
});

test('roomAgentRepo soft-removes agents and restores existing memberships', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-agent-soft-remove-project-'));
  const project = projectRepo.create({ name: 'Soft Remove Agent Library', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Soft Remove Agent Room' });
  const reviewer = agentRepo.getByAgentId('reviewer');
  assert.ok(reviewer);

  const roomAgent = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: reviewer.id,
  });
  assert.equal(roomAgent.left_at, null);
  assert.equal(roomAgentRepo.remove(roomAgent.id), true);

  assert.equal(roomAgentRepo.get(roomAgent.id)?.left_at === null, false);
  assert.equal(roomAgentRepo.listByRoom(room.id).some((agent) => agent.id === roomAgent.id), false);
  assert.equal(
    roomAgentRepo.listByRoom(room.id, { includeRemoved: true }).some((agent) => agent.id === roomAgent.id),
    true,
  );

  const restored = roomAgentRepo.addFromGlobalAgent({
    room_id: room.id,
    global_agent_id: reviewer.id,
  });
  assert.equal(restored.id, roomAgent.id);
  assert.equal(restored.left_at, null);
  assert.equal(roomAgentRepo.listByRoom(room.id).some((agent) => agent.id === roomAgent.id), true);
});
