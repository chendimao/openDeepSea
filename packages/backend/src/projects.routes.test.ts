import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-projects-routes-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { sessionAgentRuntimeRepo, sessionRepo, sessionRunRepo } = await import('./repos/sessions.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskExecutorRepo } = await import('./repos/task-executors.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { workflowRepo } = await import('./repos/workflows.js');
const { settingsRepo } = await import('./repos/settings.js');
const { db } = await import('./db.js');
const { runRegistry } = await import('./run-registry.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return dispatchExpressRequest(path, init);
}

test('delete project returns 404 for missing project', async () => {
  const res = await request('/api/projects/missing-project', { method: 'DELETE' });

  assert.equal(res.status, 404);
});

test('patch project supports pinned_at and rejects unknown fields', async () => {
  const { project } = createProjectFixture('patch-pinned');
  const pinnedAt = Date.now();
  const patchedRes = await request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned_at: pinnedAt }),
  });
  assert.equal(patchedRes.status, 200);
  const patched = await patchedRes.json() as { id: string; pinned_at: number | null };
  assert.equal(patched.id, project.id);
  assert.equal(patched.pinned_at, pinnedAt);

  const invalidRes = await request(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ unknown_field: true }),
  });
  assert.equal(invalidRes.status, 400);
});

test('reorder projects updates order and returns stats', async () => {
  const a = createProjectFixture('reorder-a').project;
  const b = createProjectFixture('reorder-b').project;
  const c = createProjectFixture('reorder-c').project;
  projectRepo.update(a.id, { pinned_at: 1 });
  projectRepo.update(b.id, { pinned_at: 2 });
  projectRepo.update(c.id, { pinned_at: null });

  const res = await request('/api/projects/reorder', {
    method: 'PUT',
    body: JSON.stringify({ ids: [b.id, a.id], pinned: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string; sort_order: number | null; stats: { rooms: number } }>;
  const bIndex = body.findIndex((item) => item.id === b.id);
  const aIndex = body.findIndex((item) => item.id === a.id);
  assert.ok(bIndex >= 0 && aIndex >= 0);
  assert.ok(bIndex < aIndex);
  const bRow = body.find((item) => item.id === b.id);
  const aRow = body.find((item) => item.id === a.id);
  assert.equal(bRow?.sort_order, 1);
  assert.equal(aRow?.sort_order, 2);
  assert.equal(typeof bRow?.stats.rooms, 'number');
});

test('delete project stops active agent runs before removing project', async () => {
  const { project, room } = createProjectFixture('active-agent-run');
  const { project: otherProject, room: otherRoom } = createProjectFixture('other-active-agent-run');
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'planner-delete-test', agent_name: 'Planner Delete Test' });
  const run = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    status: 'running',
    prompt: 'work',
  });
  const controller = runRegistry.create(run.id);
  const otherAgent = roomAgentRepo.add({
    room_id: otherRoom.id,
    agent_id: 'other-planner-delete-test',
    agent_name: 'Other Planner Delete Test',
  });
  const otherRun = agentRunRepo.create({
    room_id: otherRoom.id,
    room_agent_id: otherAgent.id,
    agent_id: otherAgent.agent_id,
    backend: 'codex',
    status: 'running',
    prompt: 'other work',
  });
  const otherController = runRegistry.create(otherRun.id);
  db.exec(`
    CREATE TEMP TABLE agent_run_delete_events (
      run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TEMP TRIGGER record_project_delete_agent_run_update
    AFTER UPDATE ON agent_runs
    WHEN old.status IN ('queued', 'running', 'retrying')
      AND new.status NOT IN ('queued', 'running', 'retrying')
    BEGIN
      INSERT INTO agent_run_delete_events (run_id, old_status, new_status, completed_at, error)
      VALUES (old.id, old.status, new.status, new.completed_at, new.error);
    END;
  `);

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(projectRepo.get(project.id), undefined);
  assert.equal(controller.signal.aborted, true);
  assert.equal(runRegistry.getAbortReason(run.id), 'cancelled');
  assert.equal(otherController.signal.aborted, false);
  assert.equal(agentRunRepo.get(otherRun.id)?.status, 'running');
  assert.notEqual(projectRepo.get(otherProject.id), undefined);
  const events = db.prepare('SELECT run_id, old_status, new_status, completed_at, error FROM agent_run_delete_events').all() as Array<{
    run_id: string;
    old_status: string;
    new_status: string;
    completed_at: number | null;
    error: string | null;
  }>;
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event);
  assert.deepEqual(event, {
    run_id: run.id,
    old_status: 'running',
    new_status: 'cancelled',
    completed_at: event.completed_at,
    error: 'Project deleted before run completed',
  });
  assert.equal(typeof event.completed_at, 'number');
});

