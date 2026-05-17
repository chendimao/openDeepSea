import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-memory-')), 'test.db');

const { memoryRepo } = await import('../repos/memory.js');
const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { settingsRepo } = await import('../repos/settings.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { buildTaskSummaryMemoryContent, rememberAcceptedTask } = await import('./orchestrator.js');
const { createGraphNodes } = await import('./graph/nodes.js');
const { createGraphTools } = await import('./graph/tools.js');
import { buildStagePrompt } from './prompts.js';

test('buildStagePrompt includes memory context when provided', () => {
  const prompt = buildStagePrompt('analysis', {
    ...basePromptContext(),
    memoryContext: '项目/聊天室记忆：\n1. [决策；project] Use explicit memory\nInject it.',
  });

  assert.match(prompt, /项目\/聊天室记忆：/);
  assert.match(prompt, /Use explicit memory/);
});

test('buildStagePrompt uses empty memory placeholder when no memory context is provided', () => {
  const prompt = buildStagePrompt('analysis', basePromptContext());

  assert.match(prompt, /项目\/聊天室记忆：暂无相关记忆。/);
});

test('buildTaskSummaryMemoryContent summarizes parsed acceptance verdict and truncates long notes', () => {
  const content = buildTaskSummaryMemoryContent('Build memory', {
    verdict: 'pass',
    acceptedCriteria: ['prompt includes memory', 'summary is saved'],
    failedCriteria: [],
    notes: 'Accepted. '.repeat(600),
  });

  assert.ok(content.length <= 4000);
  assert.match(content, /任务：Build memory/);
  assert.match(content, /验收结论：通过/);
  assert.match(content, /验收说明：/);
  assert.match(content, /通过标准：/);
  assert.match(content, /- prompt includes memory/);
  assert.doesNotMatch(content, /```json/);
  assert.match(content, /\.\.\.已截断/);
});

test('rememberAcceptedTask saves task summary but skips LLM distill when auto distill is disabled', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-memory-project-'));
  const project = projectRepo.create({ name: 'Workflow Memory', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Room' });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: 'Build audit trail',
    description: 'Add memory distill audit trail',
  });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'user',
    sender_id: 'user',
    sender_name: 'You',
    content: '请实现自动沉淀审计流水线。',
  });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: '计划新增 memory_distill_runs 表。',
  });
  messageRepo.create({
    room_id: room.id,
    sender_type: 'agent',
    sender_id: 'reviewer',
    sender_name: 'Reviewer',
    content: '验收通过，后续沉淀审计记录。',
  });
  const run = workflowRepo.createRun({
    project_id: project.id,
    room_id: room.id,
    task_id: task.id,
    status: 'completed',
    current_stage: 'acceptance',
  });

  settingsRepo.updateProject(project.id, { auto_distill_enabled: false });

  rememberAcceptedTask(run, {
    verdict: 'pass',
    acceptedCriteria: ['summary saved'],
    failedCriteria: [],
    notes: 'Accepted.',
  });

  const memories = memoryRepo.list({ projectId: project.id, roomId: room.id, taskId: task.id });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.memory_type, 'task_summary');
  assert.equal(memories[0]?.source_type, 'workflow');
  assert.equal(memories[0]?.source_id, run.id);
});

test('graph memory node distills accepted task only when auto distill is enabled', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-graph-memory-distill-project-'));
  const project = projectRepo.create({ name: 'Graph Memory Distill', path: projectPath });
  const disabledRoom = roomRepo.create({ project_id: project.id, name: 'Graph Distill Disabled Room' });
  const enabledRoom = roomRepo.create({ project_id: project.id, name: 'Graph Distill Enabled Room' });
  const distillCalls: Array<{ taskId: string; sourceId: string; taskSummary: string }> = [];

  settingsRepo.updateRoom(disabledRoom.id, { auto_distill_enabled: false });
  settingsRepo.updateRoom(enabledRoom.id, { auto_distill_enabled: true });

  const disabled = createAcceptedGraphRun({
    projectId: project.id,
    roomId: disabledRoom.id,
    title: 'Disabled graph distill task',
  });
  const enabled = createAcceptedGraphRun({
    projectId: project.id,
    roomId: enabledRoom.id,
    title: 'Enabled graph distill task',
  });
  const tools = createGraphTools();
  tools.distillTask = async (input) => {
    distillCalls.push({
      taskId: input.taskId,
      sourceId: input.sourceId,
      taskSummary: input.taskSummary,
    });
  };

  await createGraphNodes(tools).memoryNode(baseGraphState({
    runId: disabled.run.id,
    projectId: project.id,
    roomId: disabledRoom.id,
    taskId: disabled.task.id,
    taskTitle: disabled.task.title,
    projectPath,
  }));
  await createGraphNodes(tools).memoryNode(baseGraphState({
    runId: enabled.run.id,
    projectId: project.id,
    roomId: enabledRoom.id,
    taskId: enabled.task.id,
    taskTitle: enabled.task.title,
    projectPath,
  }));

  assert.deepEqual(distillCalls.map((call) => call.taskId), [enabled.task.id]);
  assert.equal(distillCalls[0]?.sourceId, enabled.run.id);
  assert.match(distillCalls[0]?.taskSummary ?? '', /summary for Enabled graph distill task/);
});

function basePromptContext(): Parameters<typeof buildStagePrompt>[1] {
  return {
    projectName: 'Memory Project',
    projectPath: '/tmp/memory-project',
    room: {
      id: 'room-1',
      project_id: 'project-1',
      name: 'Memory Room',
      description: null,
      created_at: 1,
    },
    task: {
      id: 'task-1',
      room_id: 'room-1',
      project_id: 'project-1',
      parent_task_id: null,
      title: 'Build memory',
      description: 'Add memory context',
      status: 'todo',
      priority: 'normal',
      interaction_mode: 'ask_user',
      assigned_agent_id: null,
      source_message_id: null,
      created_from: null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    agents: [],
    workflowContext: '已有工作流上下文：暂无。',
  };
}

function createAcceptedGraphRun(input: {
  projectId: string;
  roomId: string;
  title: string;
}) {
  const task = taskRepo.create({
    project_id: input.projectId,
    room_id: input.roomId,
    title: input.title,
    description: 'Exercise graph memory distill.',
  });
  const run = workflowRepo.createRun({
    project_id: input.projectId,
    room_id: input.roomId,
    task_id: task.id,
    status: 'running',
    current_stage: 'acceptance',
    graph_version: 'phase-b-v1',
  });
  workflowRepo.createArtifact({
    task_id: task.id,
    workflow_run_id: run.id,
    artifact_type: 'acceptance',
    title: '功能验收',
    content: JSON.stringify({
      verdict: 'pass',
      acceptedCriteria: [`summary for ${input.title}`],
      failedCriteria: [],
      notes: 'Accepted.',
    }),
  });
  return { task, run };
}

function baseGraphState(input: {
  runId: string;
  projectId: string;
  roomId: string;
  taskId: string;
  taskTitle: string;
  projectPath: string;
}) {
  return {
    workflowRunId: input.runId,
    projectId: input.projectId,
    roomId: input.roomId,
    taskId: input.taskId,
    userGoal: input.taskTitle,
    projectPath: input.projectPath,
    plan: null,
    currentNode: 'acceptance' as const,
    currentStepId: null,
    activeAgentRunId: null,
    childTaskIds: [],
    reviewFindings: [],
    reviewVerdict: 'pass' as const,
    verificationResults: [],
    repairAttempts: 0,
    approval: 'not_required' as const,
    status: 'completed' as const,
    error: null,
  };
}
