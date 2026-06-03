import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const { buildSuperpowersRoutingPrompt } = await import('./workflows/prompts.js');
const { parseSuperpowersRouting } = await import('./workflows/superpowers-routing.js');
const { startTaskAction } = await import('./task-actions.js');

test('parseSuperpowersRouting extracts valid fenced routing json', () => {
  const result = parseSuperpowersRouting([
    '路由完成',
    '```json',
    '{',
    '  "superpowers_routing": {',
    '    "next_action": "brainstorming",',
    '    "required_skill": "brainstorming",',
    '    "reason": "功能变更需要先澄清需求并产出 spec。",',
    '    "recommended_agent_id": "planner",',
    '    "expected_evidence": ["designDocPath"]',
    '  }',
    '}',
    '```',
  ].join('\n'));

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.routing.next_action : '', 'brainstorming');
  assert.deepEqual(result.ok ? result.routing.expected_evidence : [], ['designDocPath']);
});

test('parseSuperpowersRouting rejects incomplete routing json', () => {
  const result = parseSuperpowersRouting('```json\n{"superpowers_routing":{"next_action":"brainstorming"}}\n```');

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /required_skill|reason|recommended_agent_id|expected_evidence/u);
});

test('buildSuperpowersRoutingPrompt describes routing-only using-superpowers output', () => {
  const prompt = buildSuperpowersRoutingPrompt({
    projectName: 'Project',
    projectPath: '/tmp/project',
    room: {
      id: 'room',
      project_id: 'project',
      name: 'Room',
      description: null,
      created_at: 1,
      last_opened_at: null,
      pinned_at: null,
      sort_order: null,
    },
    task: {
      id: 'task',
      room_id: 'room',
      project_id: 'project',
      parent_task_id: null,
      title: '自动推进任务卡片',
      description: '需要先判断 Superpowers 下一步',
      status: 'todo',
      priority: 'normal',
      interaction_mode: 'auto_recommended',
      assigned_agent_id: null,
      source_message_id: null,
      created_from: 'manual',
      created_at: 1,
      updated_at: 1,
      completed_at: null,
      deleted_at: null,
    },
    agents: [],
  });

  assert.match(prompt, /using-superpowers/u);
  assert.match(prompt, /routing 只做判断/u);
  assert.match(prompt, /不替代 brainstorming、writing-plans、systematic-debugging/u);
  assert.match(prompt, /superpowers_routing/u);
  assert.match(prompt, /```json/u);
});

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
      writeProjectFile(project.path, 'docs/superpowers/specs/test-design.md');
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

test('route_skills action dispatches planner with using-superpowers routing prompt', async () => {
  const project = projectRepo.create({
    name: '路由判断动作',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-route-skills-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '自动判断下一步',
  });
  let prompt = '';

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'route_skills',
    runAgent: async (input) => {
      prompt = input.prompt;
      return {
        status: 'completed',
        content: '```json\n{"superpowers_routing":{"next_action":"brainstorming","required_skill":"brainstorming","reason":"需要 spec","recommended_agent_id":"planner","expected_evidence":["designDocPath"]}}\n```',
        error: null,
        runId: 'run-route',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.match(prompt, /using-superpowers/u);
  assert.match(prompt, /superpowers_routing/u);
  assert.deepEqual(result.run_ids, ['run-route']);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const completedEvent = events.find((event) =>
    event.payload.action === 'route_skills' &&
    event.payload.status === 'completed'
  );
  assert.equal(completedEvent?.payload.event_message_id, result.message_id);
  assert.equal((completedEvent?.payload.superpowers_routing as { next_action?: string } | undefined)?.next_action, 'brainstorming');
});

test('route_skills accepts valid routing output even when runner exits failed', async () => {
  const project = projectRepo.create({
    name: '路由输出后超时',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-route-timeout-after-output-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '路由已输出但进程超时',
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'route_skills',
    runAgent: async () => ({
      status: 'failed',
      content: '```json\n{"superpowers_routing":{"next_action":"writing_plans","required_skill":"writing-plans","reason":"已有 spec，继续写计划","recommended_agent_id":"planner","expected_evidence":["implementationPlanPath"]}}\n```',
      error: 'ACP prompt timed out',
      runId: 'run-route-timeout',
    }),
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.run_ids, ['run-route-timeout']);
  const events = taskEventRepo.listByTask(task.id, { limit: 10 });
  const completedEvent = events.find((event) =>
    event.payload.action === 'route_skills' &&
    event.payload.status === 'completed'
  );
  assert.equal((completedEvent?.payload.superpowers_routing as { next_action?: string } | undefined)?.next_action, 'writing_plans');
  assert.equal(completedEvent?.payload.error, 'ACP prompt timed out');
});

test('auto_advance routes missing spec task to planner brainstorming', async () => {
  const project = projectRepo.create({
    name: '自动推进缺 spec',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-no-spec-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '新增任务卡片入口',
  });
  const actions: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ prompt }) => {
      actions.push(prompt.includes('superpowers_routing') ? 'route' : 'phase');
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"verification","required_skill":"verification-before-completion","reason":"planner 误判为验收","recommended_agent_id":"reviewer","expected_evidence":["verificationEvidence"]}}\n```',
          error: null,
          runId: 'run-route',
        };
      }
      assert.match(prompt, /brainstorming/u);
      writeProjectFile(project.path, 'docs/superpowers/specs/auto-design.md');
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"designDocPath":"docs/superpowers/specs/auto-design.md","designReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-brainstorming',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(actions, ['route', 'phase']);
  assert.deepEqual(result.run_ids, ['run-route', 'run-brainstorming']);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  assert.ok(events.some((event) =>
    event.payload.action === 'route_skills' &&
    event.payload.status === 'completed'
  ));
  assert.ok(events.some((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'completed'
  ));
  assert.ok(events.some((event) =>
    event.payload.action === 'auto_advance' &&
    event.payload.status === 'completed'
  ));
});

