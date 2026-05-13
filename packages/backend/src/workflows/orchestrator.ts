import { respondAsAgent } from '../dispatcher.js';
import { projectRepo } from '../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../repos/rooms.js';
import { taskRepo } from '../repos/tasks.js';
import { workflowRepo } from '../repos/workflows.js';
import { wsHub } from '../ws-hub.js';
import { parsePlanArtifact } from './plan-parser.js';
import { buildStagePrompt } from './prompts.js';
import type {
  AgentRun,
  Message,
  Room,
  RoomAgent,
  Task,
  TaskArtifact,
  WorkflowRole,
  WorkflowRun,
  WorkflowStage,
  WorkflowStep,
} from '../types.js';

export const workflowOrchestrator = {
  async start(taskId: string): Promise<WorkflowRun> {
    const task = requireTask(taskId);
    const existing = workflowRepo.getActiveByTask(task.id);
    if (existing) throw new Error('task already has an active workflow');
    const run = workflowRepo.createRun({
      room_id: task.room_id,
      project_id: task.project_id,
      task_id: task.id,
      status: 'running',
      current_stage: 'analysis',
      approval_required: true,
    });
    broadcastWorkflow('workflow:created', run);
    await startAgentStage(run, task, 'analysis');
    return run;
  },

  detail(id: string) {
    return workflowRepo.detail(id);
  },

  async approvePlan(id: string, approvedBy = 'user'): Promise<WorkflowRun> {
    const run = requireRun(id);
    if (run.status !== 'awaiting_approval') throw new Error('workflow is not awaiting approval');
    const updated = workflowRepo.updateRun(id, {
      status: 'running',
      current_stage: 'assignment',
      approved_by: approvedBy,
      error: null,
    });
    if (!updated) throw new Error('workflow not found');
    broadcastWorkflow('workflow:updated', updated);
    await assignFromPlan(updated);
    return updated;
  },

  async cancel(id: string): Promise<WorkflowRun> {
    const run = requireRun(id);
    const updated = workflowRepo.updateRun(run.id, { status: 'cancelled', error: null });
    if (!updated) throw new Error('workflow not found');
    broadcastWorkflow('workflow:updated', updated);
    return updated;
  },

  async retryStep(id: string): Promise<WorkflowRun> {
    const run = requireRun(id);
    if (!run.current_stage) throw new Error('workflow has no current stage');
    const updated = workflowRepo.updateRun(run.id, { status: 'running', error: null });
    if (!updated) throw new Error('workflow not found');
    broadcastWorkflow('workflow:updated', updated);
    const task = requireTask(run.task_id);
    if (run.current_stage === 'assignment') await assignFromPlan(updated);
    else await startAgentStage(updated, task, run.current_stage);
    return updated;
  },
};

function requireTask(taskId: string): Task {
  const task = taskRepo.get(taskId);
  if (!task) throw new Error('task not found');
  return task;
}

function requireRun(id: string): WorkflowRun {
  const run = workflowRepo.getRun(id);
  if (!run) throw new Error('workflow not found');
  return run;
}

function getContext(run: WorkflowRun): {
  room: Room;
  project: NonNullable<ReturnType<typeof projectRepo.get>>;
  task: Task;
  agents: RoomAgent[];
  artifacts: TaskArtifact[];
} {
  const room = roomRepo.get(run.room_id);
  const project = projectRepo.get(run.project_id);
  const task = taskRepo.get(run.task_id);
  if (!room || !project || !task) throw new Error('workflow context is incomplete');
  return {
    room,
    project,
    task,
    agents: roomAgentRepo.listByRoom(run.room_id),
    artifacts: workflowRepo.listArtifacts(run.id),
  };
}

function roleForStage(stage: WorkflowStage): WorkflowRole | null {
  if (stage === 'analysis') return 'analyst';
  if (stage === 'planning') return 'planner';
  if (stage === 'implementation') return 'executor';
  if (stage === 'code_review') return 'reviewer';
  if (stage === 'acceptance') return 'acceptor';
  return 'coordinator';
}

function selectAgent(stage: WorkflowStage, agents: RoomAgent[]): RoomAgent | null {
  const role = roleForStage(stage);
  if (!role) return null;
  const exact = agents.filter((agent) => agent.workflow_role === role);
  if (exact.length > 0) return exact.find((agent) => agent.acp_enabled) ?? exact[0] ?? null;
  if (stage === 'analysis') return agents.find((agent) => agent.workflow_role === 'planner') ?? null;
  if (stage === 'planning') return agents.find((agent) => agent.workflow_role === 'analyst') ?? null;
  if (stage === 'acceptance') return agents.find((agent) => agent.workflow_role === 'reviewer') ?? null;
  return null;
}

function nextSortOrder(runId: string): number {
  return workflowRepo.listSteps(runId).length + 1;
}

function broadcastWorkflow(type: 'workflow:created' | 'workflow:updated', workflow: WorkflowRun): void {
  wsHub.broadcast(workflow.room_id, { type, roomId: workflow.room_id, workflow });
}