test('delete project stops active workflow runs and tasks before removing project', async () => {
  const { project, room } = createProjectFixture('active-workflow-run');
  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: 'Workflow Task' });
  taskRepo.updateStatus(task.id, 'in_progress');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    status: 'running',
    sort_order: 1,
  });
  db.exec(`
    CREATE TEMP TABLE workflow_run_delete_events (
      run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TEMP TRIGGER record_project_delete_workflow_run_update
    AFTER UPDATE ON workflow_runs
    WHEN old.status IN ('draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked')
      AND new.status NOT IN ('draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked')
    BEGIN
      INSERT INTO workflow_run_delete_events (run_id, old_status, new_status, completed_at, error)
      VALUES (old.id, old.status, new.status, new.completed_at, new.error);
    END;
    CREATE TEMP TABLE workflow_step_delete_events (
      step_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TEMP TRIGGER record_project_delete_workflow_step_update
    AFTER UPDATE ON workflow_steps
    WHEN old.status IN ('pending', 'running', 'awaiting_approval')
      AND new.status NOT IN ('pending', 'running', 'awaiting_approval')
    BEGIN
      INSERT INTO workflow_step_delete_events (step_id, workflow_run_id, old_status, new_status, completed_at, error)
      VALUES (old.id, old.workflow_run_id, old.status, new.status, new.completed_at, new.error);
    END;
  `);

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(projectRepo.get(project.id), undefined);
  const runEvents = db.prepare('SELECT run_id, old_status, new_status, completed_at, error FROM workflow_run_delete_events').all() as Array<{
    run_id: string;
    old_status: string;
    new_status: string;
    completed_at: number | null;
    error: string | null;
  }>;
  assert.equal(runEvents.length, 1);
  const runEvent = runEvents[0];
  assert.ok(runEvent);
  assert.deepEqual(runEvent, {
    run_id: run.id,
    old_status: 'awaiting_approval',
    new_status: 'cancelled',
    completed_at: runEvent.completed_at,
    error: 'Project deleted before run completed',
  });
  assert.equal(typeof runEvent.completed_at, 'number');
  const stepEvents = db.prepare(`
    SELECT step_id, workflow_run_id, old_status, new_status, completed_at, error
    FROM workflow_step_delete_events
  `).all() as Array<{
    step_id: string;
    workflow_run_id: string;
    old_status: string;
    new_status: string;
    completed_at: number | null;
    error: string | null;
  }>;
  assert.equal(stepEvents.length, 1);
  const stepEvent = stepEvents[0];
  assert.ok(stepEvent);
  assert.deepEqual(stepEvent, {
    step_id: step.id,
    workflow_run_id: run.id,
    old_status: 'running',
    new_status: 'cancelled',
    completed_at: stepEvent.completed_at,
    error: 'Project deleted before run completed',
  });
  assert.equal(typeof stepEvent.completed_at, 'number');
  const remainingTask = taskRepo.getIncludingDeleted(task.id);
  assert.notEqual(remainingTask?.status, 'in_progress');
});

test('delete project stops running task executors before removing project', async () => {
  const { project, room } = createProjectFixture('active-task-executor');
  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'executor-delete-test', agent_name: 'Executor Delete Test' });
  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: 'Running Task Executor' });
  const executor = taskExecutorRepo.ensure({
    task_id: task.id,
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    acp_session_id: 'task-executor-session',
  });
  taskExecutorRepo.updateStatus(executor.id, 'running');
  db.exec(`
    CREATE TEMP TABLE task_executor_delete_events (
      executor_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL
    );
    CREATE TEMP TRIGGER record_project_delete_task_executor_update
    AFTER UPDATE ON task_executors
    WHEN old.status = 'running'
      AND new.status <> 'running'
    BEGIN
      INSERT INTO task_executor_delete_events (executor_id, task_id, old_status, new_status)
      VALUES (old.id, old.task_id, old.status, new.status);
    END;
  `);

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  const events = db.prepare(`
    SELECT executor_id, task_id, old_status, new_status
    FROM task_executor_delete_events
  `).all() as Array<{
    executor_id: string;
    task_id: string;
    old_status: string;
    new_status: string;
  }>;
  assert.deepEqual(events, [{
    executor_id: executor.id,
    task_id: task.id,
    old_status: 'running',
    new_status: 'failed',
  }]);
});

