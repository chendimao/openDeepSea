import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-context-')), 'test.db');

const { agentRunRepo } = await import('./agent-runs.js');
const { projectRepo } = await import('./projects.js');
const { roomAgentRepo, roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');
const { workflowRepo } = await import('./workflows.js');
const {
  estimateTokenCount,
  formatWorkflowContextEntries,
  workflowContextRepo,
} = await import('./workflow-context.js');

function createFixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `openclaw-room-workflow-context-${name}-`));
  mkdirSync(dir, { recursive: true });
  const project = projectRepo.create({ name, path: dir });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  const agent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: `${name}-agent`,
    agent_name: `${name} Agent`,
  });
  roomAgentRepo.setAcp(agent.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: `${name} task` });
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'implementation',
    node_name: 'execute',
    status: 'completed',
    room_agent_id: agent.id,
    sort_order: 1,
  });
  const agentRun = agentRunRepo.create({
    room_id: room.id,
    room_agent_id: agent.id,
    agent_id: agent.agent_id,
    backend: 'codex',
    status: 'completed',
    task_id: task.id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'Implement the task.',
  });
  return { project, room, agent, task, run, step, agentRun };
}

test('workflowContextRepo creates and lists entries by workflow and step', () => {
  const { agent, task, run, step, agentRun } = createFixture('basic');

  const entry = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    room_agent_id: agent.id,
    agent_run_id: agentRun.id,
    source_type: 'agent_run',
    source_id: agentRun.id,
    entry_type: 'handoff',
    title: '执行交接',
    content: '修改了 workflow context repo，并补充了测试。',
    metadata: { graph_node: 'execute' },
  });

  assert.equal(entry.workflow_run_id, run.id);
  assert.equal(entry.workflow_step_id, step.id);
  assert.equal(entry.room_agent_id, agent.id);
  assert.equal(entry.agent_run_id, agentRun.id);
  assert.equal(entry.raw_char_count, entry.content.length);
  assert.equal(entry.summary_char_count, entry.content.length);
  assert.equal(entry.token_estimate, estimateTokenCount(entry.content));
  assert.deepEqual(workflowContextRepo.listByWorkflow(run.id).map((item) => item.id), [entry.id]);
  assert.deepEqual(workflowContextRepo.listByStep(step.id).map((item) => item.id), [entry.id]);
});

test('workflowContextRepo treats duplicate source entry version as idempotent', () => {
  const { task, run, step, agentRun } = createFixture('duplicate');

  const first = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    agent_run_id: agentRun.id,
    source_type: 'agent_run',
    source_id: agentRun.id,
    entry_type: 'summary',
    title: '第一次摘要',
    content: '第一次写入。',
  });
  const second = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    agent_run_id: agentRun.id,
    source_type: 'agent_run',
    source_id: agentRun.id,
    entry_type: 'summary',
    title: '第二次摘要',
    content: '第二次写入应该返回已有记录。',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.title, '第一次摘要');
  assert.equal(workflowContextRepo.listByWorkflow(run.id).length, 1);
});

test('workflowContextRepo scopes idempotency to workflow runs', () => {
  const firstFixture = createFixture('workflow-scope-a');
  const secondFixture = createFixture('workflow-scope-b');

  const first = workflowContextRepo.create({
    workflow_run_id: firstFixture.run.id,
    workflow_step_id: firstFixture.step.id,
    task_id: firstFixture.task.id,
    source_type: 'system',
    source_id: 'shared-source',
    entry_type: 'summary',
    title: '第一条',
    content: '第一个工作流的上下文。',
  });
  const second = workflowContextRepo.create({
    workflow_run_id: secondFixture.run.id,
    workflow_step_id: secondFixture.step.id,
    task_id: secondFixture.task.id,
    source_type: 'system',
    source_id: 'shared-source',
    entry_type: 'summary',
    title: '第二条',
    content: '第二个工作流的上下文。',
  });

  assert.notEqual(second.id, first.id);
  assert.deepEqual(workflowContextRepo.listByWorkflow(firstFixture.run.id).map((item) => item.id), [first.id]);
  assert.deepEqual(workflowContextRepo.listByWorkflow(secondFixture.run.id).map((item) => item.id), [second.id]);
});

test('formatWorkflowContextEntries truncates entry and total budgets with raw refs', () => {
  const { task, run, step, agentRun } = createFixture('format');
  const longText = `前缀-${'x'.repeat(200)}-后缀`;
  const handoff = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    agent_run_id: agentRun.id,
    source_type: 'agent_run',
    source_id: agentRun.id,
    entry_type: 'handoff',
    title: '长交接',
    content: longText,
  });
  workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    source_type: 'workflow_step',
    source_id: `${step.id}:verification`,
    entry_type: 'verification',
    title: '验证',
    content: 'npm run build: passed',
  });

  const formatted = formatWorkflowContextEntries(workflowContextRepo.listByWorkflow(run.id), {
    maxEntryChars: 80,
    maxTotalChars: 500,
  });

  assert.match(formatted, /已有工作流上下文/);
  assert.match(formatted, /\[handoff\] 长交接/);
  assert.match(formatted, /前缀-/);
  assert.match(formatted, /已截断/);
  assert.doesNotMatch(formatted, /后缀/);
  assert.match(formatted, new RegExp(`source=agent_run:${handoff.source_id}`));
  assert.ok(formatted.length <= 500);
});

test('formatWorkflowContextEntries preserves input order for equal priority entries', () => {
  const { task, run, step } = createFixture('formatter-order');
  const first = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    source_type: 'system',
    source_id: 'order-first',
    entry_type: 'summary',
    title: '第一条摘要',
    content: 'first',
  });
  const second = workflowContextRepo.create({
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    task_id: task.id,
    source_type: 'system',
    source_id: 'order-second',
    entry_type: 'summary',
    title: '第二条摘要',
    content: 'second',
  });

  const formatted = formatWorkflowContextEntries([second, first]);

  assert.ok(formatted.indexOf('第二条摘要') < formatted.indexOf('第一条摘要'));
});

test('formatWorkflowContextEntries returns explicit empty context', () => {
  assert.equal(formatWorkflowContextEntries([]), '已有工作流上下文：暂无。');
});
