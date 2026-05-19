import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-incidents-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');
const { workflowRepo } = await import('./workflows.js');
const { workflowIncidentRepo } = await import('./workflow-incidents.js');

function createIncidentFixture() {
  const project = projectRepo.create({
    name: `Incident Project ${Date.now()}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-incident-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Incident Room' });
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'backend-executor', agent_name: 'Backend Executor' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Parent incident task' });
  const child = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    parent_task_id: task.id,
    title: 'Child incident task',
    assigned_agent_id: agent.id,
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: child.id,
    stage: 'implementation',
    status: 'running',
    room_agent_id: agent.id,
    assigned_room_agent_id: agent.id,
    prompt: 'implement child task',
    sort_order: 1,
  });
  return { project, room, agent, task, child, run, step };
}

test('workflowIncidentRepo creates and deduplicates detected incidents by fingerprint', () => {
  const fixture = createIncidentFixture();
  const first = workflowIncidentRepo.upsertDetected({
    room_id: fixture.room.id,
    project_id: fixture.project.id,
    workflow_run_id: fixture.run.id,
    workflow_step_id: fixture.step.id,
    task_id: fixture.task.id,
    child_task_id: fixture.child.id,
    room_agent_id: fixture.agent.id,
    incident_type: 'backend_restart_interrupted',
    severity: 'warning',
    error: 'Backend restarted before workflow step completed',
    context: { stepStatus: 'running', agent: fixture.agent.agent_id },
  });
  const second = workflowIncidentRepo.upsertDetected({
    room_id: fixture.room.id,
    project_id: fixture.project.id,
    workflow_run_id: fixture.run.id,
    workflow_step_id: fixture.step.id,
    task_id: fixture.task.id,
    child_task_id: fixture.child.id,
    room_agent_id: fixture.agent.id,
    incident_type: 'backend_restart_interrupted',
    severity: 'warning',
    error: 'Backend restarted before workflow step completed',
    context: { stepStatus: 'interrupted', agent: fixture.agent.agent_id },
  });

  assert.equal(second.id, first.id);
  assert.equal(second.status, 'open');
  assert.equal(second.attempt_count, 0);
  assert.equal(second.context_json.includes('interrupted'), true);
  assert.equal(workflowIncidentRepo.listOpen().filter((incident) => incident.workflow_run_id === fixture.run.id).length, 1);
});

test('workflowIncidentRepo transitions incident state and stores decisions', () => {
  const fixture = createIncidentFixture();
  const incident = workflowIncidentRepo.upsertDetected({
    room_id: fixture.room.id,
    project_id: fixture.project.id,
    workflow_run_id: fixture.run.id,
    workflow_step_id: fixture.step.id,
    task_id: fixture.task.id,
    child_task_id: fixture.child.id,
    room_agent_id: fixture.agent.id,
    incident_type: 'agent_run_stale',
    error: 'agent run has not updated recently',
    context: { staleForMs: 120_000 },
  });

  assert.equal(workflowIncidentRepo.markDeciding(incident.id)?.status, 'deciding');
  assert.equal(workflowIncidentRepo.incrementAttempt(incident.id)?.attempt_count, 1);

  const executing = workflowIncidentRepo.markExecuting(incident.id, {
    action: 'retry_same_agent',
    reason: 'first stale run is recoverable',
    confidence: 0.8,
  });

  assert.equal(executing?.status, 'executing');
  assert.equal(executing?.action, 'retry_same_agent');
  assert.match(executing?.decision_json ?? '', /first stale run/);

  const resolved = workflowIncidentRepo.markResolved(incident.id, 'message-1');
  assert.equal(resolved?.status, 'resolved');
  assert.equal(resolved?.last_message_id, 'message-1');
  assert.ok(resolved?.resolved_at);
});

test('workflowIncidentRepo counts attempts for the same child task and incident type', () => {
  const fixture = createIncidentFixture();
  const secondStep = workflowRepo.createStep({
    workflow_run_id: fixture.run.id,
    task_id: fixture.child.id,
    stage: 'implementation',
    status: 'failed',
    room_agent_id: fixture.agent.id,
    assigned_room_agent_id: fixture.agent.id,
    prompt: 'retry child task',
    sort_order: 2,
  });
  const first = workflowIncidentRepo.upsertDetected({
    room_id: fixture.room.id,
    project_id: fixture.project.id,
    workflow_run_id: fixture.run.id,
    workflow_step_id: fixture.step.id,
    task_id: fixture.task.id,
    child_task_id: fixture.child.id,
    incident_type: 'child_task_failed',
    error: 'child failed',
    context: {},
  });
  const second = workflowIncidentRepo.upsertDetected({
    room_id: fixture.room.id,
    project_id: fixture.project.id,
    workflow_run_id: fixture.run.id,
    workflow_step_id: secondStep.id,
    task_id: fixture.task.id,
    child_task_id: fixture.child.id,
    incident_type: 'child_task_failed',
    error: 'child failed again',
    context: {},
  });
  workflowIncidentRepo.incrementAttempt(first.id);
  workflowIncidentRepo.incrementAttempt(first.id);
  workflowIncidentRepo.incrementAttempt(second.id);

  assert.equal(workflowIncidentRepo.countAttemptsForChild({
    workflowRunId: fixture.run.id,
    childTaskId: fixture.child.id,
    incidentType: 'child_task_failed',
  }), 3);
});