test('delete project stops active session runs before removing project', async () => {
  const { project } = createProjectFixture('active-session-run');
  const { project: otherProject } = createProjectFixture('other-active-session-run');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Active Session Run',
    provider: 'codex',
    mode: 'code',
  });
  const run = sessionRunRepo.create({
    agent_id: 'planner',
    session_id: session.id,
    provider: 'codex',
    status: 'running',
    mode: 'code',
    prompt: 'work',
  });
  const controller = runRegistry.create(run.id);
  sessionAgentRuntimeRepo.upsert({
    session_id: session.id,
    agent_id: run.agent_id,
    provider: run.provider,
    status: 'running',
    current_run_id: run.id,
  });
  const otherSession = sessionRepo.create({
    project_id: otherProject.id,
    title: 'Other Active Session Run',
    provider: 'codex',
    mode: 'code',
  });
  const otherRun = sessionRunRepo.create({
    session_id: otherSession.id,
    agent_id: 'planner',
    provider: 'codex',
    status: 'running',
    mode: 'code',
    prompt: 'other work',
  });
  const otherController = runRegistry.create(otherRun.id);
  db.exec(`
    CREATE TEMP TABLE session_run_delete_events (
      run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      completed_at INTEGER
    );
    CREATE TEMP TRIGGER record_project_delete_session_run_update
    AFTER UPDATE ON session_runs
    WHEN old.status IN ('queued', 'running', 'retrying', 'paused')
      AND new.status NOT IN ('queued', 'running', 'retrying', 'paused')
    BEGIN
      INSERT INTO session_run_delete_events (run_id, old_status, new_status, completed_at)
      VALUES (old.id, old.status, new.status, new.completed_at);
    END;
    CREATE TEMP TABLE session_runtime_delete_events (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      old_current_run_id TEXT,
      new_current_run_id TEXT
    );
    CREATE TEMP TRIGGER record_project_delete_session_runtime_update
    AFTER UPDATE ON session_agent_runtimes
    WHEN old.current_run_id IS NOT NULL
      AND new.current_run_id IS NULL
    BEGIN
      INSERT INTO session_runtime_delete_events (
        session_id, agent_id, provider, old_status, new_status, old_current_run_id, new_current_run_id
      )
      VALUES (
        old.session_id, old.agent_id, old.provider, old.status, new.status, old.current_run_id, new.current_run_id
      );
    END;
  `);

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(projectRepo.get(project.id), undefined);
  assert.equal(controller.signal.aborted, true);
  assert.equal(runRegistry.getAbortReason(run.id), 'cancelled');
  assert.equal(otherController.signal.aborted, false);
  assert.equal(sessionRunRepo.get(otherRun.id)?.status, 'running');
  assert.notEqual(projectRepo.get(otherProject.id), undefined);
  const events = db.prepare('SELECT run_id, old_status, new_status, completed_at FROM session_run_delete_events').all() as Array<{
    run_id: string;
    old_status: string;
    new_status: string;
    completed_at: number | null;
  }>;
  assert.equal(events.length, 1);
  const event = events[0];
  assert.ok(event);
  assert.deepEqual(event, {
    run_id: run.id,
    old_status: 'running',
    new_status: 'cancelled',
    completed_at: event.completed_at,
  });
  assert.equal(typeof event.completed_at, 'number');
  const runtimeEvents = db.prepare(`
    SELECT session_id, agent_id, provider, old_status, new_status, old_current_run_id, new_current_run_id
    FROM session_runtime_delete_events
  `).all() as Array<{
    session_id: string;
    agent_id: string;
    provider: string;
    old_status: string;
    new_status: string;
    old_current_run_id: string | null;
    new_current_run_id: string | null;
  }>;
  assert.deepEqual(runtimeEvents, [{
    session_id: session.id,
    agent_id: run.agent_id,
    provider: run.provider,
    old_status: 'running',
    new_status: 'idle',
    old_current_run_id: run.id,
    new_current_run_id: null,
  }]);
});