test('auto_advance can directly execute lightweight tasks when routing skips planning', async () => {
  const project = projectRepo.create({
    name: '轻量任务直达执行',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-direct-execute-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  const frontend = agentRepo.getByAgentId('frontend-executor');
  assert.ok(planner);
  assert.ok(frontend);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: frontend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '调整 chip 展示文本',
    description: '需求明确且可直接执行前端实现',
  });
  const actions: string[] = [];
  const agentIds: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ agent, prompt }) => {
      agentIds.push(agent.agent_id);
      actions.push(prompt.includes('superpowers_routing') ? 'route' : 'phase');
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"subagent_execution","required_skill":"subagent-driven-development","reason":"需求明确、范围很小，可直接执行并用定向测试验证。","recommended_agent_id":"frontend-executor","expected_evidence":["tddEvidence"],"planning_required":false,"skip_planning_reason":"轻量明确前端展示改动"}}\n```',
          error: null,
          runId: 'run-route-direct',
        };
      }
      assert.match(prompt, /tdd_execute/u);
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"tddEvidence":[{"stage":"RED","command":"node --test","passed":false,"summary":"回归测试失败"},{"stage":"GREEN","command":"node --test","passed":true,"summary":"实现后通过"}]}}\n```',
        error: null,
        runId: 'run-direct-execution',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(actions, ['route', 'phase']);
  assert.deepEqual(agentIds, ['planner', 'frontend-executor']);
  assert.deepEqual(result.run_ids, ['run-route-direct', 'run-direct-execution']);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  assert.equal(events.some((event) =>
    event.payload.action === 'brainstorming' ||
    event.payload.action === 'writing_plans'
  ), false);
  assert.ok(events.some((event) =>
    event.payload.action === 'subagent_execution' &&
    event.payload.status === 'completed'
  ));
});

