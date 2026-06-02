import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-actions-')), 'test.db');

const { agentRepo } = await import('./repos/agents.js');
const { agentRunRepo } = await import('./repos/agent-runs.js');
const { messageRepo } = await import('./repos/messages.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('./repos/rooms.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { taskRepo } = await import('./repos/tasks.js');
const { startTaskAction } = await import('./task-actions.js');

test('start_execution action creates a locked roster with executor reviewer and acceptor', async () => {
  const project = projectRepo.create({
    name: '四入口固定编队',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-fixed-roster-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '修复后端搜索',
    description: '实现 @docs/super 子目录搜索',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    senderId: 'user',
    senderName: 'You',
    runAgent: async () => ({ status: 'completed', content: '完成', error: null }),
  });

  assert.equal(result.action, 'start_execution');
  assert.notEqual(result.status, 'blocked');
  assert.equal(result.workflow?.locked, true);
  assert.deepEqual(result.workflow?.agents.map((agent) => agent.role).sort(), ['acceptor', 'executor', 'reviewer']);
  assert.deepEqual(result.workflow?.stages.map((stage) => stage.id), ['execute', 'review', 'acceptance']);
  assert.ok(result.message_id);
  const message = messageRepo.get(result.message_id);
  assert.equal(message?.layer, 'timeline');
  const events = taskEventRepo.listByTask(task.id, { limit: 5 });
  const actionEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === result.status
  );
  assert.equal(actionEvent?.payload.event_message_id, result.message_id);
  assert.equal(actionEvent?.payload.task_title, task.title);
});

