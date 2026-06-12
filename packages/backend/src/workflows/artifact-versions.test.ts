import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-artifact-version-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowArtifactVersionRepo, workflowRepo } = await import('../repos/workflows.js');

function createWorkflowFixture(label: string) {
  const project = projectRepo.create({
    name: `Artifact Version Project ${label}`,
    path: mkdtempSync(join(tmpdir(), 'opendeepsea-artifact-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: `Artifact Version Room ${label}` });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: `Artifact Version Task ${label}`,
  });
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'planning',
  });
  return { project, room, task, workflow };
}

test('workflow artifact versions supersede confirmed plan when planner creates a new draft', () => {
  const { workflow } = createWorkflowFixture('supersede');
  const v1 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v1',
    structured_data: { tasks: [{ id: 'task-1' }] },
    created_by_agent_id: 'planner',
  });
  const approved = workflowArtifactVersionRepo.approve(v1.id, {
    approved_by: 'user',
    approval_message_id: 'msg-confirm-1',
  });

  assert.equal(approved?.status, 'approved');
  assert.equal(workflowArtifactVersionRepo.getApproved(workflow.id, 'plan')?.id, v1.id);

  const v2 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v2',
    structured_data: { tasks: [{ id: 'task-1' }, { id: 'task-2' }] },
    created_by_agent_id: 'planner',
    change_request_message_id: 'msg-change-1',
    supersedes_artifact_version_id: v1.id,
  });

  assert.equal(v2.version, 2);
  assert.equal(workflowArtifactVersionRepo.get(v1.id)?.status, 'superseded');
  assert.equal(workflowArtifactVersionRepo.getApproved(workflow.id, 'plan'), null);
});

test('superseded artifact version cannot be approved again', () => {
  const { workflow } = createWorkflowFixture('stale-approval');
  const v1 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v1',
    created_by_agent_id: 'planner',
  });
  assert.equal(workflowArtifactVersionRepo.approve(v1.id, { approved_by: 'user' })?.status, 'approved');
  workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v2',
    created_by_agent_id: 'planner',
    supersedes_artifact_version_id: v1.id,
  });

  assert.equal(workflowArtifactVersionRepo.approve(v1.id, { approved_by: 'user' }), null);
  assert.equal(workflowArtifactVersionRepo.get(v1.id)?.status, 'superseded');
  assert.equal(workflowArtifactVersionRepo.getApproved(workflow.id, 'plan'), null);
});

test('supersedes id must belong to the same workflow run and artifact type', () => {
  const first = createWorkflowFixture('first');
  const second = createWorkflowFixture('second');
  const otherRunPlan = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: first.workflow.id,
    artifact_type: 'plan',
    title: 'Other Run Plan',
    content: '# Other Run Plan',
    created_by_agent_id: 'planner',
  });
  const sameRunSpec = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: second.workflow.id,
    artifact_type: 'spec',
    title: 'Spec',
    content: '# Spec',
    created_by_agent_id: 'planner',
  });

  assert.throws(() => workflowArtifactVersionRepo.createDraft({
    workflow_run_id: second.workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan',
    created_by_agent_id: 'planner',
    supersedes_artifact_version_id: otherRunPlan.id,
  }), /same workflow run and artifact type/);
  assert.throws(() => workflowArtifactVersionRepo.createDraft({
    workflow_run_id: second.workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan',
    created_by_agent_id: 'planner',
    supersedes_artifact_version_id: sameRunSpec.id,
  }), /same workflow run and artifact type/);
  assert.equal(workflowArtifactVersionRepo.get(otherRunPlan.id)?.status, 'draft');
  assert.equal(workflowArtifactVersionRepo.get(sameRunSpec.id)?.status, 'draft');
});

test('workflow artifact versions keep one version number per run and type', () => {
  const { workflow } = createWorkflowFixture('unique-version');
  const v1 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v1',
    structured_data: { tasks: [{ id: 'task-1' }] },
    created_by_agent_id: 'planner',
  });
  const v2 = workflowArtifactVersionRepo.createDraft({
    workflow_run_id: workflow.id,
    artifact_type: 'plan',
    title: 'Plan',
    content: '# Plan v2',
    structured_data: { tasks: [{ id: 'task-2' }] },
    created_by_agent_id: 'planner',
  });

  assert.deepEqual(workflowArtifactVersionRepo.listByRun(workflow.id).map((item) => item.version), [1, 2]);
  assert.equal(v1.structured_data, JSON.stringify({ tasks: [{ id: 'task-1' }] }));
  assert.equal(v2.structured_data, JSON.stringify({ tasks: [{ id: 'task-2' }] }));
});
