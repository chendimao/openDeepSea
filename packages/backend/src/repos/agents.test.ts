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

  const deleted = agentRepo.delete(agent.id);
  assert.equal(deleted.ok, true);
  assert.equal(agentRepo.get(agent.id), undefined);
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
  assert.equal(migrated?.agent_name, 'Reviewer');
  assert.equal(migrated?.responsibilities, '审查代码、风险和验证缺口。');

  const global = migrated?.global_agent_id ? agentRepo.get(migrated.global_agent_id) : undefined;
  assert.equal(global?.agent_id, 'reviewer');
  assert.equal(global?.name, 'Reviewer');
});