test('start_execution does not use a disabled reviewer in locked roster', async () => {
  const project = projectRepo.create({
    name: '禁用审查员',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-disabled-reviewer-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  const reviewer = agentRepo.getByAgentId('reviewer');
  assert.ok(backend);
  assert.ok(reviewer);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const reviewerRoomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: reviewer.id });
  roomAgentRepo.setAcp(reviewerRoomAgent.id, {
    acp_enabled: false,
    acp_backend: null,
    acp_session_id: null,
    acp_session_label: null,
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '需要审查',
    description: '禁用 reviewer 不能进入 roster',
    priority: 'normal',
    interaction_mode: 'ask_user',
    source_message_id: null,
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /no executable reviewer agent available/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  assert.ok(events.some((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'running'
  ));
  const blockedEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'blocked'
  );
  assert.equal(blockedEvent?.payload.event_message_id, result.message_id);
  assert.match(String(blockedEvent?.payload.blocked_reason ?? ''), /no executable reviewer agent available/u);
});

test('start_execution runs only locked roster stages and never adds planner requested agents mid-run', async () => {
  const project = projectRepo.create({
    name: '锁定编队禁止中途扩编',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-no-mid-agent-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '实现搜索',
    description: '执行中不得新增 review-validator',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  const calls: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async ({ agent, prompt }) => {
      calls.push(agent.agent_id);
      assert.match(prompt, /已锁定完整 roster/u);
      return {
        status: 'completed',
        content: agent.workflow_role === 'executor'
          ? '实现完成。```json\n{"task_execution":{"state":"ready_to_execute","status":"suggested","summary":"错误地新增验证智能体","next_steps":[{"agent_id":"review-validator","goal":"验证"}]}}\n```'
          : '阶段完成',
        error: null,
        runId: `run-${agent.agent_id}`,
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['backend-executor', 'reviewer', 'acceptor']);
  assert.deepEqual(result.run_ids, ['run-backend-executor', 'run-reviewer', 'run-acceptor']);
  assert.equal(roomAgentRepo.listByRoom(room.id).some((agent) => agent.agent_id === 'review-validator'), false);
});

test('start_execution records failed event when a locked roster stage throws', async () => {
  const project = projectRepo.create({
    name: '固定编队失败事件',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-stage-throw-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '阶段失败',
    description: 'runner 抛错时必须写 failed 事件',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  const calls: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async ({ agent }) => {
      calls.push(agent.agent_id);
      if (agent.workflow_role === 'reviewer') {
        throw new Error('runner exploded');
      }
      return {
        status: 'completed',
        content: '执行阶段完成',
        error: null,
        runId: `run-${agent.agent_id}`,
      };
    },
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['backend-executor', 'reviewer']);
  assert.deepEqual(result.run_ids, ['run-backend-executor']);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const failedEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'failed'
  );
  assert.match(String(failedEvent?.payload.error ?? ''), /runner exploded/u);
  assert.equal(failedEvent?.payload.event_message_id, result.message_id);
});

test('start_execution blocks when a locked room agent is removed during execution', async () => {
  const project = projectRepo.create({
    name: '固定 room agent id',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-locked-room-agent-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '执行中替换 reviewer',
    description: '启动后锁定成员不可用时必须阻塞',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  const calls: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async ({ agent }) => {
      calls.push(agent.agent_id);
      if (agent.workflow_role === 'executor') {
        const lockedReviewer = roomAgentRepo.listByRoom(room.id).find((candidate) =>
          candidate.workflow_role === 'reviewer'
        );
        assert.ok(lockedReviewer);
        roomAgentRepo.remove(lockedReviewer.id);
      }
      return {
        status: 'completed',
        content: '执行阶段完成',
        error: null,
        runId: `run-${agent.id}`,
      };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(calls, ['backend-executor']);
  assert.deepEqual(result.run_ids.length, 1);
  assert.match(result.blocked_reason ?? '', /locked roster agent unavailable: reviewer/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const blockedEvent = events.find((event) =>
    event.payload.action === 'start_execution' &&
    event.payload.status === 'blocked'
  );
  assert.match(String(blockedEvent?.payload.blocked_reason ?? ''), /locked roster agent unavailable: reviewer/u);
});

test('startTaskAction blocks when task already has an active agent run', async () => {
  const project = projectRepo.create({
    name: '已有运行任务',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-active-task-run-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '已有运行中的任务',
  });
  const activeRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: roomAgent.agent_id,
    backend: 'codex',
    task_id: task.id,
    status: 'running',
    prompt: 'running',
  });

  let called = false;
  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async () => {
      called = true;
      return { status: 'completed', content: '完成', error: null };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.run_ids, [activeRun.id]);
  assert.match(result.blocked_reason ?? '', /运行中/u);
  assert.equal(called, false);
});

test('startTaskAction blocks duplicate action when latest action event is still running', async () => {
  const project = projectRepo.create({
    name: '重复动作保护',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-running-action-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '重复启动动作',
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'start_execution',
      status: 'running',
      task_action: 'start_execution',
      task_action_status: 'running',
    },
  });

  let called = false;
  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'start_execution',
    runAgent: async () => {
      called = true;
      return { status: 'completed', content: '完成', error: null };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /正在运行/u);
  assert.equal(called, false);
});

test('writing_plans action blocks when task has no design spec', async () => {
  const project = projectRepo.create({
    name: '计划缺少 spec',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-plan-no-spec-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '写计划',
    description: '没有 spec 时应阻塞',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });

  const result = await startTaskAction({ roomId: room.id, taskId: task.id, action: 'writing_plans' });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /头脑风暴|spec/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  assert.ok(events.some((event) =>
    event.payload.action === 'writing_plans' &&
    event.payload.status === 'running'
  ));
  const blockedEvent = events.find((event) =>
    event.payload.action === 'writing_plans' &&
    event.payload.status === 'blocked'
  );
  assert.equal(blockedEvent?.payload.event_message_id, result.message_id);
  assert.equal(blockedEvent?.payload.superpowers_phase, 'writing_plans');
});

test('brainstorming action dispatches planner with superpowers brainstorming prompt', async () => {
  const project = projectRepo.create({
    name: '头脑风暴动作',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorm-action-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '澄清四入口',
    description: '需要 brainstorming spec',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  let prompt = '';

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'brainstorming',
    runAgent: async (input) => {
      prompt = input.prompt;
      return {
        status: 'completed',
        content: '```json\n{"example":true}\n```\n```json\n{"superpowers":{"designDocPath":"docs/superpowers/specs/test-design.md","designReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-brainstorming',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.match(prompt, /brainstorming/u);
  assert.match(prompt, /Skill: superpowers:brainstorming/u);
  assert.deepEqual(result.run_ids, ['run-brainstorming']);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const completedEvent = events.find((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'completed'
  );
  assert.equal(completedEvent?.payload.event_message_id, result.message_id);
  assert.equal((completedEvent?.payload.evidence as { designDocPath?: string } | undefined)?.designDocPath, 'docs/superpowers/specs/test-design.md');
});

test('brainstorming action fails when completed output has no design doc evidence', async () => {
  const project = projectRepo.create({
    name: '头脑风暴缺 evidence',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorm-no-evidence-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '缺少设计文档',
    description: 'completed 输出没有 designDocPath 时不能算完成',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'brainstorming',
    runAgent: async () => ({
      status: 'completed',
      content: '```json\n{"superpowers":{"designReviewVerdict":"approved"}}\n```',
      error: null,
      runId: 'run-brainstorming-no-evidence',
    }),
  });

  assert.equal(result.status, 'failed');
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const failedEvent = events.find((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'failed'
  );
  assert.match(String(failedEvent?.payload.error ?? ''), /designDocPath/u);
});

test('writing_plans ignores unmarked design spec evidence', async () => {
  const project = projectRepo.create({
    name: '忽略未标记 spec',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-plan-unmarked-spec-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '未标记 spec',
    description: '非 task action evidence 不能放行',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'brainstorming',
      status: 'completed',
      evidence: { designDocPath: 'docs/superpowers/specs/unmarked-design.md' },
    },
  });

  const result = await startTaskAction({ roomId: room.id, taskId: task.id, action: 'writing_plans' });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /头脑风暴|spec/u);
});

test('writing_plans action dispatches planner after brainstorming spec evidence', async () => {
  const project = projectRepo.create({
    name: '已有 spec 写计划',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-plan-with-spec-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '写实施计划',
    description: '已有 brainstorming spec 时应运行 writing-plans',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  for (let index = 0; index < 501; index += 1) {
    taskEventRepo.create({
      room_id: room.id,
      task_id: task.id,
      type: 'task_updated',
      layer: 'timeline',
      payload: {
        action: 'brainstorming',
        status: 'completed',
        evidence: { designDocPath: `docs/superpowers/specs/unmarked-${index}.md` },
      },
    });
  }
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'brainstorming',
      status: 'completed',
      task_action: 'brainstorming',
      task_action_status: 'completed',
      evidence: { designDocPath: 'docs/superpowers/specs/test-design.md' },
    },
  });
  let prompt = '';

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'writing_plans',
    runAgent: async (input) => {
      prompt = input.prompt;
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"implementationPlanPath":"docs/superpowers/plans/test-plan.md","planReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-writing-plans',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.match(prompt, /writing_plans/u);
  assert.match(prompt, /Skill: superpowers:writing-plans/u);
  assert.deepEqual(result.run_ids, ['run-writing-plans']);
  const events = taskEventRepo.listByTask(task.id, { limit: 1000 });
  const completedEvent = events.find((event) =>
    event.payload.action === 'writing_plans' &&
    event.payload.status === 'completed'
  );
  assert.equal((completedEvent?.payload.evidence as { implementationPlanPath?: string } | undefined)?.implementationPlanPath, 'docs/superpowers/plans/test-plan.md');
});

test('writing_plans action fails when completed output has no implementation plan evidence', async () => {
  const project = projectRepo.create({
    name: '写计划缺 evidence',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-plan-no-evidence-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '缺少实施计划',
    description: 'completed 输出没有 implementationPlanPath 时不能算完成',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'brainstorming',
      status: 'completed',
      task_action: 'brainstorming',
      task_action_status: 'completed',
      evidence: { designDocPath: 'docs/superpowers/specs/test-design.md' },
    },
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'writing_plans',
    runAgent: async () => ({
      status: 'completed',
      content: '```json\n{"superpowers":{"planReviewVerdict":"approved"}}\n```',
      error: null,
      runId: 'run-writing-no-evidence',
    }),
  });

  assert.equal(result.status, 'failed');
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const failedEvent = events.find((event) =>
    event.payload.action === 'writing_plans' &&
    event.payload.status === 'failed'
  );
  assert.match(String(failedEvent?.payload.error ?? ''), /implementationPlanPath/u);
});

test('subagent_execution action blocks when task has no implementation plan', async () => {
  const project = projectRepo.create({
    name: '执行缺少计划',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-subagent-no-plan-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '子代理执行',
    description: '没有 implementation plan 时应阻塞',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });

  const result = await startTaskAction({ roomId: room.id, taskId: task.id, action: 'subagent_execution' });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /编写计划|implementation plan/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  assert.ok(events.some((event) =>
    event.payload.action === 'subagent_execution' &&
    event.payload.status === 'running'
  ));
  const blockedEvent = events.find((event) =>
    event.payload.action === 'subagent_execution' &&
    event.payload.status === 'blocked'
  );
  assert.equal(blockedEvent?.payload.event_message_id, result.message_id);
  assert.equal(blockedEvent?.payload.superpowers_phase, 'tdd_execute');
});

test('subagent_execution ignores failed writing plan evidence', async () => {
  const project = projectRepo.create({
    name: '失败计划不能执行',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-subagent-failed-plan-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '失败计划',
    description: 'failed writing_plans evidence 不能放行',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'writing_plans',
      status: 'failed',
      task_action: 'writing_plans',
      task_action_status: 'failed',
      evidence: { implementationPlanPath: 'docs/superpowers/plans/failed-plan.md' },
    },
  });

  const result = await startTaskAction({ roomId: room.id, taskId: task.id, action: 'subagent_execution' });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /编写计划|implementation plan/u);
});

test('subagent_execution action dispatches tdd_execute after completed implementation plan evidence', async () => {
  const project = projectRepo.create({
    name: '已有计划执行',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-subagent-with-plan-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '子代理执行实施计划',
    description: '已有 implementation plan 时应进入 tdd_execute',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'writing_plans',
      status: 'completed',
      task_action: 'writing_plans',
      task_action_status: 'completed',
      evidence: { implementationPlanPath: 'docs/superpowers/plans/test-plan.md' },
    },
  });
  let prompt = '';

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'subagent_execution',
    runAgent: async (input) => {
      prompt = input.prompt;
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"tddEvidence":[{"stage":"RED","command":"node --test","passed":false,"summary":"按预期失败"},{"stage":"GREEN","command":"node --test","passed":true,"summary":"通过"}]}}\n```',
        error: null,
        runId: 'run-subagent-execution',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.match(prompt, /tdd_execute/u);
  assert.match(prompt, /Skill: superpowers:subagent-driven-development/u);
  assert.deepEqual(result.run_ids, ['run-subagent-execution']);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const completedEvent = events.find((event) =>
    event.payload.action === 'subagent_execution' &&
    event.payload.status === 'completed'
  );
  assert.equal(completedEvent?.payload.superpowers_phase, 'tdd_execute');
});

test('subagent_execution action fails when tdd evidence has no red stage', async () => {
  const project = projectRepo.create({
    name: '缺少 RED evidence',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-subagent-no-red-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '缺少 RED 阶段',
    description: '只有 GREEN 不能算完成',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'writing_plans',
      status: 'completed',
      task_action: 'writing_plans',
      task_action_status: 'completed',
      evidence: { implementationPlanPath: 'docs/superpowers/plans/test-plan.md' },
    },
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'subagent_execution',
    runAgent: async () => ({
      status: 'completed',
      content: '```json\n{"superpowers":{"tddEvidence":[{"stage":"GREEN","command":"node --test","passed":true,"summary":"通过"}]}}\n```',
      error: null,
      runId: 'run-subagent-no-red',
    }),
  });

  assert.equal(result.status, 'failed');
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const failedEvent = events.find((event) =>
    event.payload.action === 'subagent_execution' &&
    event.payload.status === 'failed'
  );
  assert.match(String(failedEvent?.payload.error ?? ''), /RED\/GREEN/u);
});

test('subagent_execution action completes with numeric tdd exemption evidence', async () => {
  const project = projectRepo.create({
    name: 'TDD 豁免执行',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-subagent-tdd-exemption-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'TDD 豁免',
    description: '合法 tddExemption 使用数字 createdAt',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'writing_plans',
      status: 'completed',
      task_action: 'writing_plans',
      task_action_status: 'completed',
      evidence: { implementationPlanPath: 'docs/superpowers/plans/test-plan.md' },
    },
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'subagent_execution',
    runAgent: async () => ({
      status: 'completed',
      content: '```json\n{"superpowers":{"tddExemption":{"reason":"只读分析任务","approvedBy":"user","createdAt":1770076800000}}}\n```',
      error: null,
      runId: 'run-subagent-tdd-exemption',
    }),
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.run_ids, ['run-subagent-tdd-exemption']);
});

test('brainstorming action records failed event when planner runner throws', async () => {
  const project = projectRepo.create({
    name: '头脑风暴失败',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-brainstorm-throw-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'runner 抛错',
    description: 'phase runner 抛错必须写 failed',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: undefined,
    source_message_id: null,
    parent_task_id: undefined,
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'brainstorming',
    runAgent: async () => {
      throw new Error('planner exploded');
    },
  });

  assert.equal(result.status, 'failed');
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  assert.ok(events.some((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'running'
  ));
  const failedEvent = events.find((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'failed'
  );
  assert.match(String(failedEvent?.payload.error ?? ''), /planner exploded/u);
  assert.equal(failedEvent?.payload.event_message_id, result.message_id);
});
