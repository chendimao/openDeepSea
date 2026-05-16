import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-conversation-')), 'test.db');
process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';

const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowRepo } = await import('../repos/workflows.js');
const {
  approveWorkflowPlanWithConversation,
  setWorkflowConversationDeps,
  startWorkflowWithConversation,
} = await import('./conversation.js');
const { emptyAgentWorkflowState, serializeGraphState } = await import('./graph/state.js');

test.afterEach(() => {
  setWorkflowConversationDeps({});
});

test('startWorkflowWithConversation rejects cross-room task without writing a message', () => {
  const { room: roomA } = createRoomWithProject('Cross Room A');
  const { room: roomB, project: projectB } = createRoomWithProject('Cross Room B');
  const taskInRoomB = taskRepo.create({
    room_id: roomB.id,
    project_id: projectB.id,
    title: 'Room B task',
  });

  const before = messageRepo.listByRoom(roomA.id, 20).length;

  assert.throws(
    () => startWorkflowWithConversation({ roomId: roomA.id, taskId: taskInRoomB.id, source: 'task_button' }),
    /task room mismatch|not found/,
  );
  assert.equal(messageRepo.listByRoom(roomA.id, 20).length, before);
});

test('startWorkflowWithConversation rejects duplicate active workflow with 409-style error', () => {
  const { room, project } = createRoomWithProject('Duplicate Start');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Duplicate protected task',
  });
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const first = startWorkflowWithConversation({ roomId: room.id, taskId: task.id, source: 'task_button' });

  assert.throws(
    () => startWorkflowWithConversation({ roomId: room.id, taskId: task.id, source: 'task_button' }),
    (err) => {
      assert.equal((err as { status?: number }).status, 409);
      assert.match((err as Error).message, /active workflow|already has/);
      return true;
    },
  );
  const activeRuns = workflowRepo.listByTask(task.id).filter((run) => run.status === 'running');
  assert.equal(activeRuns.length, 1);
  assert.equal(activeRuns[0]?.id, first.id);
  assert.deepEqual(enqueued, [first.id]);

  const systemMessages = messageRepo.listByRoom(room.id, 20).filter((message) => message.sender_type === 'system');
  assert.ok(systemMessages.some((message) => /已有运行中的工作流|active workflow|already has/.test(message.content)));
});

test('approveWorkflowPlanWithConversation records approval and returns before later nodes run', () => {
  const { room, project } = createRoomWithProject('Approve Short Request');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Approval short request',
  });
  const pendingState = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState({
      ...pendingState,
      workflowRunId: 'pending',
      currentNode: 'approval',
      status: 'awaiting_approval',
      approval: 'pending',
    }),
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...pendingState,
    workflowRunId: run.id,
    currentNode: 'approval',
    status: 'awaiting_approval',
    approval: 'pending',
  }));
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const approved = approveWorkflowPlanWithConversation({
    roomId: room.id,
    workflowId: run.id,
    source: 'approval_button',
  });

  assert.equal(approved.status, 'running');
  assert.equal(approved.approved_by, 'user');
  assert.deepEqual(enqueued, [run.id]);
  const events = messageRepo
    .listByRoom(room.id, 20)
    .map((message) => (message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : {}));
  assert.ok(events.some((event) =>
    event.event_type === 'workflow_stage_changed' && event.workflow_run_id === run.id,
  ));
  assert.equal(workflowRepo.listSteps(run.id).some((step) => step.node_name === 'execute'), false);
});

function createRoomWithProject(name: string) {
  const projectPath = join(tmpdir(), `workflow-conversation-${name.replace(/\W+/g, '-')}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({
    name,
    path: projectPath,
  });
  const room = roomRepo.create({
    project_id: project.id,
    name: `${name} Room`,
  });
  return { project, room };
}
