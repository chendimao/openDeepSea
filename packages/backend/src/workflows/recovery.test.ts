import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-room-recovery-'));
const projectOneDir = join(tempDir, 'project-one');
const projectTwoDir = join(tempDir, 'project-two');
mkdirSync(projectOneDir);
mkdirSync(projectTwoDir);
process.env.OPENCLAW_ROOM_DB = join(tempDir, 'test.db');

const { agentRunRepo } = await import('../repos/agent-runs.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { workflowOrchestrator } = await import('./orchestrator.js');

test('interruptRun marks an active agent run as interrupted with retry context preserved', () => {
  const project = projectRepo.create({ name: 'Test', path: projectOneDir });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const agent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'codex-agent',
    agent_name: 'Codex Agent',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Recover agent run',
  });
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    current_stage: 'implementation',
  });
  const step = workflowRepo.createStep({
    workflow_run_id: workflow.id,
    task_id: task.id,
    stage: 'implementation',
    status: 'running',
    room_agent_id: agent.id,
    prompt: 'implement',
    sort_order: 1,
  });
  const run = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    acp_session_id: 'session-123',
    task_id: task.id,
    workflow_run_id: workflow.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'implement',
  });

  const updated = agentRunRepo.interruptRun(run.id, 'Backend restarted before agent run completed');

  assert.equal(updated?.status, 'interrupted');
  assert.equal(updated?.workflow_run_id, workflow.id);
  assert.equal(updated?.workflow_step_id, step.id);
  assert.equal(updated?.acp_session_id, 'session-123');
  assert.match(updated?.stderr ?? '', /Backend restarted/);
  workflowRepo.updateStep(step.id, { status: 'interrupted' });
});

test('recoverOrphanedSteps marks running workflow steps as interrupted and blocks workflow for retry', () => {
  const project = projectRepo.create({ name: 'Test 2', path: projectTwoDir });
  const room = roomRepo.create({ project_id: project.id, name: 'Room 2' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Recover workflow step',
  });
  taskRepo.updateStatus(task.id, 'in_progress');
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    current_stage: 'implementation',
  });
  const step = workflowRepo.createStep({
    workflow_run_id: workflow.id,
    task_id: task.id,
    stage: 'implementation',
    status: 'running',
    prompt: 'implement',
    sort_order: 1,
  });

  const count = workflowOrchestrator.recoverOrphanedSteps('Backend restarted before workflow step completed');
  const updatedStep = workflowRepo.getStep(step.id);
  const updatedWorkflow = workflowRepo.getRun(workflow.id);
  const updatedTask = taskRepo.get(task.id);

  assert.equal(count, 1);
  assert.equal(updatedStep?.status, 'interrupted');
  assert.equal(updatedStep?.error, 'Backend restarted before workflow step completed');
  assert.equal(updatedWorkflow?.status, 'blocked');
  assert.equal(updatedTask?.status, 'in_progress');
});
