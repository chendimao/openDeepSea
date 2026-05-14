import { respondAsAgent } from '../dispatcher.js';
import { agentRunRepo } from '../repos/agent-runs.js';
import { projectRepo } from '../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../repos/rooms.js';
import { taskRepo } from '../repos/tasks.js';
import { workflowRepo } from '../repos/workflows.js';
import { runRegistry } from '../run-registry.js';
import { wsHub } from '../ws-hub.js';
import {
  parseAcceptanceVerdict,
  parseDecisionRequest,
  parsePlanArtifact,
  parseReviewVerdict,
  type ParsedDecisionItem,
  type ParsedDecisionRequest,
} from './plan-parser.js';
import { buildStagePrompt } from './prompts.js';
import type {
  AgentRun,
  Message,
  Room,
  RoomAgent,
  Task,
  TaskArtifact,
  TaskStatus,
  WorkflowRole,
  WorkflowRun,
  WorkflowStage,
  WorkflowStep,
} from '../types.js';

export const workflowOrchestrator = {
  start(taskId: string): WorkflowRun {
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
    startAgentStage(run, task, 'analysis');
    return latestRun(run.id);
  },

  detail(id: string) {
    return workflowRepo.detail(id);
  },

  approvePlan(id: string, approvedBy = 'user'): WorkflowRun {
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
    assignFromPlan(updated);
    return latestRun(updated.id);
  },

  submitDecisions(
    id: string,
    answers: Array<{ decisionId: string; optionId: string }>,
    decidedBy = 'user',
  ): WorkflowRun {
    const run = requireRun(id);
    if (run.status !== 'awaiting_decision') throw new Error('workflow is not awaiting decision');
    const requestArtifact = latestDecisionRequestArtifact(run.id);
    if (!requestArtifact) throw new Error('workflow has no decision request');
    const request = parseDecisionMetadata(requestArtifact.metadata);
    const response = buildDecisionResponse(request.decisions, answers, decidedBy);
    const artifact = workflowRepo.createArtifact({
      task_id: run.task_id,
      workflow_run_id: run.id,
      workflow_step_id: requestArtifact.workflow_step_id,
      artifact_type: 'decision_response',
      title: '用户决策',
      content: formatDecisionResponse(response),
      metadata: response,
    });
    broadcastArtifact(run.room_id, artifact);
    const updated = workflowRepo.updateRun(id, {
      status: 'running',
      current_stage: 'planning',
      error: null,
    });
    if (!updated) throw new Error('workflow not found');
    broadcastWorkflow('workflow:updated', updated);
    startAgentStage(updated, requireTask(updated.task_id), 'planning');
    return latestRun(updated.id);
  },

  async cancel(id: string): Promise<WorkflowRun> {
    const run = requireRun(id);
    for (const agentRun of agentRunRepo.listActiveByWorkflow(run.id)) {
      runRegistry.cancel(agentRun.id);
      const cancelledRun = agentRunRepo.updateStatus(agentRun.id, 'cancelled');
      if (cancelledRun) broadcastAgentRun(run.room_id, cancelledRun);
    }
    for (const step of workflowRepo.listSteps(run.id).filter((item) => item.status === 'running')) {
      const cancelledStep = workflowRepo.updateStep(step.id, {
        status: 'cancelled',
        error: 'Workflow cancelled',
      });
      if (cancelledStep) broadcastStep('workflow_step:updated', run.room_id, cancelledStep);
      const task = taskRepo.get(step.task_id);
      if (task?.status === 'in_progress') updateTaskStatus(step.task_id, 'failed');
    }
    const updated = workflowRepo.updateRun(run.id, { status: 'cancelled', error: null });
    if (!updated) throw new Error('workflow not found');
    broadcastWorkflow('workflow:updated', updated);
    return updated;
  },

  retryStep(id: string): WorkflowRun {
    const run = requireRun(id);
    if (run.status === 'running' || run.status === 'awaiting_approval') {
      throw new Error('workflow is already running');
    }
    if (workflowRepo.listSteps(run.id).some((step) => step.status === 'running')) {
      throw new Error('workflow already has a running step');
    }
    if (agentRunRepo.listActiveByWorkflow(run.id).length > 0) {
      throw new Error('workflow already has an active agent run');
    }
    const retryableStep = [...workflowRepo.listSteps(run.id)]
      .reverse()
      .find((step) => step.status === 'failed' || step.status === 'cancelled');
    if (!retryableStep && run.status !== 'blocked') throw new Error('workflow has no failed step to retry');
    const updated = workflowRepo.updateRun(run.id, { status: 'running', error: null });
    if (!updated) throw new Error('workflow not found');
    broadcastWorkflow('workflow:updated', updated);
    if (!retryableStep) {
      if (!run.current_stage) throw new Error('workflow has no current stage');
      const task = requireTask(run.task_id);
      if (run.current_stage === 'assignment') assignFromPlan(updated);
      else startAgentStage(updated, task, run.current_stage);
      return latestRun(updated.id);
    }
    const skippedStep = workflowRepo.updateStep(retryableStep.id, {
      status: 'skipped',
      error: retryableStep.error ?? 'Superseded by retry',
    });
    if (skippedStep) broadcastStep('workflow_step:updated', run.room_id, skippedStep);
    if (retryableStep.stage === 'assignment') assignFromPlan(updated);
    else {
      const task = requireTask(retryableStep.task_id);
      if (retryableStep.stage === 'implementation') updateTaskStatus(task.id, 'todo');
      startAgentStage(updated, task, retryableStep.stage);
    }
    return latestRun(updated.id);
  },

  recoverOrphanedSteps(error: string): number {
    let count = 0;
    for (const step of workflowRepo.listRunningSteps()) {
      const run = workflowRepo.getRun(step.workflow_run_id);
      if (!run || run.status === 'cancelled' || run.status === 'completed') continue;
      const failedStep = workflowRepo.updateStep(step.id, { status: 'failed', error });
      if (failedStep) broadcastStep('workflow_step:updated', run.room_id, failedStep);
      const task = taskRepo.get(step.task_id);
      if (step.stage === 'implementation' && task?.status === 'in_progress') {
        updateTaskStatus(step.task_id, 'failed');
      }
      block(run, error);
      count++;
    }
    return count;
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

function latestRun(id: string): WorkflowRun {
  return requireRun(id);
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

function broadcastTask(type: 'task:created' | 'task:updated', task: Task): void {
  wsHub.broadcast(task.room_id, { type, task });
}

function broadcastAgentRun(roomId: string, run: AgentRun): void {
  wsHub.broadcast(roomId, { type: 'agent_run:updated', roomId, run });
}

function block(run: WorkflowRun, error: string): void {
  const updated = workflowRepo.blockRun(run.id, error);
  if (updated) broadcastWorkflow('workflow:updated', updated);
}

function updateTaskStatus(taskId: string, status: TaskStatus): Task | undefined {
  const task = taskRepo.updateStatus(taskId, status);
  if (task) broadcastTask('task:updated', task);
  return task;
}

function markStepFailed(
  run: WorkflowRun,
  step: WorkflowStep,
  error: string,
  agentRun?: AgentRun,
  message?: Message,
  status: 'failed' | 'cancelled' = 'failed',
): WorkflowStep | undefined {
  const patch: Parameters<typeof workflowRepo.updateStep>[1] = {
    status,
    error,
  };
  if (agentRun) patch.agent_run_id = agentRun.id;
  if (message) {
    patch.result = message.content;
    patch.result_message_id = message.id;
  }
  const updatedStep = workflowRepo.updateStep(step.id, patch);
  if (updatedStep) broadcastStep('workflow_step:updated', run.room_id, updatedStep);
  return updatedStep;
}

function failStageWithoutAgent(run: WorkflowRun, task: Task, stage: WorkflowStage, error: string): void {
  const updatedRun = workflowRepo.updateRun(run.id, { status: 'blocked', current_stage: stage, error });
  if (updatedRun) broadcastWorkflow('workflow:updated', updatedRun);
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage,
    status: 'failed',
    prompt: error,
    sort_order: nextSortOrder(run.id),
  });
  const failedStep = workflowRepo.updateStep(step.id, { error }) ?? step;
  broadcastStep('workflow_step:created', run.room_id, failedStep);
}

function handleAnalysisDecisions(run: WorkflowRun, step: WorkflowStep, output: string): void {
  const request = parseDecisionRequest(output);
  const blockingDecisions = request.decisions.filter((decision) => decision.blocking);
  if (request.decisions.length > 0) {
    const artifact = workflowRepo.createArtifact({
      task_id: run.task_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      artifact_type: 'decision_request',
      title: '待决策问题',
      content: formatDecisionRequest(request),
      metadata: request,
    });
    broadcastArtifact(run.room_id, artifact);
  }

  if (blockingDecisions.length === 0) {
    startAgentStage(run, requireTask(run.task_id), 'planning');
    return;
  }

  const task = requireTask(run.task_id);
  if (task.interaction_mode === 'auto_recommended') {
    const response = buildRecommendedDecisionResponse(request.decisions);
    const artifact = workflowRepo.createArtifact({
      task_id: run.task_id,
      workflow_run_id: run.id,
      workflow_step_id: step.id,
      artifact_type: 'decision_response',
      title: '系统推荐决策',
      content: formatDecisionResponse(response),
      metadata: response,
    });
    broadcastArtifact(run.room_id, artifact);
    startAgentStage(run, task, 'planning');
    return;
  }

  const updated = workflowRepo.updateRun(run.id, {
    status: 'awaiting_decision',
    current_stage: 'analysis',
    error: null,
  });
  if (updated) broadcastWorkflow('workflow:updated', updated);
  const waitingStep = workflowRepo.updateStep(step.id, { status: 'awaiting_approval' });
  if (waitingStep) broadcastStep('workflow_step:updated', run.room_id, waitingStep);
}

function latestDecisionRequestArtifact(workflowRunId: string): TaskArtifact | undefined {
  return [...workflowRepo.listArtifacts(workflowRunId)]
    .reverse()
    .find((artifact) => artifact.artifact_type === 'decision_request');
}

function parseDecisionMetadata(metadata: string | null): ParsedDecisionRequest {
  if (!metadata) throw new Error('decision request is missing metadata');
  return parseDecisionRequest(metadata);
}

function buildRecommendedDecisionResponse(decisions: ParsedDecisionItem[]): {
  decidedBy: string;
  answers: Array<{ decisionId: string; optionId: string; question: string; label: string; description: string }>;
} {
  return buildDecisionResponse(
    decisions,
    decisions.map((decision) => ({
      decisionId: decision.id,
      optionId: decision.recommendedOptionId,
    })),
    'system:auto_recommended',
  );
}

function buildDecisionResponse(
  decisions: ParsedDecisionItem[],
  answers: Array<{ decisionId: string; optionId: string }>,
  decidedBy: string,
): {
  decidedBy: string;
  answers: Array<{ decisionId: string; optionId: string; question: string; label: string; description: string }>;
} {
  const answerByDecision = new Map(answers.map((answer) => [answer.decisionId, answer.optionId]));
  const normalized = decisions.map((decision) => {
    const optionId = answerByDecision.get(decision.id);
    if (!optionId) throw new Error(`missing answer for decision ${decision.id}`);
    const option = decision.options.find((item) => item.id === optionId);
    if (!option) throw new Error(`invalid option ${optionId} for decision ${decision.id}`);
    return {
      decisionId: decision.id,
      optionId: option.id,
      question: decision.question,
      label: option.label,
      description: option.description,
    };
  });
  return { decidedBy, answers: normalized };
}

function formatDecisionRequest(request: ParsedDecisionRequest): string {
  if (request.decisions.length === 0) return '没有需要用户决策的问题。';
  return request.decisions
    .map((decision, index) => {
      const options = decision.options
        .map((option) => {
          const suffix = option.id === decision.recommendedOptionId ? '（推荐）' : '';
          return `- ${option.label}${suffix}：${option.description}`;
        })
        .join('\n');
      return `${index + 1}. ${decision.question}\n原因：${decision.reason || '未说明'}\n${options}`;
    })
    .join('\n\n');
}

function formatDecisionResponse(response: {
  decidedBy: string;
  answers: Array<{ question: string; label: string; description: string }>;
}): string {
  return [
    `决策来源：${response.decidedBy}`,
    '',
    ...response.answers.map((answer, index) =>
      `${index + 1}. ${answer.question}\n选择：${answer.label}\n说明：${answer.description || '无'}`,
    ),
  ].join('\n');
}

function startAgentStage(run: WorkflowRun, task: Task, stage: WorkflowStage): void {
  const context = getContext(run);
  const agent = selectAgent(stage, context.agents);
  if (!agent) {
    failStageWithoutAgent(run, task, stage, `No available agent for workflow stage ${stage}`);
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

  void respondAsAgent({
    agent,
    projectPath: context.project.path,
    roomId: run.room_id,
    prompt,
    taskId: task.id,
    workflowRunId: run.id,
    workflowStepId: step.id,
    workflowStage: stage,
    onRunCreated: (agentRun) => {
      const boundStep = workflowRepo.updateStep(step.id, { agent_run_id: agentRun.id });
      if (boundStep) broadcastStep('workflow_step:updated', run.room_id, boundStep);
    },
    onFinished: ({ run: agentRun, message, status }) =>
      safelyHandleAgentStageFinished(run.id, step.id, agentRun, message, status),
  }).catch((err) => {
    void safelyHandleAgentStageStartFailed(run.id, step.id, (err as Error).message);
  });
}

async function safelyHandleAgentStageStartFailed(
  workflowRunId: string,
  stepId: string,
  error: string,
): Promise<void> {
  const run = workflowRepo.getRun(workflowRunId);
  const step = workflowRepo.getStep(stepId);
  if (!run || !step) return;
  markStepFailed(run, step, error);
  block(run, error);
}

async function safelyHandleAgentStageFinished(
  workflowRunId: string,
  stepId: string,
  agentRun: AgentRun,
  message: Message,
  status: AgentRun['status'],
): Promise<void> {
  try {
    await handleAgentStageFinished(workflowRunId, stepId, agentRun, message, status);
  } catch (err) {
    const error = `Workflow orchestration failed: ${(err as Error).message}`;
    const run = workflowRepo.getRun(workflowRunId);
    const step = workflowRepo.getStep(stepId);
    if (run && step && step.status !== 'failed') markStepFailed(run, step, error, agentRun, message);
    if (run) block(run, error);
  }
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
  if (step.status === 'completed' || step.status === 'failed' || step.status === 'cancelled' || step.status === 'skipped') {
    return;
  }
  if (run.status === 'cancelled') {
    const cancelledStep = workflowRepo.updateStep(step.id, {
      status: 'cancelled',
      agent_run_id: agentRun.id,
      result: message.content,
      result_message_id: message.id,
      error: agentRun.error ?? 'Workflow cancelled',
    });
    if (cancelledStep) broadcastStep('workflow_step:updated', run.room_id, cancelledStep);
    return;
  }
  if (status !== 'completed') {
    markStepFailed(
      run,
      step,
      agentRun.error ?? agentRun.stderr ?? 'Agent run failed',
      agentRun,
      message,
      status === 'cancelled' ? 'cancelled' : 'failed',
    );
    if (step.stage === 'implementation') updateTaskStatus(step.task_id, 'failed');
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
    handleAnalysisDecisions(run, step, message.content);
    return;
  }

  if (step.stage === 'planning') {
    finishPlanning(run, step, message.content);
    return;
  }

  if (step.stage === 'implementation') {
    updateTaskStatus(step.task_id, 'review');
    continueImplementationOrReview(run);
    return;
  }

  if (step.stage === 'code_review') {
    finishReview(run, step, message.content);
    return;
  }

  if (step.stage === 'acceptance') {
    finishAcceptance(run, step, message.content);
  }
}

function finishPlanning(run: WorkflowRun, step: WorkflowStep, output: string): void {
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
    const updated = workflowRepo.updateRun(run.id, {
      status: 'awaiting_approval',
      current_stage: 'planning',
      error: null,
    });
    if (updated) broadcastWorkflow('workflow:updated', updated);
    const waitingStep = workflowRepo.updateStep(step.id, { status: 'awaiting_approval' });
    if (waitingStep) broadcastStep('workflow_step:updated', run.room_id, waitingStep);
  } catch (err) {
    markStepFailed(run, step, (err as Error).message);
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

function assignFromPlan(run: WorkflowRun): void {
  const existingAssignment = workflowRepo
    .listSteps(run.id)
    .find((step) => step.stage === 'assignment' && step.status === 'completed');
  if (existingAssignment) {
    continueImplementationOrReview(run);
    return;
  }
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
    const child = taskRepo.create({
      room_id: task.room_id,
      project_id: task.project_id,
      parent_task_id: task.id,
      title: item.title,
      description: `${item.description}\n\n验收点：\n${item.acceptance.map((point) => `- ${point}`).join('\n')}`,
      priority: item.priority,
      assigned_agent_id: assigned?.id,
    });
    broadcastTask('task:created', child);
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
  continueImplementationOrReview(run);
}

function selectAgentForRole(role: WorkflowRole, agents: RoomAgent[]): RoomAgent | null {
  const candidates = agents.filter((agent) => agent.workflow_role === role);
  if (candidates.length === 0 && role !== 'executor') return selectAgentForRole('executor', agents);
  if (candidates.length === 0) return null;
  return candidates.find((agent) => agent.acp_enabled) ?? candidates[0] ?? null;
}

function continueImplementationOrReview(run: WorkflowRun): void {
  const children = taskRepo.listChildren(run.task_id);
  const nextChild = children.find((task) => task.status === 'todo' || task.status === 'in_progress');
  if (nextChild) {
    const assigned = nextChild.assigned_agent_id ? roomAgentRepo.get(nextChild.assigned_agent_id) : null;
    const agents = roomAgentRepo.listByRoom(run.room_id);
    const agent = assigned ?? selectAgentForRole('executor', agents);
    if (!agent) {
      failStageWithoutAgent(run, nextChild, 'implementation', 'No executor available for implementation');
      return;
    }
    updateTaskStatus(nextChild.id, 'in_progress');
    startAgentStageWithAgent(run, nextChild, 'implementation', agent);
    return;
  }
  startAgentStage(run, requireTask(run.task_id), 'code_review');
}

function startAgentStageWithAgent(run: WorkflowRun, task: Task, stage: WorkflowStage, agent: RoomAgent): void {
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
  void respondAsAgent({
    agent,
    projectPath: context.project.path,
    roomId: run.room_id,
    prompt,
    taskId: task.id,
    workflowRunId: run.id,
    workflowStepId: step.id,
    workflowStage: stage,
    onRunCreated: (agentRun) => {
      const boundStep = workflowRepo.updateStep(step.id, { agent_run_id: agentRun.id });
      if (boundStep) broadcastStep('workflow_step:updated', run.room_id, boundStep);
    },
    onFinished: ({ run: agentRun, message, status }) =>
      safelyHandleAgentStageFinished(run.id, step.id, agentRun, message, status),
  }).catch((err) => {
    void safelyHandleAgentStageStartFailed(run.id, step.id, (err as Error).message);
  });
}

function finishReview(run: WorkflowRun, step: WorkflowStep, output: string): void {
  const artifact = workflowRepo.createArtifact({
    task_id: run.task_id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    artifact_type: 'review',
    title: '代码审查',
    content: output,
  });
  broadcastArtifact(run.room_id, artifact);
  let verdict: ReturnType<typeof parseReviewVerdict>;
  try {
    verdict = parseReviewVerdict(output);
  } catch (err) {
    markStepFailed(run, step, (err as Error).message);
    block(run, `Code review output is not valid JSON verdict: ${(err as Error).message}`);
    return;
  }
  if (verdict.verdict === 'changes_requested') {
    markStepFailed(run, step, 'Code review requested changes');
    block(run, 'Code review requested changes');
    return;
  }
  if (verdict.verdict === 'failed') {
    markStepFailed(run, step, 'Code review failed');
    block(run, 'Code review failed');
    return;
  }
  startAgentStage(run, requireTask(run.task_id), 'acceptance');
}

function finishAcceptance(run: WorkflowRun, step: WorkflowStep, output: string): void {
  const artifact = workflowRepo.createArtifact({
    task_id: run.task_id,
    workflow_run_id: run.id,
    workflow_step_id: step.id,
    artifact_type: 'acceptance',
    title: '功能验收',
    content: output,
  });
  broadcastArtifact(run.room_id, artifact);
  let verdict: ReturnType<typeof parseAcceptanceVerdict>;
  try {
    verdict = parseAcceptanceVerdict(output);
  } catch (err) {
    markStepFailed(run, step, (err as Error).message);
    updateTaskStatus(run.task_id, 'failed');
    const updated = workflowRepo.updateRun(run.id, {
      status: 'failed',
      current_stage: 'acceptance',
      error: `Acceptance output is not valid JSON verdict: ${(err as Error).message}`,
    });
    if (updated) broadcastWorkflow('workflow:updated', updated);
    return;
  }
  if (verdict.verdict === 'pass') {
    for (const child of taskRepo.listChildren(run.task_id).filter((task) => task.status === 'review')) {
      updateTaskStatus(child.id, 'done');
    }
    updateTaskStatus(run.task_id, 'done');
    const updated = workflowRepo.updateRun(run.id, { status: 'completed', current_stage: 'acceptance', error: null });
    if (updated) broadcastWorkflow('workflow:updated', updated);
  } else {
    markStepFailed(run, step, 'Acceptance failed');
    updateTaskStatus(run.task_id, 'failed');
    const updated = workflowRepo.updateRun(run.id, {
      status: 'failed',
      current_stage: 'acceptance',
      error: 'Acceptance failed',
    });
    if (updated) broadcastWorkflow('workflow:updated', updated);
  }
}
