import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-workflow-monitor-'));
const projectDir = join(tempDir, 'project');
mkdirSync(projectDir);
process.env.OPENCLAW_ROOM_DB = join(tempDir, 'test.db');

const { db } = await import('../db.js');
const { agentRunRepo } = await import('../repos/agent-runs.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowIncidentRepo } = await import('../repos/workflow-incidents.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { scanWorkflowIncidents } = await import('./workflow-monitor.js');

test('scanWorkflowIncidents detects stale active agent run and deduplicates by fingerprint', () => {
  const fixture = createWorkflowFixture('stale active run');
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    status: 'running',
    room_agent_id: fixture.agent.id,
    sort_order: 1,
  });
  const run = agentRunRepo.create({
    room_id: fixture.room.id,
    room_agent_id: fixture.agent.id,
    agent_id: fixture.agent.agent_id,
    backend: 'codex',
    task_id: fixture.childTask.id,
    workflow_run_id: fixture.workflow.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'implement',
  });
  agentRunRepo.appendStdout(run.id, 'started implementation');
  agentRunRepo.appendStderr(run.id, 'waiting on backend');
  agentRunRepo.appendActivity(run.id, 'agent accepted task');
  db.prepare('UPDATE agent_runs SET updated_at = ? WHERE id = ?').run(1_000, run.id);

  const first = scanWorkflowIncidents({ now: 130_000, staleAgentRunMs: 120_000 });
  const second = scanWorkflowIncidents({ now: 130_000, staleAgentRunMs: 120_000 });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(workflowIncidentRepo.listByWorkflow(fixture.workflow.id).length, 1);
  assert.equal(first[0]?.incident_type, 'agent_run_stale');
  const context = JSON.parse(first[0]?.context_json ?? '{}') as Record<string, unknown>;
  assert.match(String(context.stdout), /started implementation/);
  assert.match(String(context.stderr), /waiting on backend/);
  assert.match(String(context.activityLog), /agent accepted task/);
  assert.deepEqual(context.workflowStep, {
    id: step.id,
    stage: 'implementation',
    status: 'running',
    error: null,
    scopeRead: [],
    scopeWrite: [],
  });
});

test('scanWorkflowIncidents detects running step without active agent run', () => {
  const fixture = createWorkflowFixture('step without active run');
  workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    status: 'running',
    room_agent_id: fixture.agent.id,
    sort_order: 1,
  });

  const incidents = scanWorkflowIncidents({ now: 20_000, staleAgentRunMs: 120_000 });

  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.incident_type, 'step_without_active_run');
});

test('scanWorkflowIncidents detects backend restart interrupted agent run', () => {
  const fixture = createWorkflowFixture('backend restart');
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    status: 'interrupted',
    room_agent_id: fixture.agent.id,
    sort_order: 1,
  });
  const run = agentRunRepo.create({
    room_id: fixture.room.id,
    room_agent_id: fixture.agent.id,
    agent_id: fixture.agent.agent_id,
    backend: 'codex',
    task_id: fixture.childTask.id,
    workflow_run_id: fixture.workflow.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'implement',
  });
  agentRunRepo.interruptRun(run.id, 'Backend restarted before agent run completed');

  const incidents = scanWorkflowIncidents();
  const incident = incidents.find((item) => item.workflow_run_id === fixture.workflow.id);

  assert.equal(incident?.incident_type, 'backend_restart_interrupted');
  assert.match(incident?.error ?? '', /Backend restarted/);
  assert.equal(workflowIncidentRepo.listByWorkflow(fixture.workflow.id).length, 1);
});

test('scanWorkflowIncidents detects failed child task under active workflow task', () => {
  const fixture = createWorkflowFixture('failed child task');
  taskRepo.updateStatus(fixture.childTask.id, 'failed');

  const incidents = scanWorkflowIncidents();
  const incident = incidents.find((item) => item.workflow_run_id === fixture.workflow.id);

  assert.equal(incident?.incident_type, 'child_task_failed');
  assert.equal(incident?.child_task_id, fixture.childTask.id);
  assert.equal(workflowIncidentRepo.listByWorkflow(fixture.workflow.id).length, 1);
});

test('scanWorkflowIncidents classifies blocked workflow executor errors', () => {
  const fixture = createWorkflowFixture('executor unavailable');
  workflowRepo.blockRun(fixture.workflow.id, 'No executor available for implementation');

  const incidents = scanWorkflowIncidents();
  const incident = incidents.find((item) => item.workflow_run_id === fixture.workflow.id);

  assert.equal(incident?.incident_type, 'executor_unavailable');
  assert.match(incident?.error ?? '', /No executor available/);
  assert.equal(workflowIncidentRepo.listByWorkflow(fixture.workflow.id).length, 1);
});

function createWorkflowFixture(name: string) {
  const fixtureProjectDir = join(projectDir, name.replace(/\s+/g, '-'));
  mkdirSync(fixtureProjectDir, { recursive: true });
  const project = projectRepo.create({ name: `Project ${name}`, path: fixtureProjectDir });
  const room = roomRepo.create({ project_id: project.id, name: `Room ${name}` });
  const agent = configureExecutor(roomAgentRepo.add({
    room_id: room.id,
    agent_id: `codex-${name.replace(/\s+/g, '-')}`,
    agent_name: 'Codex Agent',
  }));
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: `Parent ${name}`,
  });
  taskRepo.updateStatus(task.id, 'in_progress');
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: `Child ${name}`,
    description: 'packages/backend implementation',
    assigned_agent_id: agent.id,
  });
  taskRepo.updateStatus(childTask.id, 'in_progress');
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    current_stage: 'implementation',
  });
  return { project, room, agent, task, childTask, workflow };
}

function configureExecutor(agent: ReturnType<typeof roomAgentRepo.add>) {
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, 'executor') ?? agent;
  const withAcp = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  }) ?? withRole;
  return roomAgentRepo.setCapabilitiesAndRuntime(withAcp.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
  }) ?? withAcp;
}
