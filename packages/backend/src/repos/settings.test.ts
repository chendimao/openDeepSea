import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-settings-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { db } = await import('../db.js');
const { roomRepo } = await import('./rooms.js');
const { settingsRepo } = await import('./settings.js');

function clearAiConfigs(): void {
  for (const config of settingsRepo.listAiConfigs()) {
    settingsRepo.deleteAiConfig(config.id);
  }
}

test('settingsRepo defaults chat routing to planner fallback reply', () => {
  const system = settingsRepo.getSystem();

  assert.equal(system.message_routing_mode, 'fallback_reply');
  assert.equal(system.fallback_agent_id, 'planner');
});

test('settingsRepo normalizes legacy fallback_route rows to planner fallback reply', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-settings-legacy-project-'));
  const project = projectRepo.create({ name: 'Legacy Routing', path: projectPath });
  db.prepare('UPDATE projects SET message_routing_mode = ?, fallback_agent_id = NULL WHERE id = ?')
    .run('fallback_route', project.id);
  db.prepare(
    `INSERT INTO settings (
      scope, scope_id, message_routing_mode, fallback_agent_id, interaction_mode, auto_distill_enabled, updated_at
    )
     VALUES ('project', ?, 'fallback_route', NULL, NULL, NULL, ?)`,
  ).run(project.id, Date.now());

  const resolution = settingsRepo.resolveForProject(project.id);

  assert.equal(projectRepo.get(project.id)?.message_routing_mode, 'fallback_reply');
  assert.equal(projectRepo.get(project.id)?.fallback_agent_id, 'planner');
  assert.equal(resolution?.project?.message_routing_mode, 'fallback_reply');
  assert.equal(resolution?.project?.fallback_agent_id, 'planner');
  assert.equal(resolution?.effective.message_routing_mode, 'fallback_reply');
  assert.equal(resolution?.effective.fallback_agent_id, 'planner');
});

test('settingsRepo resolves auto_distill_enabled with project and room overrides', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-settings-project-'));
  const project = projectRepo.create({ name: 'Settings Memory', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Settings Room' });

  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.auto_distill_enabled, true);

  settingsRepo.updateProject(project.id, { auto_distill_enabled: false });
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.auto_distill_enabled, false);

  settingsRepo.updateRoom(room.id, { auto_distill_enabled: true });
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.auto_distill_enabled, true);
});

