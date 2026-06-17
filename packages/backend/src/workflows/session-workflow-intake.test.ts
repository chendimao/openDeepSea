import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-workflow-intake-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { sessionRepo, sessionMessageRepo } = await import('../repos/sessions.js');
const { taskEventRepo } = await import('../repos/task-events.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { parseGraphState } = await import('./graph/state.js');
const { createSessionWorkflowIntake } = await import('./session-workflow-intake.js');
const { SUPERPOWERS_V2_GRAPH_VERSION } = await import('./superpowers-stage-registry.js');

test('createSessionWorkflowIntake creates task and superpowers v2 workflow for user message', () => {
  const projectPath = join(tmpdir(), `opendeepsea-workflow-intake-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Room' });
  const session = sessionRepo.create({ project_id: project.id, title: 'Session', mode: 'code' });
  const sourceMessage = sessionMessageRepo.create({
    session_id: session.id,
    role: 'user',
    sender_id: 'user',
    content: '修复 planner workflow',
    metadata: {},
  });

  const result = createSessionWorkflowIntake({
    project,
    session,
    sourceMessage,
    room,
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [],
  });

  assert.equal(taskRepo.get(result.task.id)?.source_message_id, sourceMessage.id);
  const storedRun = workflowRepo.getRun(result.workflow.id);
  assert.equal(storedRun?.graph_version, SUPERPOWERS_V2_GRAPH_VERSION);
  assert.equal(storedRun?.workflow_definition_version, 1);
  assert.ok(storedRun?.workflow_definition_id);
  const snapshot = JSON.parse(storedRun?.workflow_definition_snapshot ?? '{}') as {
    builtinKey?: string;
    definition?: { metadata?: { runtime_profile?: string; gate_policy?: string } };
  };
  assert.equal(snapshot.builtinKey, 'superpowers-development');
  assert.equal(snapshot.definition?.metadata?.runtime_profile, 'superpowers');
  assert.equal(result.workflow.current_stage, 'analysis');
  const state = parseGraphState(result.workflow.graph_state);
  assert.equal(state?.currentNode, 'context');
  assert.equal(state?.activeSuperpowersStage, 'intake');
  assert.equal(state?.selectedIntent, null);
  assert.deepEqual(state?.selectedPath, []);
  assert.equal(state?.routingArtifactVersionId, null);
  assert.equal(state?.analysisArtifactVersionId, null);
  assert.deepEqual(
    taskEventRepo.listByTask(result.task.id).map((event) => event.type),
    ['task_created'],
  );
});