function broadcastStep(type: 'workflow_step:created' | 'workflow_step:updated', roomId: string, step: WorkflowStep): void {
  wsHub.broadcast(roomId, { type, roomId, step });
}

function broadcastArtifact(roomId: string, artifact: TaskArtifact): void {
  wsHub.broadcast(roomId, { type: 'workflow_artifact:created', roomId, artifact });
}

function block(run: WorkflowRun, error: string): void {
  const updated = workflowRepo.blockRun(run.id, error);
  if (updated) broadcastWorkflow('workflow:updated', updated);
}

async function startAgentStage(run: WorkflowRun, task: Task, stage: WorkflowStage): Promise<void> {
  const context = getContext(run);
  const agent = selectAgent(stage, context.agents);
  if (!agent) {
    block(run, `No available agent for workflow stage ${stage}`);
    return;
  }
  const prompt = buildStagePrompt(stage, {
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task,
    agents: context.agents,
    artifacts: context.artifacts,
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage,
    status: 'running',
    room_agent_id: agent.id,
    prompt,
    sort_order: nextSortOrder(run.id),
  });
  broadcastStep('workflow_step:created', run.room_id, step);
  const updatedRun = workflowRepo.updateRun(run.id, { status: 'running', current_stage: stage, error: null });
  if (updatedRun) broadcastWorkflow('workflow:updated', updatedRun);

  await respondAsAgent({
    agent,
    projectPath: context.project.path,
    roomId: run.room_id,
    prompt,
    taskId: task.id,
    workflowRunId: run.id,
    workflowStepId: step.id,
    workflowStage: stage,
    onFinished: ({ run: agentRun, message, status }) =>
      handleAgentStageFinished(run.id, step.id, agentRun, message, status),
  });
}

async function handleAgentStageFinished(
  workflowRunId: string,
  stepId: string,
  agentRun: AgentRun,
  message: Message,
  status: AgentRun['status'],
): Promise<void> {
  const run = workflowRepo.getRun(workflowRunId);
  const step = workflowRepo.getStep(stepId);
  if (!run || !step) return;
  if (run.status === 'cancelled') return;
  if (status !== 'completed') {
    const updatedStep = workflowRepo.updateStep(step.id, {
      status: status === 'cancelled' ? 'cancelled' : 'failed',
      agent_run_id: agentRun.id,
      result: message.content,
      result_message_id: message.id,
      error: agentRun.error ?? agentRun.stderr ?? 'Agent run failed',
    });
    if (updatedStep) broadcastStep('workflow_step:updated', run.room_id, updatedStep);
    block(run, agentRun.error ?? 'Agent run failed');
    return;
  }

  const updatedStep = workflowRepo.updateStep(step.id, {
    status: 'completed',
    agent_run_id: agentRun.id,
    result: message.content,
    result_message_id: message.id,
  });
  if (updatedStep) broadcastStep('workflow_step:updated', run.room_id, updatedStep);

  if (step.stage === 'analysis') {
    const artifact = workflowRepo.createArtifact({
      task_id: run.task_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      artifact_type: 'analysis',
      title: '任务分析',
      content: message.content,
    });
    broadcastArtifact(run.room_id, artifact);
    await startAgentStage(run, requireTask(run.task_id), 'planning');
    return;
  }

  if (step.stage === 'planning') {
    await finishPlanning(run, step, message.content);
    return;
  }

  if (step.stage === 'implementation') {
    taskRepo.updateStatus(step.task_id, 'done');
    await continueImplementationOrReview(run);
    return;
  }

  if (step.stage === 'code_review') {
    await finishReview(run, step, message.content);
    return;
  }

  if (step.stage === 'acceptance') {
    await finishAcceptance(run, step, message.content);
  }
}

async function finishPlanning(run: WorkflowRun, step: WorkflowStep, output: string): Promise<void> {
  try {
    const plan = parsePlanArtifact(output);
    const artifact = workflowRepo.createArtifact({
      task_id: run.task_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      artifact_type: 'plan',
      title: '实施计划',
      content: output,
      metadata: JSON.parse(JSON.stringify(plan)) as Record<string, unknown>,
    });
    broadcastArtifact(run.room_id, artifact);
    const updated = workflowRepo.updateRun(run.id, { status: 'awaiting_approval', current_stage: 'planning', error: null });
    if (updated) broadcastWorkflow('workflow:updated', updated);
    const waitingStep = workflowRepo.updateStep(step.id, { status: 'awaiting_approval' });
    if (waitingStep) broadcastStep('workflow_step:updated', run.room_id, waitingStep);
  } catch (err) {
    const artifact = workflowRepo.createArtifact({
      task_id: run.task_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      artifact_type: 'plan',
      title: '未解析计划',
      content: output,
    });
    broadcastArtifact(run.room_id, artifact);
    block(run, (err as Error).message);
  }
}

