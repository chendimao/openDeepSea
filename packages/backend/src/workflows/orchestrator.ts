import { respondAsAgent } from '../dispatcher.js';
import { db, now } from '../db.js';
import { formatMemoryContext } from '../memory/context.js';
import { distillFromTask } from '../memory/distill.js';
import { agentRunRepo } from '../repos/agent-runs.js';
import { memoryRepo } from '../repos/memory.js';
import { projectRepo } from '../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../repos/rooms.js';
import { settingsRepo } from '../repos/settings.js';
import { taskRepo } from '../repos/tasks.js';
import { workflowRepo } from '../repos/workflows.js';
import { runRegistry } from '../run-registry.js';
import { recordTaskEvent } from '../task-conversation.js';
import { wsHub } from '../ws-hub.js';
import {
  parseAcceptanceVerdict,
  parseDecisionRequest,
  parsePlanArtifact,
  parseReviewVerdict,
  type ParsedAcceptanceVerdict,
  type ParsedDecisionItem,
  type ParsedDecisionRequest,
  type ParsedPlan,
} from './plan-parser.js';
import {
  LangChainPlannerError,
  generateLangChainPlan,
  getRuntimeLangChainPlannerConfig,
  type LangChainPlannerConfig,
} from './langchain-planner.js';
import { getLangGraphWorkflowConfig } from './graph/runtime-config.js';
import {
  approveGraphWorkflow,
  cancelGraphWorkflow,
  recoverGraphWorkflow,
  retryGraphWorkflow,
  startGraphWorkflow,
} from './graph/runtime.js';
import type { GraphRuntimeDeps } from './graph/tools.js';
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

const MAX_TASK_SUMMARY_MEMORY_CHARS = 4000;
const MAX_TASK_SUMMARY_NOTES_CHARS = 2000;
const PLANNER_RECENT_MESSAGE_LIMIT = 20;
const PLANNER_RECENT_MESSAGE_MAX_CHARS = 1000;
const PLANNER_RECENT_MESSAGES_TOTAL_MAX_CHARS = 8000;
const TRUNCATED_MARKER = '...';

let workflowOrchestratorGraphDeps: GraphRuntimeDeps = {};

export function setWorkflowOrchestratorGraphDeps(deps: GraphRuntimeDeps): void {
  workflowOrchestratorGraphDeps = deps;
}

