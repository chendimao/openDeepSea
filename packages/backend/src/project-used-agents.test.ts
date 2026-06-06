import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-project-used-agents-')), 'test.db');

const { agentRepo } = await import('./repos/agents.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { settingsRepo } = await import('./repos/settings.js');
const { buildProjectUsedAgents } = await import('./project-used-agents.js');

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `openclaw-room-${name}-`)),
  });
}

test('buildProjectUsedAgents always includes the built-in session planner', () => {
  const project = createProject('used-agents-planner');
  const planner = agentRepo.getByBuiltinKey('planner') ?? agentRepo.getByAgentId('planner');
  assert.ok(planner);

  const payload = buildProjectUsedAgents(project.id);

  assert.equal(payload.planner.kind, 'session_planner');
  assert.equal(payload.planner.agent_id, 'planner');
  assert.equal(payload.planner.name, planner.name);
  assert.equal(payload.planner.effective_acp_backend, planner.default_acp_backend);
  assert.equal(payload.planner.project_override_acp_backend, null);
  assert.equal(payload.planner.backend_source, 'builtin');
  assert.deepEqual(payload.planner.runtime_profile, {
    permission_mode: planner.default_acp_permission_mode,
    runtime_backend: planner.default_runtime_backend,
    tool_policy: planner.default_tool_policy,
    workspace_policy: planner.default_workspace_policy,
    memory_scope: planner.default_memory_scope,
  });
  assert.deepEqual(payload.agents, []);
});

test('buildProjectUsedAgents applies project session planner backend override', () => {
  const project = createProject('used-agents-planner-override');
  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'claudecode' });

  const payload = buildProjectUsedAgents(project.id);

  assert.equal(payload.planner.effective_acp_backend, 'claudecode');
  assert.equal(payload.planner.project_override_acp_backend, 'claudecode');
  assert.equal(payload.planner.backend_source, 'project');
});

test('buildProjectUsedAgents deduplicates room agents and preserves every room binding', () => {
  const project = createProject('used-agents-dedupe');
  const alpha = roomRepo.create({ project_id: project.id, name: 'Alpha', ensureDefaultPlanner: false });
  const beta = roomRepo.create({ project_id: project.id, name: 'Beta', ensureDefaultPlanner: false });
  const globalAgent = agentRepo.create({
    agent_id: 'frontend-executor-used-agents',
    name: 'Frontend Executor',
    default_acp_backend: 'codex',
  });

  const alphaBinding = roomAgentRepo.addFromGlobalAgent({ room_id: alpha.id, global_agent_id: globalAgent.id });
  const betaBinding = roomAgentRepo.addFromGlobalAgent({ room_id: beta.id, global_agent_id: globalAgent.id });
  roomAgentRepo.setAcp(alphaBinding.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  });
  roomAgentRepo.setAcp(betaBinding.id, {
    acp_enabled: true,
    acp_backend: 'opencode',
    acp_session_id: null,
    acp_session_label: null,
  });
  roomAgentRepo.setWorkflowRole(betaBinding.id, 'executor');

  const payload = buildProjectUsedAgents(project.id);

  assert.equal(payload.agents.length, 1);
  assert.equal(payload.agents[0]?.kind, 'room_agent');
  assert.equal(payload.agents[0]?.global_agent_id, globalAgent.id);
  assert.equal(payload.agents[0]?.agent_id, globalAgent.agent_id);
  assert.equal(payload.agents[0]?.name, globalAgent.name);
  assert.equal(payload.agents[0]?.acp_enabled, true);
  assert.equal(payload.agents[0]?.acp_backend, 'codex');
  assert.deepEqual(
    payload.agents[0]?.room_bindings.map((binding) => ({
      room_id: binding.room_id,
      room_name: binding.room_name,
      room_agent_id: binding.room_agent_id,
      acp_backend: binding.acp_backend,
      workflow_role: binding.workflow_role,
    })),
    [
      {
        room_id: alpha.id,
        room_name: 'Alpha',
        room_agent_id: alphaBinding.id,
        acp_backend: 'codex',
        workflow_role: null,
      },
      {
        room_id: beta.id,
        room_name: 'Beta',
        room_agent_id: betaBinding.id,
        acp_backend: 'opencode',
        workflow_role: 'executor',
      },
    ],
  );
});

test('buildProjectUsedAgents only aggregates agents from the requested project', () => {
  const targetProject = createProject('used-agents-target');
  const otherProject = createProject('used-agents-other');
  const targetRoom = roomRepo.create({ project_id: targetProject.id, name: 'Target', ensureDefaultPlanner: false });
  const otherRoom = roomRepo.create({ project_id: otherProject.id, name: 'Other', ensureDefaultPlanner: false });

  roomAgentRepo.add({ room_id: targetRoom.id, agent_id: 'target-agent', agent_name: 'Target Agent' });
  roomAgentRepo.add({ room_id: otherRoom.id, agent_id: 'other-agent', agent_name: 'Other Agent' });

  const payload = buildProjectUsedAgents(targetProject.id);

  assert.deepEqual(payload.agents.map((agent) => agent.agent_id), ['target-agent']);
  assert.deepEqual(payload.agents.flatMap((agent) => agent.room_bindings.map((binding) => binding.room_id)), [
    targetRoom.id,
  ]);
});

test('buildProjectUsedAgents throws for missing project', () => {
  assert.throws(() => buildProjectUsedAgents('missing-project'), /project not found/);
});