async function assignFromPlan(run: WorkflowRun): Promise<void> {
  const artifacts = workflowRepo.listArtifacts(run.id);
  const planArtifact = [...artifacts].reverse().find((artifact) => artifact.artifact_type === 'plan');
  if (!planArtifact) {
    block(run, 'No plan artifact found');
    return;
  }
  const plan = parsePlanArtifact(planArtifact.content);
  const task = requireTask(run.task_id);
  const context = getContext(run);
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: run.task_id,
    stage: 'assignment',
    status: 'completed',
    prompt: '系统根据计划创建子任务并分配执行者。',
    sort_order: nextSortOrder(run.id),
  });
  broadcastStep('workflow_step:created', run.room_id, step);

  for (const item of plan.tasks) {
    const assigned = selectAgentForRole(item.suggestedRole, context.agents);
    taskRepo.create({
      room_id: task.room_id,
      project_id: task.project_id,
      parent_task_id: task.id,
      title: item.title,
      description: `${item.description}\n\n验收点：\n${item.acceptance.map((point) => `- ${point}`).join('\n')}`,
      priority: item.priority,
      assigned_agent_id: assigned?.id,
    });
  }

  const artifact = workflowRepo.createArtifact({
    task_id: run.task_id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    artifact_type: 'assignment',
    title: '任务分配',
    content: `已根据计划创建 ${plan.tasks.length} 个子任务。`,
    metadata: { taskCount: plan.tasks.length },
  });
  broadcastArtifact(run.room_id, artifact);
  await continueImplementationOrReview(run);
}

function selectAgentForRole(role: WorkflowRole, agents: RoomAgent[]): RoomAgent | null {
  const candidates = agents.filter((agent) => agent.workflow_role === role);
  if (candidates.length === 0 && role !== 'executor') return selectAgentForRole('executor', agents);
  if (candidates.length === 0) return null;
  return candidates.find((agent) => agent.acp_enabled) ?? candidates[0] ?? null;
}

async function continueImplementationOrReview(run: WorkflowRun): Promise<void> {
  const children = taskRepo.listChildren(run.task_id);
  const nextChild = children.find((task) => task.status === 'todo' || task.status === 'in_progress');
  if (nextChild) {
    const assigned = nextChild.assigned_agent_id ? roomAgentRepo.get(nextChild.assigned_agent_id) : null;
    const agents = roomAgentRepo.listByRoom(run.room_id);
    const agent = assigned ?? selectAgentForRole('executor', agents);
    if (!agent) {
      block(run, 'No executor available for implementation');
      return;
    }
    taskRepo.updateStatus(nextChild.id, 'in_progress');
    await startAgentStageWithAgent(run, nextChild, 'implementation', agent);
    return;
  }
  await startAgentStage(run, requireTask(run.task_id), 'code_review');
}

async function startAgentStageWithAgent(run: WorkflowRun, task: Task, stage: WorkflowStage, agent: RoomAgent): Promise<void> {
  const context = getContext(run);
  const prompt = buildStagePrompt(stage, {
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task,
    agents: context.agents,
    artifacts: context.artifacts,
  });
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage,
    status: 'running',
    room_agent_id: agent.id,
    prompt,
    sort_order: nextSortOrder(run.id),
  });
  broadcastStep('workflow_step:created', run.room_id, step);
  const updatedRun = workflowRepo.updateRun(run.id, { status: 'running', current_stage: stage, error: null });
  if (updatedRun) broadcastWorkflow('workflow:updated', updatedRun);
  await respondAsAgent({
    agent,
    projectPath: context.project.path,
    roomId: run.room_id,
    prompt,
    taskId: task.id,
    workflowRunId: run.id,
    workflowStepId: step.id,
    workflowStage: stage,
    onFinished: ({ run: agentRun, message, status }) =>
      handleAgentStageFinished(run.id, step.id, agentRun, message, status),
  });
}

async function finishReview(run: WorkflowRun, step: WorkflowStep, output: string): Promise<void> {
  const artifact = workflowRepo.createArtifact({
    task_id: run.task_id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    artifact_type: 'review',
    title: '代码审查',
    content: output,
  });
  broadcastArtifact(run.room_id, artifact);
  if (/"verdict"\s*:\s*"changes_requested"/.test(output)) {
    block(run, 'Code review requested changes');
    return;
  }
  if (/"verdict"\s*:\s*"failed"/.test(output)) {
    block(run, 'Code review failed');
    return;
  }
  await startAgentStage(run, requireTask(run.task_id), 'acceptance');
}

async function finishAcceptance(run: WorkflowRun, step: WorkflowStep, output: string): Promise<void> {
  const artifact = workflowRepo.createArtifact({
    task_id: run.task_id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    artifact_type: 'acceptance',
    title: '功能验收',
    content: output,
  });
  broadcastArtifact(run.room_id, artifact);
  if (/"verdict"\s*:\s*"pass"/.test(output)) {
    taskRepo.updateStatus(run.task_id, 'done');
    const updated = workflowRepo.updateRun(run.id, { status: 'completed', current_stage: 'acceptance', error: null });
    if (updated) broadcastWorkflow('workflow:updated', updated);
  } else {
    taskRepo.updateStatus(run.task_id, 'failed');
    const updated = workflowRepo.updateRun(run.id, {
      status: 'failed',
      current_stage: 'acceptance',
      error: 'Acceptance failed',
    });
    if (updated) broadcastWorkflow('workflow:updated', updated);
  }
}