test('delete project resets stale session runtimes before removing project', async () => {
  const { project } = createProjectFixture('stale-session-runtime');
  const { project: otherProject } = createProjectFixture('other-stale-session-runtime');
  const session = sessionRepo.create({
    project_id: project.id,
    title: 'Stale Session Runtime',
    provider: 'codex',
    mode: 'code',
  });
  const otherSession = sessionRepo.create({
    project_id: otherProject.id,
    title: 'Other Stale Session Runtime',
    provider: 'codex',
    mode: 'code',
  });
  const runtime = sessionAgentRuntimeRepo.upsert({
    session_id: session.id,
    agent_id: 'planner',
    provider: 'codex',
    status: 'paused',
    current_run_id: null,
  });
  const otherRuntime = sessionAgentRuntimeRepo.upsert({
    session_id: otherSession.id,
    agent_id: 'planner',
    provider: 'codex',
    status: 'paused',
    current_run_id: null,
  });
  db.exec(`
    CREATE TEMP TABLE stale_session_runtime_delete_events (
      runtime_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      old_current_run_id TEXT,
      new_current_run_id TEXT
    );
    CREATE TEMP TRIGGER record_stale_session_runtime_delete_update
    AFTER UPDATE ON session_agent_runtimes
    WHEN old.status <> new.status
      OR COALESCE(old.current_run_id, '') <> COALESCE(new.current_run_id, '')
    BEGIN
      INSERT INTO stale_session_runtime_delete_events (
        runtime_id, session_id, old_status, new_status, old_current_run_id, new_current_run_id
      )
      VALUES (
        old.id, old.session_id, old.status, new.status, old.current_run_id, new.current_run_id
      );
    END;
  `);

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(projectRepo.get(project.id), undefined);
  assert.notEqual(projectRepo.get(otherProject.id), undefined);
  assert.deepEqual(
    db.prepare(`
      SELECT runtime_id, session_id, old_status, new_status, old_current_run_id, new_current_run_id
      FROM stale_session_runtime_delete_events
    `).all(),
    [{
      runtime_id: runtime.id,
      session_id: session.id,
      old_status: 'paused',
      new_status: 'idle',
      old_current_run_id: null,
      new_current_run_id: null,
    }],
  );
  assert.equal(sessionAgentRuntimeRepo.getByAgent(otherSession.id, otherRuntime.agent_id, otherRuntime.provider)?.status, 'paused');
});