export const workflowOrchestrator = {
  async start(taskId: string): Promise<WorkflowRun> {
    if (getLangGraphWorkflowConfig().enabled) {
      return startGraphWorkflow(taskId, workflowOrchestratorGraphDeps);
    }
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
    safelyRecordWorkflowEvent({
      run,
      task,
      eventType: 'workflow_started',
      content: `工作流已启动，进入 ${run.current_stage ?? 'analysis'} 阶段。`,
    });
    startAgentStage(run, task, 'analysis');
    return latestRun(run.id);
  },

  detail(id: string) {
    return workflowRepo.detail(id);
  },

  async approvePlan(id: string, approvedBy = 'user'): Promise<WorkflowRun> {
    const run = requireRun(id);
    if (run.graph_version) return approveGraphWorkflow(id, approvedBy, workflowOrchestratorGraphDeps);
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
    const task = requireTask(updated.task_id);
    startAgentStage(updated, task, 'planning');
    return latestRun(updated.id);
  },

  async cancel(id: string): Promise<WorkflowRun> {
    const run = requireRun(id);
    if (run.graph_version) return cancelGraphWorkflow(id);
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
    const task = taskRepo.get(run.task_id);
    if (task) {
      safelyRecordWorkflowEvent({
        run: updated,
        task,
        eventType: 'workflow_cancelled',
        content: '工作流已取消。',
      });
    }
    return updated;
  },

  async retryStep(id: string): Promise<WorkflowRun> {
    const run = requireRun(id);
    if (run.graph_version) return retryGraphWorkflow(id, workflowOrchestratorGraphDeps);
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
      .find((step) => step.status === 'failed' || step.status === 'cancelled' || step.status === 'interrupted');
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
      const retryAgent = retryableStep.room_agent_id ? roomAgentRepo.get(retryableStep.room_agent_id) : null;
      if (retryAgent) {
        startAgentStageWithAgent(updated, task, retryableStep.stage, retryAgent, getRetrySessionId(retryableStep));
      } else {
        startAgentStage(updated, task, retryableStep.stage, getRetrySessionId(retryableStep));
      }
    }
    return latestRun(updated.id);
  },

  recoverOrphanedSteps(error: string): number {
    let count = recoverGraphWorkflow(error);
    for (const step of workflowRepo.listRunningSteps()) {
      if (step.node_name) continue;
      const run = workflowRepo.getRun(step.workflow_run_id);
      if (run?.graph_version) continue;
      if (!run || run.status === 'cancelled' || run.status === 'completed') continue;
      const interruptedStep = workflowRepo.updateStep(step.id, { status: 'interrupted', error });
      if (interruptedStep) broadcastStep('workflow_step:updated', run.room_id, interruptedStep);
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

export function shouldUseLangChainPlanner(stage: WorkflowStage, config: LangChainPlannerConfig): boolean {
  return stage === 'planning' && config.enabled;
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
  if (!updated) return;
  broadcastWorkflow('workflow:updated', updated);
  const task = taskRepo.get(updated.task_id);
  if (!task) return;
  safelyRecordWorkflowEvent({
    run: updated,
    task,
    eventType: 'workflow_blocked',
    content: `工作流已阻塞：${error}`,
  });
}

function updateTaskStatus(taskId: string, status: TaskStatus): Task | undefined {
  const before = taskRepo.get(taskId);
  const task = taskRepo.updateStatus(taskId, status);
  if (task) {
    broadcastTask('task:updated', task);
    if (before && before.status !== task.status) {
      try {
        recordTaskEvent({
          roomId: task.room_id,
          taskId: task.id,
          taskTitle: task.title,
          eventType: 'task_status_changed',
          content: `任务「${task.title}」状态变更为 ${task.status}`,
        });
      } catch (err) {
        console.warn(`[workflow] failed to record task status event: ${(err as Error).message}`);
      }
    }
  }
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
  if (updatedRun) {
    broadcastWorkflow('workflow:updated', updatedRun);
    safelyRecordWorkflowEvent({
      run: updatedRun,
      task,
      eventType: 'workflow_blocked',
      content: `任务「${task.title}」工作流已阻塞：${error}`,
    });
  }
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
  const task = requireTask(run.task_id);
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
    startAgentStage(run, task, 'planning');
    return;
  }

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

function startAgentStage(
  run: WorkflowRun,
  task: Task,
  stage: WorkflowStage,
  resumeSessionId?: string | null,
): void {
  const plannerConfig = getRuntimeLangChainPlannerConfig();
  if (shouldUseLangChainPlanner(stage, plannerConfig)) {
    startLangChainPlanningStage(run, task);
    return;
  }

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
    memoryContext: buildWorkflowMemoryContext(context.project.id, context.room.id, agent.id, task.id),
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
  safelyRecordWorkflowEvent({
    run: updatedRun ?? run,
    task,
    eventType: 'workflow_stage_changed',
    workflowStepId: step.id,
    content: `工作流进入 ${stage} 阶段。`,
  });

  void respondAsAgent({
    agent: resumeSessionId ? { ...agent, acp_session_id: resumeSessionId } : agent,
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

function startLangChainPlanningStage(run: WorkflowRun, task: Task): void {
  const context = getContext(run);
  const prompt = 'LangChain planner service will generate the structured planning artifact.';
  const step = workflowRepo.createStep({
    workflow_run_id: run.id,
    task_id: task.id,
    stage: 'planning',
    status: 'running',
    prompt,
    sort_order: nextSortOrder(run.id),
  });
  broadcastStep('workflow_step:created', run.room_id, step);
  const updatedRun = workflowRepo.updateRun(run.id, { status: 'running', current_stage: 'planning', error: null });
  if (updatedRun) broadcastWorkflow('workflow:updated', updatedRun);
  safelyRecordWorkflowEvent({
    run: updatedRun ?? run,
    task,
    eventType: 'workflow_stage_changed',
    workflowStepId: step.id,
    content: '工作流进入 planning 阶段。',
  });

  const memoryContext = buildPlannerMemoryContext(context.project.id, context.room.id, task.id);
  void generateLangChainPlan({
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task,
    agents: context.agents,
    memories: memoryContext ? [memoryContext] : [],
    recentMessages: buildPlannerRecentMessages(context.room.id),
  })
    .then((plan) => {
      const latest = workflowRepo.getRun(run.id);
      const latestStep = workflowRepo.getStep(step.id);
      if (!latest || !latestStep || shouldSkipAsyncWorkflowCompletion(latest, latestStep)) return;
      const output = formatParsedPlanArtifact(plan);
      const completedStep = workflowRepo.updateStep(latestStep.id, { status: 'completed', result: output });
      if (completedStep) broadcastStep('workflow_step:updated', latest.room_id, completedStep);
      finishPlanning(latest, completedStep ?? latestStep, output);
    })
    .catch((err) => {
      const latest = workflowRepo.getRun(run.id);
      const latestStep = workflowRepo.getStep(step.id);
      if (!latest || !latestStep || shouldSkipAsyncWorkflowCompletion(latest, latestStep)) return;
      const error = (err as Error).message;
      markStepFailed(latest, latestStep, error);
      if (err instanceof LangChainPlannerError) {
        const artifact = workflowRepo.createArtifact({
          task_id: latest.task_id,
          workflow_run_id: latest.id,
          workflow_step_id: latestStep.id,
          artifact_type: 'plan',
          title: '未解析计划',
          content: err.rawOutput,
        });
        broadcastArtifact(latest.room_id, artifact);
      }
      block(latest, error);
    });
}

function buildPlannerRecentMessages(roomId: string): string[] {
  try {
    const messages = db
      .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(roomId, PLANNER_RECENT_MESSAGE_LIMIT) as Message[];
    return formatRecentMessagesForPlanner(messages.reverse(), {
      limit: PLANNER_RECENT_MESSAGE_LIMIT,
      maxMessageChars: PLANNER_RECENT_MESSAGE_MAX_CHARS,
      maxTotalChars: PLANNER_RECENT_MESSAGES_TOTAL_MAX_CHARS,
    });
  } catch (err) {
    console.warn(`[workflow] failed to load planner recent messages: ${(err as Error).message}`);
    return [];
  }
}

export function formatRecentMessagesForPlanner(
  messages: Message[],
  options: { limit?: number; maxMessageChars?: number; maxTotalChars?: number } = {},
): string[] {
  const limit = Math.max(0, options.limit ?? PLANNER_RECENT_MESSAGE_LIMIT);
  if (limit === 0) return [];
  const maxMessageChars = Math.max(1, options.maxMessageChars ?? PLANNER_RECENT_MESSAGE_MAX_CHARS);
  const maxTotalChars = Math.max(1, options.maxTotalChars ?? PLANNER_RECENT_MESSAGES_TOTAL_MAX_CHARS);
  const latestMessages = messages.slice(-limit);
  const formatted: string[] = [];
  let totalChars = 0;

  for (const message of latestMessages) {
    const sender = message.sender_name ?? message.sender_id;
    const content = truncatePlannerText(message.content, maxMessageChars);
    const line = `${message.sender_type}:${sender}: ${content}`;
    const separatorChars = formatted.length > 0 ? 1 : 0;
    if (totalChars + separatorChars + line.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars - separatorChars;
      if (remaining <= TRUNCATED_MARKER.length) break;
      formatted.push(truncatePlannerText(line, remaining));
      break;
    }
    formatted.push(line);
    totalChars += separatorChars + line.length;
  }

  return formatted;
}

export function shouldSkipAsyncWorkflowCompletion(run: WorkflowRun, step: WorkflowStep): boolean {
  return run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed' || isTerminalStep(step);
}

function isTerminalStep(step: WorkflowStep): boolean {
  return (
    step.status === 'completed' ||
    step.status === 'failed' ||
    step.status === 'cancelled' ||
    step.status === 'interrupted' ||
    step.status === 'skipped'
  );
}

function truncatePlannerText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATED_MARKER.length) return TRUNCATED_MARKER.slice(0, maxChars);
  return `${text.slice(0, maxChars - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`;
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
  if (
    step.status === 'completed' ||
    step.status === 'failed' ||
    step.status === 'cancelled' ||
    step.status === 'interrupted' ||
    step.status === 'skipped'
  ) {
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
    const task = requireTask(run.task_id);
    if (!plan.needsApproval) {
      const completedStep = workflowRepo.updateStep(step.id, { status: 'completed', result: output });
      if (completedStep) broadcastStep('workflow_step:updated', run.room_id, completedStep);
      const updated = workflowRepo.updateRun(run.id, {
        status: 'running',
        current_stage: 'assignment',
        error: null,
      });
      const approvedAt = now();
      db.prepare('UPDATE workflow_runs SET approval_required = 0, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?')
        .run(approvedAt, 'system:langchain_planner', approvedAt, run.id);
      const autoApprovedRun = workflowRepo.getRun(run.id) ?? updated ?? run;
      broadcastWorkflow('workflow:updated', autoApprovedRun);
      safelyRecordWorkflowEvent({
        run: autoApprovedRun,
        task,
        eventType: 'workflow_plan_ready',
        workflowStepId: step.id,
        content: '规划阶段已完成，无需审批，自动进入 assignment 阶段。',
      });
      assignFromPlan(autoApprovedRun);
      return;
    }

    const updated = workflowRepo.updateRun(run.id, {
      status: 'awaiting_approval',
      current_stage: 'planning',
      error: null,
    });
    if (updated) broadcastWorkflow('workflow:updated', updated);
    const waitingStep = workflowRepo.updateStep(step.id, { status: 'awaiting_approval' });
    if (waitingStep) broadcastStep('workflow_step:updated', run.room_id, waitingStep);
    safelyRecordWorkflowEvent({
      run: updated ?? run,
      task,
      eventType: 'workflow_plan_ready',
      workflowStepId: step.id,
      content: '规划阶段已完成，等待审批。',
    });
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
      created_from: 'workflow_assignment',
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
  safelyRecordWorkflowEvent({
    run,
    task,
    eventType: 'workflow_assignment_created',
    workflowStepId: step.id,
    origin: 'workflow_assignment',
    content: `已根据计划为任务「${task.title}」创建 ${plan.tasks.length} 个子任务。`,
  });
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
  const task = requireTask(run.task_id);
  startAgentStage(run, task, 'code_review');
}

function startAgentStageWithAgent(
  run: WorkflowRun,
  task: Task,
  stage: WorkflowStage,
  agent: RoomAgent,
  resumeSessionId?: string | null,
): void {
  const context = getContext(run);
  const prompt = buildStagePrompt(stage, {
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task,
    agents: context.agents,
    artifacts: context.artifacts,
    memoryContext: buildWorkflowMemoryContext(context.project.id, context.room.id, agent.id, task.id),
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
  safelyRecordWorkflowEvent({
    run: updatedRun ?? run,
    task,
    eventType: 'workflow_stage_changed',
    workflowStepId: step.id,
    content: `工作流进入 ${stage} 阶段。`,
  });
  void respondAsAgent({
    agent: resumeSessionId ? { ...agent, acp_session_id: resumeSessionId } : agent,
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

function getRetrySessionId(step: WorkflowStep): string | null {
  if (!step.agent_run_id) return null;
  return agentRunRepo.get(step.agent_run_id)?.acp_session_id ?? null;
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
  const task = requireTask(run.task_id);
  startAgentStage(run, task, 'acceptance');
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
    rememberAcceptedTask(run, verdict);
    const updated = workflowRepo.updateRun(run.id, { status: 'completed', current_stage: 'acceptance', error: null });
    if (updated) {
      broadcastWorkflow('workflow:updated', updated);
      const task = requireTask(run.task_id);
      safelyRecordWorkflowEvent({
        run: updated,
        task,
        eventType: 'workflow_completed',
        workflowStepId: step.id,
        content: '工作流已完成。',
      });
    }
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

function safelyRecordWorkflowEvent(input: {
  run: WorkflowRun;
  task: Task;
  eventType:
    | 'workflow_started'
    | 'workflow_stage_changed'
    | 'workflow_plan_ready'
    | 'workflow_assignment_created'
    | 'workflow_blocked'
    | 'workflow_completed'
    | 'workflow_cancelled'
    | 'workflow_failed'
    | 'workflow_memory_written';
  content: string;
  workflowStepId?: string | null;
  origin?: 'workflow_assignment';
}): void {
  try {
    recordTaskEvent({
      roomId: input.run.room_id,
      taskId: input.task.id,
      taskTitle: input.task.title,
      workflowRunId: input.run.id,
      workflowStepId: input.workflowStepId ?? null,
      eventType: input.eventType,
      origin: input.origin,
      content: input.content,
    });
  } catch (err) {
    console.warn(`[workflow] failed to record task event ${input.eventType}: ${(err as Error).message}`);
  }
}

export function buildWorkflowMemoryContext(
  projectId: string,
  roomId: string,
  roomAgentId: string,
  taskId: string,
): string {
  try {
    return formatMemoryContext(memoryRepo.listForRoomContext({
      projectId,
      roomId,
      roomAgentId,
      taskId,
    }));
  } catch (err) {
    console.warn(`[memory] failed to load workflow memory context: ${(err as Error).message}`);
    return '';
  }
}

export function buildPlannerMemoryContext(projectId: string, roomId: string, taskId: string): string {
  try {
    return formatMemoryContext(memoryRepo.listForRoomContext({
      projectId,
      roomId,
      taskId,
    }));
  } catch (err) {
    console.warn(`[memory] failed to load planner memory context: ${(err as Error).message}`);
    return '';
  }
}

export function formatParsedPlanArtifact(plan: ParsedPlan): string {
  const artifact = {
    goal: plan.goal ?? plan.summary,
    summary: plan.summary,
    assumptions: plan.assumptions,
    steps: plan.tasks.map((task) => ({
      title: task.title,
      intent: task.description,
      assigneeRole: task.suggestedRole,
      ...(task.preferredBackend ? { preferredBackend: task.preferredBackend } : {}),
      scopeRead: task.scopeRead,
      scopeWrite: task.scopeWrite,
      acceptance: task.acceptance,
      dependsOn: task.dependsOn,
    })),
    risks: plan.risks,
    verification: plan.verification.map((command) => ({
      command,
      reason: '',
      required: true,
    })),
    needsApproval: plan.needsApproval,
  };
  return `\`\`\`json\n${JSON.stringify(artifact, null, 2)}\n\`\`\``;
}

export function rememberAcceptedTask(run: WorkflowRun, verdict: ParsedAcceptanceVerdict): void {
  try {
    const completedTask = requireTask(run.task_id);
    memoryRepo.upsertTaskSummary({
      project_id: run.project_id,
      room_id: run.room_id,
      task_id: run.task_id,
      title: `任务完成：${completedTask.title}`,
      content: buildTaskSummaryMemoryContent(completedTask.title, verdict),
      source_id: run.id,
    });
    const autoDistillEnabled = settingsRepo.resolveForRoom(run.room_id)?.effective.auto_distill_enabled ?? true;
    if (!autoDistillEnabled) return;

    // Async deep distillation from full task conversation
    distillFromTask({
      projectId: run.project_id,
      roomId: run.room_id,
      taskId: run.task_id,
      taskTitle: completedTask.title,
      taskSummary: buildTaskSummaryMemoryContent(completedTask.title, verdict),
      sourceId: run.id,
    }).catch((err) => console.warn(`[distill] task distill error: ${(err as Error).message}`));
  } catch (err) {
    console.warn(`[memory] failed to save workflow task summary: ${(err as Error).message}`);
  }
}

export function buildTaskSummaryMemoryContent(taskTitle: string, verdict: ParsedAcceptanceVerdict): string {
  const sections = [
    `任务：${taskTitle}`,
    `验收结论：${verdict.verdict === 'pass' ? '通过' : '未通过'}`,
  ];
  if (verdict.notes.trim()) {
    sections.push('', '验收说明：', truncateText(verdict.notes.trim(), MAX_TASK_SUMMARY_NOTES_CHARS));
  }
  if (verdict.acceptedCriteria.length > 0) {
    sections.push('', '通过标准：', ...verdict.acceptedCriteria.map((item) => `- ${item}`));
  }
  if (verdict.failedCriteria.length > 0) {
    sections.push('', '未通过标准：', ...verdict.failedCriteria.map((item) => `- ${item}`));
  }
  return truncateTaskSummaryMemory(sections.join('\n'));
}

function truncateTaskSummaryMemory(content: string): string {
  return truncateText(content, MAX_TASK_SUMMARY_MEMORY_CHARS);
}

function truncateText(content: string, maxChars: number): string {
  const marker = '...已截断';
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars - marker.length)}${marker}`;
}