test('auto_advance does not skip planning for non-execution routing', async () => {
  const project = projectRepo.create({
    name: '非执行阶段不能跳规划',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-no-direct-verify-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '误判直接验收',
  });
  const actions: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ prompt }) => {
      actions.push(prompt.includes('superpowers_routing') ? 'route' : 'phase');
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"verification","required_skill":"verification-before-completion","reason":"误判直接验收","recommended_agent_id":"reviewer","expected_evidence":["verificationEvidence"],"planning_required":false,"skip_planning_reason":"不应生效"}}\n```',
          error: null,
          runId: 'run-route-verify-skip',
        };
      }
      assert.match(prompt, /brainstorming/u);
      writeProjectFile(project.path, 'docs/superpowers/specs/no-direct-verify-design.md');
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"designDocPath":"docs/superpowers/specs/no-direct-verify-design.md","designReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-brainstorming-no-direct-verify',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(actions, ['route', 'phase']);
  assert.deepEqual(result.run_ids, ['run-route-verify-skip', 'run-brainstorming-no-direct-verify']);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  assert.ok(events.some((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'completed'
  ));
  assert.equal(events.some((event) => event.payload.action === 'verification'), false);
});

test('auto_advance routes existing spec task to planner writing_plans before execution', async () => {
  const project = projectRepo.create({
    name: '自动推进已有 spec',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-with-spec-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '已有 spec 缺 plan',
  });
  recordCompletedEvidence(room.id, task.id, 'brainstorming', {
    designDocPath: 'docs/superpowers/specs/auto-design.md',
  });
  const prompts: string[] = [];
  const agentIds: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ agent, prompt }) => {
      agentIds.push(agent.agent_id);
      prompts.push(prompt);
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"subagent_execution","required_skill":"subagent-driven-development","reason":"planner 误判为执行","recommended_agent_id":"backend-executor","expected_evidence":["tddEvidence"]}}\n```',
          error: null,
          runId: 'run-route',
        };
      }
      assert.match(prompt, /writing_plans/u);
      writeProjectFile(project.path, 'docs/superpowers/plans/auto-plan.md');
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"implementationPlanPath":"docs/superpowers/plans/auto-plan.md","planReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-writing-plans',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.deepEqual(agentIds, ['planner', 'planner']);
  assert.deepEqual(result.run_ids, ['run-route', 'run-writing-plans']);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  assert.ok(events.some((event) =>
    event.payload.action === 'writing_plans' &&
    event.payload.status === 'completed'
  ));
});

