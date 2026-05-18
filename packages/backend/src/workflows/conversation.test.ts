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
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '1';
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
  const plan = {
    goal: task.title,
    summary: 'Approval short request plan.',
    assumptions: [],
    tasks: [],
    reviewFocus: [],
    verification: [],
    verificationCommands: [],
    risks: [],
    needsApproval: true,
  };
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
      plan,
      currentNode: 'approval',
      status: 'awaiting_approval',
      approval: 'pending',
    }),
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...pendingState,
    workflowRunId: run.id,
    plan,
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

test('startWorkflowWithConversation rolls back intent message when graph run creation fails', () => {
  const { room, project } = createRoomWithProject('Start Rollback');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Rollback start intent',
  });
  setWorkflowConversationDeps({
    createGraphWorkflowRun: () => {
      throw new Error('graph create exploded');
    },
  });

  const before = messageRepo.listByRoom(room.id, 20).length;

  assert.throws(
    () => startWorkflowWithConversation({ roomId: room.id, taskId: task.id, source: 'task_button' }),
    /graph create exploded/,
  );
  assert.equal(messageRepo.listByRoom(room.id, 20).length, before);
  assert.equal(workflowRepo.listByTask(task.id).length, 0);
});

test('approveWorkflowPlanWithConversation validates graph state before writing approval message', () => {
  const { room, project } = createRoomWithProject('Approve Rollback');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Rollback approval intent',
  });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'awaiting_approval',
    current_stage: 'planning',
    graph_version: 'phase-b-v1',
    graph_state: '{"invalid"',
  });
  const before = messageRepo.listByRoom(room.id, 20).length;

  assert.throws(
    () => approveWorkflowPlanWithConversation({ roomId: room.id, workflowId: run.id, source: 'approval_button' }),
    /graph state is invalid/,
  );
  assert.equal(messageRepo.listByRoom(room.id, 20).length, before);
  assert.equal(workflowRepo.getRun(run.id)?.status, 'blocked');
});

test('approveWorkflowPlanWithConversation blocks missing plan before writing approval message', () => {
  const { room, project } = createRoomWithProject('Approve Missing Plan');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Missing plan approval',
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
  const before = messageRepo.listByRoom(room.id, 20).length;

  assert.throws(
    () => approveWorkflowPlanWithConversation({ roomId: room.id, workflowId: run.id, source: 'approval_button' }),
    /requires generated plan/,
  );
  const latest = workflowRepo.getRun(run.id);
  assert.equal(messageRepo.listByRoom(room.id, 20).length, before);
  assert.equal(latest?.status, 'blocked');
  assert.match(latest?.error ?? '', /requires generated plan/);
});

test('approveWorkflowPlanWithConversation rolls back intent message when approval update fails', () => {
  const { room, project } = createRoomWithProject('Approve Update Rollback');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Rollback approval update',
  });
  const pendingState = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: project.id,
    roomId: room.id,
    taskId: task.id,
    userGoal: task.title,
    projectPath: project.path,
  });
  const plan = {
    goal: task.title,
    summary: 'Approval update rollback plan.',
    assumptions: [],
    tasks: [],
    reviewFocus: [],
    verification: [],
    verificationCommands: [],
    risks: [],
    needsApproval: true,
  };
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
      plan,
      currentNode: 'approval',
      status: 'awaiting_approval',
      approval: 'pending',
    }),
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState({
    ...pendingState,
    workflowRunId: run.id,
    plan,
    currentNode: 'approval',
    status: 'awaiting_approval',
    approval: 'pending',
  }));
  setWorkflowConversationDeps({
    approveGraphWorkflowPlan: () => {
      throw new Error('approval update exploded');
    },
  });
  const before = messageRepo.listByRoom(room.id, 20).length;

  assert.throws(
    () => approveWorkflowPlanWithConversation({ roomId: room.id, workflowId: run.id, source: 'approval_button' }),
    /approval update exploded/,
  );
  assert.equal(messageRepo.listByRoom(room.id, 20).length, before);
  assert.equal(workflowRepo.getRun(run.id)?.status, 'awaiting_approval');
});

test('startWorkflowWithConversation replays same source message as the original workflow run', () => {
  const { room, project } = createRoomWithProject('Source Replay');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Replay source command',
  });
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: `/start-task ${task.id}`,
    message_type: 'text',
  });
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const first = startWorkflowWithConversation({
    roomId: room.id,
    taskId: task.id,
    source: 'chat_command',
    sourceMessageId: sourceMessage.id,
    content: sourceMessage.content,
  });
  const messagesAfterFirst = messageRepo.listByRoom(room.id, 20);

  const replayed = startWorkflowWithConversation({
    roomId: room.id,
    taskId: task.id,
    source: 'chat_command',
    sourceMessageId: sourceMessage.id,
    content: sourceMessage.content,
  });

  assert.equal(replayed.id, first.id);
  assert.equal(workflowRepo.listByTask(task.id).length, 1);
  assert.deepEqual(enqueued, [first.id]);
  assert.equal(messageRepo.listByRoom(room.id, 20).length, messagesAfterFirst.length);
  assert.equal(
    messageRepo.listByRoom(room.id, 20).some((message) => /已有运行中的工作流/.test(message.content)),
    false,
  );
});

test('startWorkflowWithConversation replays source message after a long room history', () => {
  const { room, project } = createRoomWithProject('Source Replay Long History');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Replay source command with long history',
  });
  for (let index = 0; index < 501; index += 1) {
    messageRepo.create({
      room_id: room.id,
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: `filler ${index}`,
      message_type: 'text',
    });
  }
  const sourceMessage = messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: `/start-task ${task.id}`,
    message_type: 'text',
  });
  const enqueued: string[] = [];
  setWorkflowConversationDeps({
    enqueueGraphWorkflow: (runId) => {
      enqueued.push(runId);
    },
  });

  const first = startWorkflowWithConversation({
    roomId: room.id,
    taskId: task.id,
    source: 'chat_command',
    sourceMessageId: sourceMessage.id,
    content: sourceMessage.content,
  });
  const messagesAfterFirst = messageRepo.listByRoom(room.id, 1000);

  const replayed = startWorkflowWithConversation({
    roomId: room.id,
    taskId: task.id,
    source: 'chat_command',
    sourceMessageId: sourceMessage.id,
    content: sourceMessage.content,
  });

  assert.equal(replayed.id, first.id);
  assert.equal(workflowRepo.listByTask(task.id).length, 1);
  assert.deepEqual(enqueued, [first.id]);
  assert.equal(messageRepo.listByRoom(room.id, 1000).length, messagesAfterFirst.length);
  assert.equal(
    messageRepo.listByRoom(room.id, 1000).some((message) => /已有运行中的工作流/.test(message.content)),
    false,
  );
});

test('startWorkflowWithConversation rejects graph-disabled start without writing messages', () => {
  const { room, project } = createRoomWithProject('Graph Disabled');
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Graph disabled start',
  });
  process.env.LANGGRAPH_WORKFLOW_ENABLED = '0';
  const before = messageRepo.listByRoom(room.id, 20).length;

  assert.throws(
    () => startWorkflowWithConversation({ roomId: room.id, taskId: task.id, source: 'task_button' }),
    (err) => {
      assert.equal((err as { status?: number }).status, 400);
      assert.match((err as Error).message, /LangGraph workflow is not enabled/);
      return true;
    },
  );
  assert.equal(messageRepo.listByRoom(room.id, 20).length, before);
  assert.equal(workflowRepo.listByTask(task.id).length, 0);
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