test('delete project cancels active runs across sessions without touching another project', async () => {
  const { project, room } = createProjectFixture('all-active-run-types');
  const { project: otherProject, room: otherRoom } = createProjectFixture('all-active-run-types-other');
  const firstSession = sessionRepo.create({
    project_id: project.id,
    title: 'First Active Session Runs',
    provider: 'codex',
    mode: 'code',
  });
  const secondSession = sessionRepo.create({
    project_id: project.id,
    title: 'Second Active Session Runs',
    provider: 'codex',
    mode: 'code',
  });
  const otherSession = sessionRepo.create({
    project_id: otherProject.id,
    title: 'Other Active Session Run',
    provider: 'codex',
    mode: 'code',
  });
  const sessionRunInputs = [
    { sessionId: firstSession.id, status: 'queued' },
    { sessionId: firstSession.id, status: 'running' },
    { sessionId: secondSession.id, status: 'retrying' },
    { sessionId: secondSession.id, status: 'paused' },
  ] as const;
  const sessionRuns = sessionRunInputs.map(({ sessionId, status }) =>
    sessionRunRepo.create({
      agent_id: `agent-${status}`,
      session_id: sessionId,
      provider: 'codex',
      status,
      mode: 'code',
      prompt: `session ${status}`,
    }),
  );
  const [queuedSessionRun, runningSessionRun, retryingSessionRun, pausedSessionRun] = sessionRuns;
  const sessionControllers = sessionRuns.map((run) => runRegistry.create(run.id));
  const otherSessionRuns = ['queued', 'running', 'retrying', 'paused'].map((status) =>
    sessionRunRepo.create({
      session_id: otherSession.id,
      agent_id: `other-session-agent-${status}`,
      provider: 'codex',
      status: status as 'queued' | 'running' | 'retrying' | 'paused',
      mode: 'code',
      prompt: `other session ${status}`,
    }),
  );
  const [otherQueuedSessionRun, otherRunningSessionRun, otherRetryingSessionRun, otherPausedSessionRun] = otherSessionRuns;
  const otherSessionControllers = otherSessionRuns.map((run) => runRegistry.create(run.id));

  const agent = roomAgentRepo.add({ room_id: room.id, agent_id: 'project-agent', agent_name: 'Project Agent' });
  const agentRuns = ['queued', 'running', 'retrying'].map((status) =>
    agentRunRepo.create({
      room_id: room.id,
      room_agent_id: agent.id,
      agent_id: agent.agent_id,
      backend: 'codex',
      status: status as 'queued' | 'running' | 'retrying',
      prompt: `agent ${status}`,
    }),
  );
  const [queuedAgentRun, runningAgentRun, retryingAgentRun] = agentRuns;
  const agentControllers = agentRuns.map((run) => runRegistry.create(run.id));
  const otherAgent = roomAgentRepo.add({
    room_id: otherRoom.id,
    agent_id: 'other-project-agent',
    agent_name: 'Other Project Agent',
  });
  const otherAgentRuns = ['queued', 'running', 'retrying'].map((status) =>
    agentRunRepo.create({
      room_id: otherRoom.id,
      room_agent_id: otherAgent.id,
      agent_id: otherAgent.agent_id,
      backend: 'codex',
      status: status as 'queued' | 'running' | 'retrying',
      prompt: `other agent ${status}`,
    }),
  );
  const [otherQueuedAgentRun, otherRunningAgentRun, otherRetryingAgentRun] = otherAgentRuns;
  const otherAgentControllers = otherAgentRuns.map((run) => runRegistry.create(run.id));

  const task = taskRepo.create({ room_id: room.id, project_id: project.id, title: 'Workflow Task' });
  taskRepo.updateStatus(task.id, 'in_progress');
  const workflowRun = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
  });
  const workflowStep = workflowRepo.createStep({
    workflow_run_id: workflowRun.id,
    task_id: task.id,
    stage: 'implementation',
    status: 'awaiting_approval',
    sort_order: 1,
  });
  const executor = taskExecutorRepo.ensure({
    task_id: task.id,
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    acp_session_id: 'task-executor-session',
  });
  taskExecutorRepo.updateStatus(executor.id, 'running');

  const otherTask = taskRepo.create({ room_id: otherRoom.id, project_id: otherProject.id, title: 'Other Workflow Task' });
  taskRepo.updateStatus(otherTask.id, 'in_progress');
  const otherWorkflowRun = workflowRepo.createRun({
    room_id: otherRoom.id,
    project_id: otherProject.id,
    task_id: otherTask.id,
    status: 'running',
  });
  const otherWorkflowStep = workflowRepo.createStep({
    workflow_run_id: otherWorkflowRun.id,
    task_id: otherTask.id,
    stage: 'implementation',
    status: 'running',
    sort_order: 1,
  });
  const otherExecutor = taskExecutorRepo.ensure({
    task_id: otherTask.id,
    room_id: otherRoom.id,
    room_agent_id: otherAgent.id,
    agent_id: otherAgent.agent_id,
    acp_session_id: 'other-task-executor-session',
  });
  taskExecutorRepo.updateStatus(otherExecutor.id, 'running');

  db.exec(`
    CREATE TEMP TABLE all_active_delete_session_run_events (
      run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL
    );
    CREATE TEMP TRIGGER record_all_active_delete_session_run_update
    AFTER UPDATE ON session_runs
    WHEN old.status IN ('queued', 'running', 'retrying', 'paused')
      AND new.status NOT IN ('queued', 'running', 'retrying', 'paused')
    BEGIN
      INSERT INTO all_active_delete_session_run_events (run_id, old_status, new_status)
      VALUES (old.id, old.status, new.status);
    END;
    CREATE TEMP TABLE all_active_delete_agent_run_events (
      run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL
    );
    CREATE TEMP TRIGGER record_all_active_delete_agent_run_update
    AFTER UPDATE ON agent_runs
    WHEN old.status IN ('queued', 'running', 'retrying')
      AND new.status NOT IN ('queued', 'running', 'retrying')
    BEGIN
      INSERT INTO all_active_delete_agent_run_events (run_id, old_status, new_status)
      VALUES (old.id, old.status, new.status);
    END;
    CREATE TEMP TABLE all_active_delete_workflow_run_events (
      run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL
    );
    CREATE TEMP TRIGGER record_all_active_delete_workflow_run_update
    AFTER UPDATE ON workflow_runs
    WHEN old.status IN ('draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked')
      AND new.status NOT IN ('draft', 'running', 'awaiting_decision', 'awaiting_approval', 'blocked')
    BEGIN
      INSERT INTO all_active_delete_workflow_run_events (run_id, old_status, new_status)
      VALUES (old.id, old.status, new.status);
    END;
    CREATE TEMP TABLE all_active_delete_workflow_step_events (
      step_id TEXT NOT NULL,
      workflow_run_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL
    );
    CREATE TEMP TRIGGER record_all_active_delete_workflow_step_update
    AFTER UPDATE ON workflow_steps
    WHEN old.status IN ('pending', 'running', 'awaiting_approval')
      AND new.status NOT IN ('pending', 'running', 'awaiting_approval')
    BEGIN
      INSERT INTO all_active_delete_workflow_step_events (step_id, workflow_run_id, old_status, new_status)
      VALUES (old.id, old.workflow_run_id, old.status, new.status);
    END;
    CREATE TEMP TABLE all_active_delete_task_executor_events (
      executor_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL
    );
    CREATE TEMP TRIGGER record_all_active_delete_task_executor_update
    AFTER UPDATE ON task_executors
    WHEN old.status = 'running'
      AND new.status <> 'running'
    BEGIN
      INSERT INTO all_active_delete_task_executor_events (executor_id, task_id, old_status, new_status)
      VALUES (old.id, old.task_id, old.status, new.status);
    END;
  `);

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(projectRepo.get(project.id), undefined);
  assert.notEqual(projectRepo.get(otherProject.id), undefined);
  assert.deepEqual(sessionControllers.map((controller) => controller.signal.aborted), [true, true, true, true]);
  assert.deepEqual(agentControllers.map((controller) => controller.signal.aborted), [true, true, true]);
  assert.deepEqual(otherSessionControllers.map((controller) => controller.signal.aborted), [false, false, false, false]);
  assert.deepEqual(otherAgentControllers.map((controller) => controller.signal.aborted), [false, false, false]);
  assert.deepEqual(otherSessionRuns.map((run) => sessionRunRepo.get(run.id)?.status), [
    'queued',
    'running',
    'retrying',
    'paused',
  ]);
  assert.deepEqual(sessionRunRepo.get(otherQueuedSessionRun!.id)?.status, 'queued');
  assert.deepEqual(sessionRunRepo.get(otherRunningSessionRun!.id)?.status, 'running');
  assert.deepEqual(sessionRunRepo.get(otherRetryingSessionRun!.id)?.status, 'retrying');
  assert.deepEqual(sessionRunRepo.get(otherPausedSessionRun!.id)?.status, 'paused');
  assert.deepEqual(otherAgentRuns.map((run) => agentRunRepo.get(run.id)?.status), ['queued', 'running', 'retrying']);
  assert.deepEqual(agentRunRepo.get(otherQueuedAgentRun!.id)?.status, 'queued');
  assert.deepEqual(agentRunRepo.get(otherRunningAgentRun!.id)?.status, 'running');
  assert.deepEqual(agentRunRepo.get(otherRetryingAgentRun!.id)?.status, 'retrying');
  assert.equal(workflowRepo.getRun(otherWorkflowRun.id)?.status, 'running');
  assert.equal(workflowRepo.getStep(otherWorkflowStep.id)?.status, 'running');
  assert.equal(taskExecutorRepo.get(otherExecutor.id)?.status, 'running');

  const sessionEvents = db.prepare(`
    SELECT run_id, old_status, new_status
    FROM all_active_delete_session_run_events
    ORDER BY old_status ASC
  `).all() as Array<{ run_id: string; old_status: string; new_status: string }>;
  assert.deepEqual(sessionEvents, [
    { run_id: pausedSessionRun!.id, old_status: 'paused', new_status: 'cancelled' },
    { run_id: queuedSessionRun!.id, old_status: 'queued', new_status: 'cancelled' },
    { run_id: retryingSessionRun!.id, old_status: 'retrying', new_status: 'cancelled' },
    { run_id: runningSessionRun!.id, old_status: 'running', new_status: 'cancelled' },
  ]);
  assert.deepEqual(
    db.prepare(`
      SELECT run_id, old_status, new_status
      FROM all_active_delete_agent_run_events
      ORDER BY old_status ASC
    `).all(),
    [
      { run_id: queuedAgentRun!.id, old_status: 'queued', new_status: 'cancelled' },
      { run_id: retryingAgentRun!.id, old_status: 'retrying', new_status: 'cancelled' },
      { run_id: runningAgentRun!.id, old_status: 'running', new_status: 'cancelled' },
    ],
  );
  assert.deepEqual(
    db.prepare('SELECT run_id, old_status, new_status FROM all_active_delete_workflow_run_events').all(),
    [{ run_id: workflowRun.id, old_status: 'running', new_status: 'cancelled' }],
  );
  assert.deepEqual(
    db.prepare('SELECT step_id, workflow_run_id, old_status, new_status FROM all_active_delete_workflow_step_events').all(),
    [{
      step_id: workflowStep.id,
      workflow_run_id: workflowRun.id,
      old_status: 'awaiting_approval',
      new_status: 'cancelled',
    }],
  );
  assert.deepEqual(
    db.prepare('SELECT executor_id, task_id, old_status, new_status FROM all_active_delete_task_executor_events').all(),
    [{ executor_id: executor.id, task_id: task.id, old_status: 'running', new_status: 'failed' }],
  );
});