test('auto_advance retry resumes from failed routing output when it is parseable', async () => {
  const project = projectRepo.create({
    name: '自动推进复用失败路由输出',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-recover-route-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  const roomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '已有失败路由输出',
  });
  recordCompletedEvidence(room.id, task.id, 'brainstorming', {
    designDocPath: 'docs/superpowers/specs/retry-design.md',
  });
  const failedRouteRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: roomAgent.id,
    agent_id: roomAgent.agent_id,
    backend: 'codex',
    task_id: task.id,
    status: 'failed',
    prompt: 'route prompt',
  });
  agentRunRepo.updateStatus(failedRouteRun.id, 'failed', {
    stdout: '```json\n{"superpowers_routing":{"next_action":"writing_plans","required_skill":"writing-plans","reason":"已有 spec，继续写计划","recommended_agent_id":"planner","expected_evidence":["implementationPlanPath"]}}\n```',
    error: 'ACP prompt timed out',
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'route_skills',
      status: 'failed',
      task_action: 'route_skills',
      task_action_status: 'failed',
      run_id: failedRouteRun.id,
      run_ids: [failedRouteRun.id],
      error: 'ACP prompt timed out',
    },
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'auto_advance',
      status: 'failed',
      task_action: 'auto_advance',
      task_action_status: 'failed',
      run_ids: [failedRouteRun.id],
      error: 'Superpowers 路由未完成',
    },
  });
  const prompts: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      assert.doesNotMatch(prompt, /superpowers_routing/u);
      assert.match(prompt, /writing_plans/u);
      writeProjectFile(project.path, 'docs/superpowers/plans/retry-plan.md');
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"implementationPlanPath":"docs/superpowers/plans/retry-plan.md","planReviewVerdict":"approved"}}\n```',
        error: null,
        runId: 'run-writing-plans-retry',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 1);
  assert.deepEqual(result.run_ids, [failedRouteRun.id, 'run-writing-plans-retry']);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  const recoveredRoute = events.find((event) =>
    event.payload.action === 'route_skills' &&
    event.payload.status === 'completed' &&
    event.payload.recovered_from_run_id === failedRouteRun.id
  );
  assert.equal((recoveredRoute?.payload.superpowers_routing as { next_action?: string } | undefined)?.next_action, 'writing_plans');
});

test('auto_advance does not recover stale failed routing after a later task action', async () => {
  const project = projectRepo.create({
    name: '自动推进不复用过期路由',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-no-stale-route-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(planner);
  assert.ok(backend);
  const plannerRoomAgent = roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: backend.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '失败路由后已有手动计划',
  });
  recordCompletedEvidence(room.id, task.id, 'brainstorming', {
    designDocPath: 'docs/superpowers/specs/stale-design.md',
  });
  const failedRouteRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: plannerRoomAgent.id,
    agent_id: plannerRoomAgent.agent_id,
    backend: 'codex',
    task_id: task.id,
    status: 'failed',
    prompt: 'old route prompt',
  });
  agentRunRepo.updateStatus(failedRouteRun.id, 'failed', {
    stdout: '```json\n{"superpowers_routing":{"next_action":"writing_plans","required_skill":"writing-plans","reason":"旧路由：继续写计划","recommended_agent_id":"planner","expected_evidence":["implementationPlanPath"]}}\n```',
    error: 'ACP prompt timed out',
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'route_skills',
      status: 'failed',
      task_action: 'route_skills',
      task_action_status: 'failed',
      run_id: failedRouteRun.id,
      run_ids: [failedRouteRun.id],
      error: 'ACP prompt timed out',
    },
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'auto_advance',
      status: 'failed',
      task_action: 'auto_advance',
      task_action_status: 'failed',
      run_ids: [failedRouteRun.id],
      error: 'Superpowers 路由未完成',
    },
  });
  recordCompletedEvidence(room.id, task.id, 'writing_plans', {
    implementationPlanPath: 'docs/superpowers/plans/manual-plan.md',
  });
  const prompts: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"systematic_debugging","required_skill":"systematic-debugging","reason":"已有 plan 后应重新判断执行阶段","recommended_agent_id":"backend-executor","expected_evidence":["debuggingEvidence"]}}\n```',
          error: null,
          runId: 'run-route-fresh',
        };
      }
      assert.match(prompt, /systematic_debugging/u);
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"debuggingEvidence":{"rootCause":"fresh route used","fixed":true}}}\n```',
        error: null,
        runId: 'run-debugging-fresh',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.deepEqual(result.run_ids, ['run-route-fresh', 'run-debugging-fresh']);
  const events = taskEventRepo.listByTask(task.id, { limit: 30 });
  assert.equal(events.some((event) => event.payload.recovered_from_run_id === failedRouteRun.id), false);
});

test('auto_advance follows routing action after implementation plan evidence exists', async () => {
  const project = projectRepo.create({
    name: '自动推进已有 plan',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-with-plan-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '已有 plan 进入调试',
  });
  recordCompletedEvidence(room.id, task.id, 'brainstorming', {
    designDocPath: 'docs/superpowers/specs/auto-design.md',
  });
  recordCompletedEvidence(room.id, task.id, 'writing_plans', {
    implementationPlanPath: 'docs/superpowers/plans/auto-plan.md',
  });
  const prompts: string[] = [];
  const agentIds: string[] = [];

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async ({ agent, prompt }) => {
      agentIds.push(agent.agent_id);
      prompts.push(prompt);
      if (prompt.includes('superpowers_routing')) {
        return {
          status: 'completed',
          content: '```json\n{"superpowers_routing":{"next_action":"systematic_debugging","required_skill":"systematic-debugging","reason":"测试失败，需要系统化调试","recommended_agent_id":"backend-executor","expected_evidence":["debuggingEvidence"]}}\n```',
          error: null,
          runId: 'run-route',
        };
      }
      assert.match(prompt, /systematic_debugging/u);
      assert.match(prompt, /Skill: superpowers:systematic-debugging/u);
      return {
        status: 'completed',
        content: '```json\n{"superpowers":{"debuggingEvidence":{"rootCause":"测试失败","fixed":true}}}\n```',
        error: null,
        runId: 'run-debugging',
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.deepEqual(agentIds, ['planner', 'backend-executor']);
  assert.deepEqual(result.run_ids, ['run-route', 'run-debugging']);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  const completedEvent = events.find((event) =>
    event.payload.action === 'systematic_debugging' &&
    event.payload.status === 'completed'
  );
  assert.equal(completedEvent?.payload.superpowers_phase, 'systematic_debugging');
});

test('auto_advance blocks execution routing when recommended agent is unavailable', async () => {
  const project = projectRepo.create({
    name: '自动推进推荐执行者不可用',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-missing-agent-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '已有 plan 但推荐执行者不存在',
  });
  recordCompletedEvidence(room.id, task.id, 'brainstorming', {
    designDocPath: 'docs/superpowers/specs/auto-design.md',
  });
  recordCompletedEvidence(room.id, task.id, 'writing_plans', {
    implementationPlanPath: 'docs/superpowers/plans/auto-plan.md',
  });
  let calls = 0;

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async () => {
      calls += 1;
      return {
        status: 'completed',
        content: '```json\n{"superpowers_routing":{"next_action":"subagent_execution","required_skill":"subagent-driven-development","reason":"进入执行阶段","recommended_agent_id":"missing-executor","expected_evidence":["tddEvidence"]}}\n```',
        error: null,
        runId: 'run-route-missing-agent',
      };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(calls, 1);
  assert.match(result.blocked_reason ?? '', /missing-executor|recommended agent/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  assert.ok(events.some((event) =>
    event.payload.action === 'route_skills' &&
    event.payload.status === 'completed'
  ));
  assert.ok(events.some((event) =>
    event.payload.action === 'auto_advance' &&
    event.payload.status === 'blocked'
  ));
  assert.equal(events.some((event) =>
    event.payload.action === 'subagent_execution' &&
    event.payload.status === 'running'
  ), false);
});

test('auto_advance blocks invalid routing output before dispatching a phase', async () => {
  const project = projectRepo.create({
    name: '自动推进非法 routing',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-auto-invalid-route-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '非法 routing 输出',
  });
  let calls = 0;

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'auto_advance',
    runAgent: async () => {
      calls += 1;
      return {
        status: 'completed',
        content: '```json\n{"superpowers_routing":{"next_action":"brainstorming"}}\n```',
        error: null,
        runId: 'run-route-invalid',
      };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(calls, 1);
  assert.match(result.blocked_reason ?? '', /required_skill|reason|recommended_agent_id|expected_evidence/u);
  const events = taskEventRepo.listByTask(task.id, { limit: 20 });
  assert.ok(events.some((event) =>
    event.payload.action === 'route_skills' &&
    event.payload.status === 'blocked'
  ));
  assert.ok(events.some((event) =>
    event.payload.action === 'auto_advance' &&
    event.payload.status === 'blocked'
  ));
  assert.equal(events.some((event) =>
    event.payload.action === 'brainstorming' &&
    event.payload.status === 'running'
  ), false);
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

test('writing_plans blocks when design spec evidence file is missing', async () => {
  const project = projectRepo.create({
    name: '缺失 spec 文件',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-plan-missing-spec-file-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const planner = agentRepo.getByAgentId('planner');
  assert.ok(planner);
  roomAgentRepo.addFromGlobalAgent({ room_id: room.id, global_agent_id: planner.id });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: '缺失 spec 文件',
    description: '只有 designDocPath 但文件不存在时不能放行',
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
      evidence: { designDocPath: 'docs/superpowers/specs/missing-design.md' },
    },
  });

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'writing_plans',
    runAgent: async () => {
      throw new Error('writing_plans should not run without a real spec file');
    },
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.blocked_reason ?? '', /spec 文件不存在|missing-design/u);
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
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'brainstorming',
      status: 'completed',
      task_action: 'brainstorming',
      task_action_status: 'failed',
      evidence: { designDocPath: 'docs/superpowers/specs/failed-design.md' },
    },
  });
  taskEventRepo.create({
    room_id: room.id,
    task_id: task.id,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action: 'brainstorming',
      status: 'completed',
      task_action: 'researching',
      task_action_status: 'completed',
      evidence: { designDocPath: 'docs/superpowers/specs/wrong-action-design.md' },
    },
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
  writeProjectFile(project.path, 'docs/superpowers/specs/test-design.md');
  let prompt = '';

  const result = await startTaskAction({
    roomId: room.id,
    taskId: task.id,
    action: 'writing_plans',
    runAgent: async (input) => {
      prompt = input.prompt;
      writeProjectFile(project.path, 'docs/superpowers/plans/test-plan.md');
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
  writeProjectFile(project.path, 'docs/superpowers/specs/test-design.md');

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
  writeProjectFile(project.path, 'docs/superpowers/plans/test-plan.md');
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
  writeProjectFile(project.path, 'docs/superpowers/plans/test-plan.md');

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
  writeProjectFile(project.path, 'docs/superpowers/plans/test-plan.md');

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

function recordCompletedEvidence(
  roomId: string,
  taskId: string,
  action: 'brainstorming' | 'writing_plans',
  evidence: Record<string, unknown>,
): void {
  const task = taskRepo.get(taskId);
  if (task) {
    const project = projectRepo.get(task.project_id);
    if (project) {
      const artifactPath = typeof evidence.designDocPath === 'string'
        ? evidence.designDocPath
        : typeof evidence.implementationPlanPath === 'string'
          ? evidence.implementationPlanPath
          : null;
      if (artifactPath) writeProjectFile(project.path, artifactPath);
    }
  }
  taskEventRepo.create({
    room_id: roomId,
    task_id: taskId,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action,
      status: 'completed',
      task_action: action,
      task_action_status: 'completed',
      evidence,
    },
  });
}

function writeProjectFile(projectPath: string, relativePath: string): void {
  const fullPath = join(projectPath, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, '# test artifact\n', 'utf8');
}