test('settingsRepo resolves superpowers bootstrap owner with provider default and inheritance', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-settings-superpowers-owner-'));
  const project = projectRepo.create({ name: `superpowers-owner-${Date.now()}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.superpowers_bootstrap_owner, 'provider');

  settingsRepo.updateProject(project.id, { superpowers_bootstrap_owner: 'provider' });
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.superpowers_bootstrap_owner, 'provider');

  settingsRepo.updateRoom(room.id, { superpowers_bootstrap_owner: 'disabled' });
  const resolution = settingsRepo.resolveForRoom(room.id);
  assert.equal(resolution?.effective.superpowers_bootstrap_owner, 'disabled');
  assert.equal(resolution?.sources.superpowers_bootstrap_owner, 'room');
});

test('settingsRepo resolves project session planner backend override and inheritance', () => {
  const project = projectRepo.create({
    name: 'Session Planner Backend',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-session-planner-backend-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Planner Backend Room' });

  let projectResolution = settingsRepo.resolveForProject(project.id);
  assert.equal(projectResolution?.project?.session_planner_acp_backend ?? null, null);
  assert.equal(projectResolution?.effective.session_planner_acp_backend, null);
  assert.equal(projectResolution?.sources.session_planner_acp_backend, 'inherit');

  settingsRepo.updateProject(project.id, { session_planner_acp_backend: 'opencode' });

  projectResolution = settingsRepo.resolveForProject(project.id);
  assert.equal(projectResolution?.project?.session_planner_acp_backend, 'opencode');
  assert.equal(projectResolution?.effective.session_planner_acp_backend, 'opencode');
  assert.equal(projectResolution?.sources.session_planner_acp_backend, 'project');

  const roomResolution = settingsRepo.resolveForRoom(room.id);
  assert.equal(roomResolution?.effective.session_planner_acp_backend, 'opencode');
  assert.equal(roomResolution?.sources.session_planner_acp_backend, 'project');

  settingsRepo.updateProject(project.id, { session_planner_acp_backend: null });

  projectResolution = settingsRepo.resolveForProject(project.id);
  assert.equal(projectResolution?.project?.session_planner_acp_backend, null);
  assert.equal(projectResolution?.effective.session_planner_acp_backend, null);
  assert.equal(projectResolution?.sources.session_planner_acp_backend, 'inherit');
});

test('settingsRepo resolves Superpowers default workflow while preserving saved overrides', async () => {
  const { workflowDefinitionRepo } = await import('./workflow-definitions.js');
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-settings-workflow-project-'));
  const project = projectRepo.create({ name: 'Settings Workflow', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Settings Workflow Room' });
  const superpowers = workflowDefinitionRepo.getSuperpowersDefinition();
  const projectDefinition = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Project Workflow',
    description: null,
    scope: 'project',
    scope_id: project.id,
    definition: testDefinition('project-planning'),
  }).id);
  const roomDefinition = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Room Workflow',
    description: null,
    scope: 'room',
    scope_id: room.id,
    definition: testDefinition('room-planning'),
  }).id);

  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.default_workflow_definition_id, superpowers.id);

  settingsRepo.updateProject(project.id, { default_workflow_definition_id: projectDefinition?.id });
  assert.equal(settingsRepo.getProject(project.id)?.default_workflow_definition_id, projectDefinition?.id);
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.default_workflow_definition_id, superpowers.id);

  settingsRepo.updateRoom(room.id, { default_workflow_definition_id: roomDefinition?.id });
  assert.equal(settingsRepo.getRoom(room.id)?.default_workflow_definition_id, roomDefinition?.id);
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.default_workflow_definition_id, superpowers.id);
});

test('settingsRepo validates workflow definition visibility by settings scope', async () => {
  const { workflowDefinitionRepo } = await import('./workflow-definitions.js');
  const project = projectRepo.create({
    name: 'Workflow Visibility Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-settings-workflow-visibility-')),
  });
  const otherProject = projectRepo.create({
    name: 'Other Workflow Visibility Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-settings-workflow-visibility-other-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Visibility Room' });
  const otherProjectWorkflow = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Other Project Workflow',
    description: null,
    scope: 'project',
    scope_id: otherProject.id,
    definition: testDefinition('other-project-planning'),
  }).id)!;

  assert.throws(
    () => settingsRepo.updateProject(project.id, { default_workflow_definition_id: otherProjectWorkflow.id }),
    /not visible/,
  );
  assert.throws(
    () => settingsRepo.updateRoom(room.id, { default_workflow_definition_id: otherProjectWorkflow.id }),
    /not visible/,
  );
});

test('settingsRepo rejects draft and archived workflow defaults', async () => {
  const { workflowDefinitionRepo } = await import('./workflow-definitions.js');
  const draft = workflowDefinitionRepo.createDraft({
    name: 'Draft Default Workflow',
    description: null,
    scope: 'system',
    scope_id: 'default',
    definition: testDefinition('draft-default-planning'),
  });
  assert.throws(() => settingsRepo.updateSystem({ default_workflow_definition_id: draft.id }), /published/);

  const published = workflowDefinitionRepo.publish(draft.id)!;
  workflowDefinitionRepo.archive(published.id);
  assert.throws(() => settingsRepo.updateSystem({ default_workflow_definition_id: published.id }), /archived|published/);
});

test('settingsRepo ignores archived workflow defaults from system project and room scopes', async () => {
  const { workflowDefinitionRepo } = await import('./workflow-definitions.js');
  const project = projectRepo.create({
    name: 'Workflow Archive Defaults Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-settings-workflow-archive-defaults-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Archive Defaults Room' });
  const superpowers = workflowDefinitionRepo.getSuperpowersDefinition();
  const systemWorkflow = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'System Archive Default',
    description: null,
    scope: 'system',
    scope_id: 'default',
    definition: testDefinition('system-archive-default-planning'),
  }).id)!;
  const projectWorkflow = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Project Archive Default',
    description: null,
    scope: 'project',
    scope_id: project.id,
    definition: testDefinition('project-archive-default-planning'),
  }).id)!;
  const roomWorkflow = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Room Archive Default',
    description: null,
    scope: 'room',
    scope_id: room.id,
    definition: testDefinition('room-archive-default-planning'),
  }).id)!;

  settingsRepo.updateSystem({ default_workflow_definition_id: systemWorkflow.id });
  settingsRepo.updateProject(project.id, { default_workflow_definition_id: projectWorkflow.id });
  settingsRepo.updateRoom(room.id, { default_workflow_definition_id: roomWorkflow.id });

  workflowDefinitionRepo.archive(systemWorkflow.id);
  assert.equal(settingsRepo.getSystem().default_workflow_definition_id, superpowers.id);

  workflowDefinitionRepo.archive(projectWorkflow.id);
  assert.equal(settingsRepo.resolveForProject(project.id)?.effective.default_workflow_definition_id, superpowers.id);

  workflowDefinitionRepo.archive(roomWorkflow.id);
  assert.equal(settingsRepo.resolveForRoom(room.id)?.effective.default_workflow_definition_id, superpowers.id);
});

function testDefinition(prefix: string) {
  return {
    nodes: [
      { id: prefix, type: 'planning' as const, label: 'Planning' },
      { id: `${prefix}-approval`, type: 'approval_gate' as const, label: 'Approval' },
      { id: `${prefix}-dispatch`, type: 'dispatch' as const, label: 'Dispatch' },
      { id: `${prefix}-execute`, type: 'execute' as const, label: 'Execute' },
      { id: `${prefix}-review`, type: 'review' as const, label: 'Review' },
      { id: `${prefix}-repair`, type: 'repair_decision' as const, label: 'Repair' },
      { id: `${prefix}-verify`, type: 'verify' as const, label: 'Verify' },
      { id: `${prefix}-acceptance`, type: 'acceptance' as const, label: 'Acceptance' },
      { id: `${prefix}-memory`, type: 'memory' as const, label: 'Memory' },
    ],
    edges: [
      { from: prefix, to: `${prefix}-approval` },
      { from: `${prefix}-approval`, to: `${prefix}-dispatch`, condition: 'approved' },
      { from: `${prefix}-dispatch`, to: `${prefix}-execute` },
      { from: `${prefix}-execute`, to: `${prefix}-execute`, condition: 'has_runnable_child' },
      { from: `${prefix}-execute`, to: `${prefix}-review`, condition: 'review' },
      { from: `${prefix}-review`, to: `${prefix}-repair`, condition: 'changes_requested' },
      { from: `${prefix}-review`, to: `${prefix}-verify`, condition: 'pass' },
      { from: `${prefix}-repair`, to: `${prefix}-execute`, condition: 'execute' },
      { from: `${prefix}-verify`, to: `${prefix}-acceptance`, condition: 'acceptance' },
      { from: `${prefix}-acceptance`, to: `${prefix}-memory`, condition: 'completed' },
    ],
  };
}

test('settingsRepo stores system planner settings while redacting api key responses', () => {
  const updated = settingsRepo.updateSystem({
    langchain_planner_model: ' gpt-4.1 ',
    openai_base_url: ' https://openai.example/v1 ',
    openai_api_key: ' sk-system-secret1234 ',
  });

  assert.equal(updated.langchain_planner_model, 'gpt-4.1');
  assert.equal(updated.openai_base_url, 'https://openai.example/v1');
  assert.equal(updated.openai_api_key_set, true);
  assert.equal(updated.openai_api_key_preview, 'sk-...1234');
  assert.equal('openai_api_key' in updated, false);

  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'gpt-4.1',
    openai_api_key: 'sk-system-secret1234',
    openai_base_url: 'https://openai.example/v1',
  });

  const preserved = settingsRepo.updateSystem({ langchain_planner_model: 'gpt-4o-mini' });
  assert.equal(preserved.openai_api_key_set, true);
  assert.equal(settingsRepo.getLangChainPlannerSettings().openai_api_key, 'sk-system-secret1234');

  const cleared = settingsRepo.updateSystem({
    langchain_planner_model: '',
    openai_base_url: '',
    openai_api_key: null,
  });

  assert.equal(cleared.langchain_planner_model, null);
  assert.equal(cleared.openai_base_url, null);
  assert.equal(cleared.openai_api_key_set, false);
  assert.equal(cleared.openai_api_key_preview, null);
  assert.equal(settingsRepo.getLangChainPlannerSettings().openai_api_key, null);
});

test('settingsRepo stores knowledge embedding config while resolving runtime credentials safely', () => {
  clearAiConfigs();
  settingsRepo.updateSystem({
    openai_api_key: null,
    openai_base_url: null,
  });

  const updated = settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: 1536,
    knowledge_embedding_base_url: 'https://embeddings.example/v1',
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });

  assert.equal(updated.knowledge_embedding_provider, 'openai-compatible');
  assert.equal(updated.knowledge_embedding_model, 'text-embedding-3-small');
  assert.equal(updated.knowledge_embedding_dimensions, 1536);
  assert.equal(updated.knowledge_embedding_base_url, 'https://embeddings.example/v1');
  assert.equal(updated.knowledge_embedding_api_key_env_var, 'OPENDEEPSEA_EMBEDDING_API_KEY');
  assert.equal('knowledge_embedding_api_key' in updated, false);

  assert.deepEqual(settingsRepo.getKnowledgeEmbeddingSettings(), {
    provider: 'openai-compatible',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    base_url: 'https://embeddings.example/v1',
    api_key: null,
    api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });
});

test('settingsRepo resolves knowledge embedding credentials from active AI config', () => {
  clearAiConfigs();
  const active = settingsRepo.createAiConfig({
    name: 'Embedding Runtime',
    langchain_planner_model: 'planner-model',
    openai_base_url: ' https://active-runtime.example/v1 ',
    openai_api_key: ' sk-active-runtime1234 ',
    activate: true,
  });

  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-large',
    knowledge_embedding_dimensions: 3072,
    knowledge_embedding_base_url: '',
    knowledge_embedding_api_key_env_var: '',
  });

  assert.equal(settingsRepo.getSystem().active_ai_config_id, active.id);
  assert.deepEqual(settingsRepo.getKnowledgeEmbeddingSettings(), {
    provider: 'openai-compatible',
    model: 'text-embedding-3-large',
    dimensions: 3072,
    base_url: 'https://active-runtime.example/v1',
    api_key: 'sk-active-runtime1234',
    api_key_env_var: null,
  });
});

test('settingsRepo lets knowledge embedding env var override active AI config key', () => {
  clearAiConfigs();
  settingsRepo.createAiConfig({
    name: 'Embedding Env Override',
    langchain_planner_model: 'planner-model',
    openai_base_url: 'https://active-env-override.example/v1',
    openai_api_key: 'sk-active-should-not-return',
    activate: true,
  });

  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_dimensions: 1536,
    knowledge_embedding_base_url: '',
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });

  const system = settingsRepo.getSystem();
  assert.equal('knowledge_embedding_api_key' in system, false);
  assert.equal(JSON.stringify(system).includes('sk-active-should-not-return'), false);
  assert.deepEqual(settingsRepo.getKnowledgeEmbeddingSettings(), {
    provider: 'openai-compatible',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    base_url: 'https://active-env-override.example/v1',
    api_key: null,
    api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });
});

test('settingsRepo normalizes knowledge embedding dimensions boundaries', () => {
  settingsRepo.updateSystem({
    knowledge_embedding_provider: 'openai-compatible',
    knowledge_embedding_model: 'text-embedding-3-small',
    knowledge_embedding_base_url: 'https://embedding-dimensions.example/v1',
    knowledge_embedding_api_key_env_var: 'OPENDEEPSEA_EMBEDDING_API_KEY',
  });

  for (const dimensions of [1, 8192]) {
    const updated = settingsRepo.updateSystem({ knowledge_embedding_dimensions: dimensions });

    assert.equal(updated.knowledge_embedding_dimensions, dimensions);
    assert.equal(settingsRepo.getKnowledgeEmbeddingSettings().dimensions, dimensions);
  }

  for (const dimensions of [0, 8193, 1.5]) {
    const updated = settingsRepo.updateSystem({ knowledge_embedding_dimensions: dimensions });

    assert.equal(updated.knowledge_embedding_dimensions, null);
    assert.equal(settingsRepo.getKnowledgeEmbeddingSettings().dimensions, null);
  }
});

test('settingsRepo defaults knowledge embedding settings to local hash', () => {
  clearAiConfigs();
  settingsRepo.updateSystem({
    openai_api_key: null,
    openai_base_url: null,
    knowledge_embedding_provider: null,
    knowledge_embedding_model: null,
    knowledge_embedding_dimensions: null,
    knowledge_embedding_base_url: null,
    knowledge_embedding_api_key_env_var: null,
  });

  assert.deepEqual(settingsRepo.getKnowledgeEmbeddingSettings(), {
    provider: 'local-hash',
    model: 'local-hash-v1',
    dimensions: 256,
    base_url: null,
    api_key: null,
    api_key_env_var: null,
  });
});

test('settingsRepo stores trims and clears global session prompt', () => {
  const defaultSystem = settingsRepo.getSystem();
  assert.equal(defaultSystem.global_session_prompt, null);

  const updated = settingsRepo.updateSystem({
    global_session_prompt: '  请始终先说明执行边界。\n  ',
  });

  assert.equal(updated.global_session_prompt, '请始终先说明执行边界。');
  assert.equal(settingsRepo.getSystem().global_session_prompt, '请始终先说明执行边界。');

  const preserved = settingsRepo.updateSystem({ langchain_planner_model: 'planner-model' });
  assert.equal(preserved.global_session_prompt, '请始终先说明执行边界。');

  const clearedByEmpty = settingsRepo.updateSystem({ global_session_prompt: '   ' });
  assert.equal(clearedByEmpty.global_session_prompt, null);

  const updatedAgain = settingsRepo.updateSystem({ global_session_prompt: '系统级会话约束' });
  assert.equal(updatedAgain.global_session_prompt, '系统级会话约束');

  const clearedByNull = settingsRepo.updateSystem({ global_session_prompt: null });
  assert.equal(clearedByNull.global_session_prompt, null);
});

test('settingsRepo persists AI configs and exposes the active config as runtime planner settings', () => {
  clearAiConfigs();
  const first = settingsRepo.createAiConfig({
    name: 'Primary',
    langchain_planner_model: ' gpt-4.1 ',
    openai_base_url: ' https://primary.example ',
    openai_api_key: ' sk-primary1234 ',
    activate: true,
  });
  const second = settingsRepo.createAiConfig({
    name: 'Fallback',
    langchain_planner_model: ' gpt-4o-mini ',
    openai_base_url: ' https://fallback.example/v1 ',
    openai_api_key: ' sk-fallback1234 ',
  });

  assert.equal(first.name, 'Primary');
  assert.equal(first.langchain_planner_model, 'gpt-4.1');
  assert.equal(first.openai_base_url, 'https://primary.example');
  assert.equal(first.openai_api_key_set, true);
  assert.equal(first.openai_api_key_preview, 'sk-...1234');
  assert.equal('openai_api_key' in first, false);

  const system = settingsRepo.getSystem();
  assert.equal(system.active_ai_config_id, first.id);
  assert.equal(system.langchain_planner_model, 'gpt-4.1');
  assert.equal(system.openai_base_url, 'https://primary.example');
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'gpt-4.1',
    openai_api_key: 'sk-primary1234',
    openai_base_url: 'https://primary.example',
  });

  settingsRepo.setActiveAiConfig(second.id);
  assert.equal(settingsRepo.getSystem().active_ai_config_id, second.id);
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'gpt-4o-mini',
    openai_api_key: 'sk-fallback1234',
    openai_base_url: 'https://fallback.example/v1',
  });
});

test('settingsRepo keeps saved AI configs inactive until explicitly selected', () => {
  clearAiConfigs();
  const created = settingsRepo.createAiConfig({
    name: 'Candidate',
    langchain_planner_model: 'candidate-model',
    openai_base_url: 'https://candidate.example/v1',
    openai_api_key: 'sk-candidate1234',
  });

  const system = settingsRepo.getSystem();
  assert.equal(system.active_ai_config_id, null);
  assert.equal(system.ai_configs.some((config) => config.id === created.id), true);
  assert.equal(system.langchain_planner_model, null);
  assert.equal(system.openai_base_url, null);
  assert.equal(system.openai_api_key_set, false);
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: null,
    openai_api_key: null,
    openai_base_url: null,
  });

  settingsRepo.setActiveAiConfig(created.id);
  assert.equal(settingsRepo.getSystem().active_ai_config_id, created.id);
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'candidate-model',
    openai_api_key: 'sk-candidate1234',
    openai_base_url: 'https://candidate.example/v1',
  });
});

test('settingsRepo updates AI configs while preserving api keys unless explicitly changed', () => {
  clearAiConfigs();
  const created = settingsRepo.createAiConfig({
    name: 'Editable',
    langchain_planner_model: 'gpt-4.1',
    openai_base_url: 'https://editable.example/v1',
    openai_api_key: 'sk-editable1234',
    activate: true,
  });

  const preserved = settingsRepo.updateAiConfig(created.id, {
    name: 'Edited',
    langchain_planner_model: 'gpt-4o',
  });

  assert.equal(preserved?.name, 'Edited');
  assert.equal(preserved?.langchain_planner_model, 'gpt-4o');
  assert.equal(preserved?.openai_api_key_set, true);
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'gpt-4o',
    openai_api_key: 'sk-editable1234',
    openai_base_url: 'https://editable.example/v1',
  });

  const cleared = settingsRepo.updateAiConfig(created.id, { openai_api_key: null });
  assert.equal(cleared?.openai_api_key_set, false);
  assert.equal(settingsRepo.getLangChainPlannerSettings().openai_api_key, null);
});

test('settingsRepo reads a specific AI config as runtime planner settings without activating it', () => {
  clearAiConfigs();
  const active = settingsRepo.createAiConfig({
    name: 'Active',
    langchain_planner_model: 'active-model',
    openai_base_url: 'https://active.example/v1',
    openai_api_key: 'sk-active1234',
    activate: true,
  });
  const candidate = settingsRepo.createAiConfig({
    name: 'Candidate',
    langchain_planner_model: ' candidate-model ',
    openai_base_url: ' https://candidate.example/v1 ',
    openai_api_key: ' sk-candidate1234 ',
  });

  assert.deepEqual(settingsRepo.getAiConfigRuntimeSettings(candidate.id), {
    langchain_planner_model: 'candidate-model',
    openai_api_key: 'sk-candidate1234',
    openai_base_url: 'https://candidate.example/v1',
  });
  assert.equal(settingsRepo.getSystem().active_ai_config_id, active.id);
  assert.deepEqual(settingsRepo.getAiConfigRuntimeSettings('missing-config'), null);
});

test('settingsRepo deleting the active AI config switches to the most recently updated remaining config', () => {
  clearAiConfigs();
  const older = settingsRepo.createAiConfig({
    name: 'Older',
    langchain_planner_model: 'older-model',
    openai_base_url: 'https://older.example/v1',
    openai_api_key: 'sk-older1234',
    activate: true,
  });
  const newer = settingsRepo.createAiConfig({
    name: 'Newer',
    langchain_planner_model: 'newer-model',
    openai_base_url: 'https://newer.example/v1',
    openai_api_key: 'sk-newer1234',
  });
  settingsRepo.updateAiConfig(newer.id, { name: 'Newest' });

  assert.equal(settingsRepo.deleteAiConfig(older.id), true);

  const system = settingsRepo.getSystem();
  assert.equal(system.active_ai_config_id, newer.id);
  assert.equal(system.langchain_planner_model, 'newer-model');
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: 'newer-model',
    openai_api_key: 'sk-newer1234',
    openai_base_url: 'https://newer.example/v1',
  });
});

test('settingsRepo deleting the last active AI config clears runtime planner settings', () => {
  clearAiConfigs();
  const only = settingsRepo.createAiConfig({
    name: 'Only',
    langchain_planner_model: 'only-model',
    openai_base_url: 'https://only.example/v1',
    openai_api_key: 'sk-only1234',
    activate: true,
  });

  assert.equal(settingsRepo.deleteAiConfig(only.id), true);

  const system = settingsRepo.getSystem();
  assert.equal(system.active_ai_config_id, null);
  assert.equal(system.ai_configs.length, 0);
  assert.equal(system.langchain_planner_model, null);
  assert.equal(system.openai_base_url, null);
  assert.equal(system.openai_api_key_set, false);
  assert.deepEqual(settingsRepo.getLangChainPlannerSettings(), {
    langchain_planner_model: null,
    openai_api_key: null,
    openai_base_url: null,
  });
});

test('settingsRepo unions workspace_excluded_dirs across system and project', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-settings-excluded-'));
  const project = projectRepo.create({ name: 'Excluded Dirs', path: projectPath });

  assert.deepEqual(settingsRepo.resolveWorkspaceExcludedDirs(project.id), []);

  settingsRepo.updateSystem({ workspace_excluded_dirs: ['vendor'] });
  settingsRepo.updateProject(project.id, { workspace_excluded_dirs: ['tmp', 'vendor'] });

  assert.deepEqual(
    settingsRepo.resolveWorkspaceExcludedDirs(project.id).sort(),
    ['tmp', 'vendor'],
  );
});