test('delete project removes internal records and scoped settings only', async () => {
  const { project, room, projectPath } = createProjectFixture('delete-success');
  settingsRepo.updateProject(project.id, { auto_distill_enabled: false });
  settingsRepo.updateRoom(room.id, { auto_distill_enabled: true });

  const res = await request(`/api/projects/${project.id}`, { method: 'DELETE' });

  assert.equal(res.status, 204);
  assert.equal(projectRepo.get(project.id), undefined);
  assert.equal(roomRepo.get(room.id), undefined);
  assert.equal(settingsRepo.getProject(project.id), null);
  assert.equal(settingsRepo.getRoom(room.id), null);
  const settings = db.prepare('SELECT COUNT(*) AS count FROM settings WHERE scope_id IN (?, ?)').get(project.id, room.id) as { count: number };
  const projects = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE path = ?').get(projectPath) as { count: number };
  assert.equal(settings.count, 0);
  assert.equal(projects.count, 0);
  assert.equal(projectPath.startsWith(tmpdir()), true);
});

function createProjectFixture(name: string) {
  const projectPath = mkdtempSync(join(tmpdir(), `openclaw-room-project-delete-${name}-`));
  const project = projectRepo.create({ name: `Project Delete ${name}`, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  return { project, room, projectPath };
}

function dispatchExpressRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? Buffer.from(init.body) : null;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const req = new IncomingMessage(socket as unknown as Socket);
    req.method = method;
    req.url = path;
    req.headers = {
      'content-type': 'application/json',
      ...(body ? { 'content-length': String(body.length) } : {}),
      ...headersInitToRecord(init.headers),
    };

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];

    res.write = ((chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
      if (chunk) chunks.push(toBuffer(chunk, encoding));
      callback?.();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encoding?: BufferEncoding, callback?: () => void) => {
      if (chunk) chunks.push(toBuffer(chunk, encoding));
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, String(item));
        } else if (value !== undefined) {
          headers.set(key, String(value));
        }
      }
      const emptyBodyStatus = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
      resolve(new Response(emptyBodyStatus ? null : Buffer.concat(chunks), {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers,
      }));
      callback?.();
      return res;
    }) as typeof res.end;

    (app as unknown as {
      handle: (request: IncomingMessage, response: ServerResponse, done: (error?: unknown) => void) => void;
    }).handle(req, res, (error: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Response(null, { status: 404 }));
    });
    if (body) req.push(body);
    req.push(null);
  });
}

function headersInitToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding);
}
