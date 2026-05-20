import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { agentRunRepo } from '../../repos/agent-runs.js';
import { projectRepo } from '../../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowDefinitionRepo } from '../../repos/workflow-definitions.js';
import { workflowRepo } from '../../repos/workflows.js';
import { runRegistry } from '../../run-registry.js';
import { recordTaskEvent } from '../../task-conversation.js';
import type { WorkflowDefinition, WorkflowDefinitionGraph, WorkflowDefinitionNodeType, WorkflowRun } from '../../types.js';
import type { WorkflowSupervisorDecision } from '../supervisor.js';
import { generateWorkflowSupervisorDecision } from '../supervisor.js';
import { createGraphNodes } from './nodes.js';
import { routeAfterApproval, routeAfterExecute, routeAfterRepairDecision, routeAfterReview } from './router.js';
import { emptyAgentWorkflowState, parseGraphState, serializeGraphState, type AgentWorkflowState } from './state.js';
import {
  buildSuperpowersRuntimeGraph,
  isSuperpowersDefinitionGraph,
  SUPERPOWERS_GRAPH_VERSION,
  SUPERPOWERS_RUNTIME_PROFILE,
  SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
  type SuperpowersRuntimeGraph,
} from './superpowers-runtime.js';
import type { SuperpowersExecutionNodeName, SuperpowersPlanningNodeName } from './superpowers-nodes.js';
import { createGraphTools, type GraphRuntimeDeps } from './tools.js';
import { mapVerificationResultsToEvidence } from './verification.js';

const GraphState = Annotation.Root({
  workflowRunId: Annotation<string>(),
  projectId: Annotation<string>(),
  roomId: Annotation<string>(),
  taskId: Annotation<string>(),
  userGoal: Annotation<string>(),
  projectPath: Annotation<string>(),
  plan: Annotation<AgentWorkflowState['plan']>(),
  workflowPlan: Annotation<AgentWorkflowState['workflowPlan']>(),
  currentNode: Annotation<AgentWorkflowState['currentNode']>(),
  currentStepId: Annotation<string | null>(),
  activeAgentRunId: Annotation<string | null>(),
  childTaskIds: Annotation<string[]>(),
  childTaskPlanIndexes: Annotation<AgentWorkflowState['childTaskPlanIndexes']>(),
  supervisorAssignments: Annotation<AgentWorkflowState['supervisorAssignments']>(),
  reviewFindings: Annotation<string[]>(),
  reviewVerdict: Annotation<AgentWorkflowState['reviewVerdict']>(),
  verificationResults: Annotation<AgentWorkflowState['verificationResults']>(),
  repairAttempts: Annotation<number>(),
  approval: Annotation<AgentWorkflowState['approval']>(),
  status: Annotation<AgentWorkflowState['status']>(),
  error: Annotation<string | null>(),
});

const SUPERVISOR_CONFIDENCE_THRESHOLD = 0.75;
const BACKGROUND_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 120_000] as const;

type WorkflowDefinitionSnapshot = {
  id: string;
  name: string;
  description: string | null;
  builtinKey: string | null;
  version: number;
  definition: WorkflowDefinitionGraph;
};

type WorkflowDefinitionSelection = {
  definition: WorkflowDefinition;
  supervisorAssignments?: WorkflowSupervisorDecision['assignments'];
};

type WorkflowRunSelection = {
  supervisorAssignments?: WorkflowSupervisorDecision['assignments'];
};

type SupervisorDepsOverride = {
  defaultSupervisor?: (
    input: Parameters<typeof generateWorkflowSupervisorDecision>[0],
    options?: Parameters<typeof generateWorkflowSupervisorDecision>[2],
  ) => ReturnType<typeof generateWorkflowSupervisorDecision>;
};

function requireTaskContext(taskId: string) {
  const task = taskRepo.get(taskId);
  if (!task) throw new Error('task not found');
  const room = roomRepo.get(task.room_id);
  const project = projectRepo.get(task.project_id);
  if (!room || !project) throw new Error('workflow context is incomplete');
  return { task, room, project };
}

function buildRuntimeGraph(deps: GraphRuntimeDeps = {}) {
  const tools = createGraphTools(deps);
  const nodes = createGraphNodes(tools);

  return new StateGraph(GraphState)
    .addNode('context', nodes.contextNode)
    .addNode('planning', nodes.planningNode)
    .addNode('approval_gate', nodes.approvalNode)
    .addNode('dispatch', nodes.dispatchNode)
    .addNode('execute', nodes.executeNode)
    .addNode('review', nodes.reviewNode)
    .addNode('repair_decision', nodes.repairDecisionNode)
    .addNode('verify', nodes.verifyNode)
    .addNode('acceptance', nodes.acceptanceNode)
    .addNode('memory', nodes.memoryNode)
    .addEdge(START, 'context')
    .addEdge('context', 'planning')
    .addEdge('planning', 'approval_gate')
    .addConditionalEdges('approval_gate', routeAfterApproval)
    .addEdge('dispatch', 'execute')
    .addConditionalEdges('execute', routeAfterExecute)
    .addConditionalEdges('review', routeAfterReview)
    .addConditionalEdges('repair_decision', routeAfterRepairDecision)
    .addConditionalEdges('verify', (state) => {
      if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
      return 'acceptance';
    })
    .addConditionalEdges('acceptance', (state) => {
      if (state.status === 'completed') return 'memory';
      return END;
    })
    .addEdge('memory', END)
    .compile({ checkpointer: new MemorySaver() });
}

export async function startGraphWorkflow(taskId: string, deps: GraphRuntimeDeps = {}): Promise<WorkflowRun> {
  assertTaskCanStartGraphWorkflow(taskId);
  const selection = await resolveWorkflowDefinitionForTask(taskId, deps);
  const run = createGraphWorkflowRun(taskId, selection);
  recordWorkflowStartedEvent(run);
  return continueGraphWorkflow(run.id, deps);
}

export function createGraphWorkflowRun(taskId: string, selection?: WorkflowRunSelection): WorkflowRun {
  const { task, room, project } = requireTaskContext(taskId);
  const existing = workflowRepo.getActiveByTask(task.id);
  if (existing) throw new Error('task already has an active workflow');
  const workflowSelection = resolveSuperpowersWorkflowDefinitionSelection(selection?.supervisorAssignments);
  const definition = workflowSelection.definition;

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
    status: 'running',
    current_stage: 'planning',
    approval_required: true,
    graph_version: SUPERPOWERS_GRAPH_VERSION,
    graph_state: serializeGraphState(pendingState),
    workflow_definition_id: definition.id,
    workflow_definition_version: definition.version,
    workflow_definition_snapshot: JSON.stringify(createWorkflowDefinitionSnapshot(workflowSelection)),
  });

  const initialState: AgentWorkflowState = {
    ...pendingState,
    workflowRunId: run.id,
    runtimeProfile: SUPERPOWERS_RUNTIME_PROFILE,
    supervisorAssignments: workflowSelection.supervisorAssignments ?? [],
  };
  workflowRepo.updateGraphState(run.id, serializeGraphState(initialState));
  return workflowRepo.getRun(run.id) ?? run;
}

function assertTaskCanStartGraphWorkflow(taskId: string): void {
  const { task } = requireTaskContext(taskId);
  const existing = workflowRepo.getActiveByTask(task.id);
  if (existing) throw new Error('task already has an active workflow');
}

async function resolveWorkflowDefinitionForTask(
  taskId: string,
  deps: GraphRuntimeDeps,
): Promise<WorkflowDefinitionSelection> {
  const definition = resolveSuperpowersWorkflowDefinition();
  const supervisorAssignments = await resolveSupervisorAssignmentsForTask(taskId, deps, definition);
  return { definition, supervisorAssignments };
}

function resolveSuperpowersWorkflowDefinitionSelection(
  supervisorAssignments: WorkflowSupervisorDecision['assignments'] = [],
): WorkflowDefinitionSelection {
  return {
    definition: resolveSuperpowersWorkflowDefinition(),
    supervisorAssignments,
  };
}

function resolveSuperpowersWorkflowDefinition(): WorkflowDefinition {
  const definition = workflowDefinitionRepo.getBuiltInByKey(SUPERPOWERS_WORKFLOW_DEFINITION_KEY);
  if (!definition) throw new Error('superpowers-development workflow definition not found');
  return definition;
}

async function resolveSupervisorAssignmentsForTask(
  taskId: string,
  deps: GraphRuntimeDeps,
  definition: WorkflowDefinition,
): Promise<WorkflowSupervisorDecision['assignments']> {
  const { task, room, project } = requireTaskContext(taskId);
  const tools = createGraphTools(deps);
  const defaultSupervisor = (deps as SupervisorDepsOverride).defaultSupervisor;
  const supervisor = deps.supervisor
    ?? defaultSupervisor
    ?? ((input: Parameters<typeof generateWorkflowSupervisorDecision>[0], options?: Parameters<typeof generateWorkflowSupervisorDecision>[2]) =>
      generateWorkflowSupervisorDecision(input, undefined, options));

  try {
    const skillContext = await tools.buildSkillContext({
      runtimeScopes: ['workflow'],
      projectId: project.id,
      roomId: room.id,
      message: [
        task.title,
        task.description ?? '',
        `${definition.name}: ${definition.description ?? ''}`,
      ].filter(Boolean).join('\n\n'),
    });
    const decision = await supervisor({
      project,
      room,
      task,
      agents: roomAgentRepo.listByRoom(room.id),
      workflowDefinitions: [definition],
    }, { skillContext });
    return decision.confidence >= SUPERVISOR_CONFIDENCE_THRESHOLD ? decision.assignments : [];
  } catch {
    return [];
  }
}

function createWorkflowDefinitionSnapshot(selection: WorkflowDefinitionSelection): WorkflowDefinitionSnapshot {
  return {
    id: selection.definition.id,
    name: selection.definition.name,
    description: selection.definition.description,
    builtinKey: selection.definition.builtin_key,
    version: selection.definition.version,
    definition: selection.definition.definition,
  };
}

export function enqueueGraphWorkflow(runId: string, deps: GraphRuntimeDeps = {}): void {
  enqueueGraphWorkflowAttempt(runId, deps, 0);
}

function enqueueGraphWorkflowAttempt(runId: string, deps: GraphRuntimeDeps, attempt: number): void {
  setImmediate(() => {
    void continueGraphWorkflow(runId, deps, { blockOnError: false }).catch((err) => {
      const delayMs = BACKGROUND_RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined && canRetryBackgroundGraphWorkflow(runId)) {
        const error = err instanceof Error ? err.message : String(err);
        markBackgroundGraphWorkflowAttemptInterrupted(runId, error);
        scheduleBackgroundGraphWorkflowRetry(runId, deps, attempt + 1, delayMs, error);
        return;
      }
      handleBackgroundGraphWorkflowError(runId, err);
    });
  });
}

export async function continueGraphWorkflow(
  runId: string,
  deps: GraphRuntimeDeps = {},
  options: { blockOnError?: boolean } = {},
): Promise<WorkflowRun> {
  let state: AgentWorkflowState | null = null;
  try {
    const run = requireGraphRun(runId);
    state = requireGraphStateOrBlock(run);
    const finalState = await resumeGraphWorkflowFromState(state, deps, parseWorkflowDefinitionSnapshot(run));
    workflowRepo.updateGraphState(run.id, serializeGraphState(finalState));
  } catch (err) {
    if (options.blockOnError === false) throw err;
    const error = err instanceof Error ? err.message : String(err);
    const latest = workflowRepo.getRun(runId);
    const parsed = latest ? tryParseGraphState(latest) : null;
    const fallbackState = parsed?.ok ? parsed.state : null;
    const failedState = blockGraphWorkflowRun(runId, fallbackState ?? state, error);
    if (failedState) workflowRepo.updateGraphState(runId, serializeGraphState(failedState));
    const blocked = workflowRepo.getRun(runId);
    if (blocked) createGraphTools(deps).broadcastWorkflowUpdated(blocked);
    throw err;
  }

  const latest = workflowRepo.getRun(runId);
  if (!latest) throw new Error('workflow not found');
  return latest;
}

function scheduleBackgroundGraphWorkflowRetry(
  runId: string,
  deps: GraphRuntimeDeps,
  attempt: number,
  delayMs: number,
  error: string,
): void {
  const retry = () => enqueueGraphWorkflowAttempt(runId, deps, attempt);
  if (deps.scheduleRetry) {
    deps.scheduleRetry({ runId, attempt, delayMs, error }, retry);
    return;
  }
  setTimeout(retry, delayMs);
}

function canRetryBackgroundGraphWorkflow(runId: string): boolean {
  const run = workflowRepo.getRun(runId);
  return Boolean(run && run.status !== 'cancelled' && run.status !== 'completed' && run.status !== 'failed');
}

function markBackgroundGraphWorkflowAttemptInterrupted(runId: string, error: string): void {
  const run = workflowRepo.getRun(runId);
  if (!run) return;
  const tools = createGraphTools();
  for (const step of workflowRepo.listSteps(runId).filter((item) => item.node_name && item.status === 'running')) {
    const interrupted = workflowRepo.updateStep(step.id, {
      status: 'interrupted',
      error,
    });
    if (interrupted) tools.broadcastStepUpdated(run.room_id, interrupted);
  }
}

export function approveGraphWorkflowPlan(id: string, approvedBy = 'user'): WorkflowRun {
  const run = validateGraphWorkflowApproval(id);
  const state = requireGraphStateOrBlock(run);
  const approvedState: AgentWorkflowState = {
    ...state,
    currentNode: 'approval',
    approval: 'approved',
    status: 'running',
    error: null,
  };
  const updated = workflowRepo.updateRun(run.id, {
    status: 'running',
    approved_by: approvedBy,
    error: null,
  });
  if (!updated) throw new Error('workflow not found');
  workflowRepo.updateGraphState(run.id, serializeGraphState(approvedState));
  const task = taskRepo.get(run.task_id);
  if (task) {
    try {
      recordTaskEvent({
        roomId: run.room_id,
        taskId: task.id,
        taskTitle: task.title,
        workflowRunId: run.id,
        eventType: 'workflow_stage_changed',
        content: `已批准任务「${task.title}」的执行计划，继续分配和执行。`,
        metadata: {
          graph_node: 'approval',
          workflow_stage: 'planning',
          approval_status: 'accepted',
          approved_by: approvedBy,
        },
      });
    } catch (err) {
      console.warn(`[graph-runtime] failed to record approval event: ${(err as Error).message}`);
    }
  }
  return workflowRepo.getRun(run.id) ?? updated;
}

export function validateGraphWorkflowApproval(id: string): WorkflowRun {
  const run = requireGraphRun(id);
  if (run.status !== 'awaiting_approval') throw new Error('workflow is not awaiting approval');
  const state = requireGraphStateOrBlock(run);
  if (!state.plan) {
    const error = 'workflow approval requires generated plan';
    const blocked = workflowRepo.updateRun(run.id, { status: 'blocked', error });
    workflowRepo.updateGraphState(run.id, serializeGraphState({
      ...state,
      status: 'blocked',
      error,
    }));
    if (blocked) createGraphTools().broadcastWorkflowUpdated(blocked);
    throw new Error(error);
  }
  return run;
}

export async function approveGraphWorkflow(
  id: string,
  approvedBy = 'user',
  deps: GraphRuntimeDeps = {},
): Promise<WorkflowRun> {
  const run = approveGraphWorkflowPlan(id, approvedBy);
  return continueGraphWorkflow(run.id, deps);
}

export async function retryGraphWorkflow(id: string, deps: GraphRuntimeDeps = {}): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  if (run.status === 'running' || run.status === 'awaiting_approval') {
    throw new Error('workflow is already running');
  }
  if (agentRunRepo.listActiveByWorkflow(run.id).length > 0) {
    throw new Error('workflow already has an active agent run');
  }
  const state = requireGraphStateOrBlock(run);
  const tools = createGraphTools(deps);
  const retryState: AgentWorkflowState = {
    ...state,
    currentNode: retryCurrentNode(state),
    currentStepId: null,
    status: 'running',
    error: null,
    activeAgentRunId: null,
  };
  for (const child of taskRepo.listChildren(run.task_id).filter((item) =>
    state.childTaskIds.includes(item.id) && (item.status === 'failed' || item.status === 'in_progress'),
  )) {
    const resetChild = taskRepo.updateStatus(child.id, 'todo');
    if (resetChild) tools.broadcastTaskUpdated(resetChild);
  }
  for (const step of workflowRepo.listSteps(run.id).filter((item) =>
    item.node_name && (item.status === 'running' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'interrupted'),
  )) {
    workflowRepo.updateStep(step.id, {
      status: 'skipped',
      error: step.error ?? 'Superseded by retry',
    });
  }
  workflowRepo.updateRun(run.id, {
    status: 'running',
    error: null,
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState(retryState));

  const finalState = await resumeGraphWorkflowFromState(retryState, deps, parseWorkflowDefinitionSnapshot(run));
  workflowRepo.updateGraphState(run.id, serializeGraphState(finalState));
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  return latest;
}

export async function cancelGraphWorkflow(id: string): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  const tools = createGraphTools();
  for (const agentRun of tools.listActiveAgentRunsByWorkflow(run.id)) {
    runRegistry.cancel(agentRun.id);
    const cancelledRun = agentRunRepo.updateStatus(agentRun.id, 'cancelled', { error: 'Workflow cancelled' });
    if (cancelledRun) tools.broadcastAgentRunUpdated(run.room_id, cancelledRun);
  }
  for (const step of workflowRepo.listSteps(run.id).filter((item) => item.status === 'running')) {
    const cancelledStep = workflowRepo.updateStep(step.id, {
      status: 'cancelled',
      error: 'Workflow cancelled',
    });
    if (cancelledStep) tools.broadcastStepUpdated(run.room_id, cancelledStep);
  }
  const updated = workflowRepo.updateRun(run.id, {
    status: 'cancelled',
    error: null,
  });
  if (!updated) throw new Error('workflow not found');
  const state = tryParseGraphState(run);
  if (state.ok && state.state) {
    workflowRepo.updateGraphState(run.id, serializeGraphState({
      ...state.state,
      status: 'cancelled',
      error: null,
    }));
  }
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  tools.broadcastWorkflowUpdated(latest);
  const task = taskRepo.get(latest.task_id);
  if (task) {
    try {
      recordTaskEvent({
        roomId: latest.room_id,
        taskId: task.id,
        taskTitle: task.title,
        workflowRunId: latest.id,
        eventType: 'workflow_cancelled',
        content: `任务「${task.title}」的工作流已取消。`,
        metadata: {
          graph_node: 'cancel',
          workflow_stage: latest.current_stage,
        },
      });
    } catch (err) {
      console.warn(`[graph-runtime] failed to record cancellation event: ${(err as Error).message}`);
    }
  }
  return latest;
}

function blockGraphWorkflowRun(
  runId: string,
  state: AgentWorkflowState | null,
  error: string,
): AgentWorkflowState | null {
  const run = workflowRepo.updateRun(runId, {
    status: 'blocked',
    error,
  });
  for (const step of workflowRepo.listSteps(runId).filter((item) => item.status === 'running')) {
    workflowRepo.updateStep(step.id, {
      status: 'failed',
      error,
    });
  }
  if (!state) return null;
  return {
    ...state,
    workflowRunId: run?.id ?? runId,
    status: 'blocked',
    error,
  };
}

function recordWorkflowStartedEvent(run: WorkflowRun): void {
  const task = taskRepo.get(run.task_id);
  if (!task) return;
  try {
    recordTaskEvent({
      roomId: run.room_id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: run.id,
      eventType: 'workflow_started',
      content: `工作流已启动，进入 ${run.current_stage ?? 'planning'} 阶段。`,
      metadata: {
        graph_node: 'start',
        workflow_stage: run.current_stage ?? 'planning',
      },
    });
  } catch (err) {
    console.warn(`[graph-runtime] failed to record workflow start: ${(err as Error).message}`);
  }
}

function handleBackgroundGraphWorkflowError(runId: string, err: unknown): void {
  const error = err instanceof Error ? err.message : String(err);
  const run = workflowRepo.getRun(runId);
  if (!run) return;
  const parsed = tryParseGraphState(run);
  const failedState = blockGraphWorkflowRun(runId, parsed.ok ? parsed.state : null, error);
  if (failedState) workflowRepo.updateGraphState(runId, serializeGraphState(failedState));

  const latest = workflowRepo.getRun(runId) ?? run;
  const task = taskRepo.get(latest.task_id);
  if (!task) return;
  const failedStep = workflowRepo.listSteps(runId)
    .filter((step) => step.status === 'failed' || step.status === 'running')
    .at(-1);
  try {
    recordTaskEvent({
      roomId: latest.room_id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: latest.id,
      workflowStepId: failedStep?.id,
      eventType: 'workflow_failed',
      content: `工作流后台推进失败：${error}`,
      metadata: {
        graph_node: failedStep?.node_name ?? (parsed.ok ? parsed.state?.currentNode ?? 'unknown' : 'unknown'),
        workflow_stage: latest.current_stage,
        error,
      },
    });
  } catch (recordErr) {
    console.warn(`[graph-runtime] failed to record background failure: ${(recordErr as Error).message}`);
  }
}

export function recoverGraphWorkflow(error: string): number {
  const tools = createGraphTools();
  let count = 0;
  for (const run of tools.listGraphAwaitingApprovalRuns()) {
    try {
      const parsedState = tools.parseGraphState(run.graph_state);
      if (!parsedState || parsedState.plan) continue;
      const blockedRun = tools.updateRun(run.id, {
        status: 'blocked',
        error: 'Workflow is awaiting approval without a generated plan',
      });
      const nextState = {
        ...parsedState,
        status: 'blocked' as const,
        error: 'Workflow is awaiting approval without a generated plan',
      };
      tools.updateGraphState(run.id, serializeGraphState(nextState));
      if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
      count += 1;
    } catch (err) {
      console.warn(`[graph-recovery] invalid graph_state for awaiting approval run ${run.id}: ${(err as Error).message}`);
    }
  }
  for (const step of tools.listRunningSteps()) {
    const run = tools.getRun(step.workflow_run_id);
    if (!step.node_name && !run?.graph_version) continue;
    if (!run || run.status === 'cancelled' || run.status === 'completed') continue;

    for (const activeRun of tools.listActiveAgentRunsByWorkflow(run.id)) {
      const interruptedRun = tools.interruptAgentRun(activeRun.id, error);
      if (interruptedRun) tools.broadcastAgentRunUpdated(run.room_id, interruptedRun);
    }

    const interruptedStep = tools.updateGraphStep(step.id, { status: 'interrupted', error });
    if (interruptedStep) tools.broadcastStepUpdated(run.room_id, interruptedStep);

    const blockedRun = tools.updateRun(run.id, { status: 'blocked', error });
    try {
      const parsedState = tools.parseGraphState(run.graph_state);
      if (parsedState) {
        const nextState = {
          ...parsedState,
          currentNode: step.node_name ?? parsedState.currentNode,
          currentStepId: step.id,
          status: 'blocked' as const,
          error,
        };
        tools.updateGraphState(run.id, serializeGraphState(nextState));
      }
    } catch (err) {
      console.warn(`[graph-recovery] invalid graph_state for run ${run.id}: ${(err as Error).message}`);
    }

    if (blockedRun) tools.broadcastWorkflowUpdated(blockedRun);
    count += 1;
  }
  return count;
}

function requireGraphRun(id: string): WorkflowRun {
  const run = workflowRepo.getRun(id);
  if (!run) throw new Error('workflow not found');
  if (!run.graph_version) throw new Error('workflow is not a graph workflow');
  return run;
}

function requireGraphState(run: WorkflowRun): AgentWorkflowState {
  const state = parseGraphState(run.graph_state);
  if (!state) throw new Error('workflow has no graph state');
  return state;
}

function requireGraphStateOrBlock(run: WorkflowRun): AgentWorkflowState {
  const state = tryParseGraphState(run);
  if (!state.ok) {
    const error = `graph state is invalid: ${state.error}`;
    workflowRepo.updateRun(run.id, {
      status: 'blocked',
      error,
    });
    throw new Error(error);
  }
  if (!state.state) {
    const error = 'graph state is invalid: workflow has no graph state';
    workflowRepo.updateRun(run.id, {
      status: 'blocked',
      error,
    });
    throw new Error(error);
  }
  return state.state;
}

function parseWorkflowDefinitionSnapshot(run: WorkflowRun): WorkflowDefinitionSnapshot | null {
  if (!run.workflow_definition_snapshot) return null;
  try {
    const snapshot = JSON.parse(run.workflow_definition_snapshot) as {
      id?: string;
      name?: string;
      description?: string | null;
      builtinKey?: string | null;
      builtin_key?: string | null;
      version?: number;
      definition?: WorkflowDefinitionGraph;
    };
    if (!snapshot.definition) return null;
    return {
      id: typeof snapshot.id === 'string' ? snapshot.id : '',
      name: typeof snapshot.name === 'string' ? snapshot.name : '',
      description: typeof snapshot.description === 'string' ? snapshot.description : null,
      builtinKey: typeof snapshot.builtinKey === 'string'
        ? snapshot.builtinKey
        : (typeof snapshot.builtin_key === 'string' ? snapshot.builtin_key : null),
      version: typeof snapshot.version === 'number' ? snapshot.version : 0,
      definition: workflowDefinitionRepo.validateDefinition(snapshot.definition),
    };
  } catch (err) {
    throw new Error(`workflow definition snapshot is invalid: ${(err as Error).message}`);
  }
}

function tryParseGraphState(run: WorkflowRun): { ok: true; state: AgentWorkflowState | null } | { ok: false; error: string } {
  try {
    return { ok: true, state: parseGraphState(run.graph_state) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function retryCurrentNode(state: AgentWorkflowState): AgentWorkflowState['currentNode'] {
  if (state.currentNode === 'planning' || (state.currentNode === 'approval' && !state.plan)) return 'context';
  if (state.currentNode === 'approval') return 'approval';
  if (state.currentNode === 'execute') return 'dispatch';
  if (state.currentNode === 'review') return 'dispatch';
  if (state.currentNode === 'repair_decision') return 'review';
  if (state.currentNode === 'verify') return 'dispatch';
  if (state.currentNode === 'acceptance') return 'dispatch';
  return state.currentNode;
}

async function resumeGraphWorkflowFromState(
  state: AgentWorkflowState,
  deps: GraphRuntimeDeps,
  snapshot: WorkflowDefinitionSnapshot | null = null,
): Promise<AgentWorkflowState> {
  const tools = createGraphTools(deps);
  const nodes = createGraphNodes({
    ...tools,
    getWorkflowPromptKind: () => inferWorkflowPromptKind(snapshot),
  });
  const runtimeGraph = isSuperpowersDefinitionGraph(snapshot?.definition)
    ? buildSuperpowersRuntimeGraph(deps)
    : null;
  const routeDefinition = runtimeGraph?.executableDefinition
    ?? snapshot?.definition
    ?? workflowDefinitionRepo.ensureBuiltInDefinitions().definition;
  const routePlan = compileRoutePlan(routeDefinition, Boolean(runtimeGraph));
  let nextState = state;
  let nodeToRun = nextNodeAfter(null, nextState, routePlan);

  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (!nodeToRun || isTerminalResumeState(nextState)) {
      return nextState;
    }

    if (nodeToRun === 'tdd_execute' && runtimeGraph && hasRunnableChildTask(nextState)) {
      const executedState = await nodes.executeNode(nextState);
      nextState = renameLatestExecuteStepAsTddExecute(
        applyTddEvidenceFromImplementationOutput(executedState, tools),
        tools,
      );
      if (shouldWaitForActiveAgentRun('execute', nextState)) {
        return nextState;
      }
      const nextNode = nextNodeAfter('tdd_execute', nextState, routePlan);
      if (nextNode === 'spec_compliance_review') {
        const canLeaveTddExecute = runtimeGraph.canLeaveTddExecute(nextState);
        nextState = await runtimeGraph.nodes.tddExecute(nextState);
        if (!canLeaveTddExecute) {
          return blockSuperpowersTddExecute(nextState);
        }
      }
      nodeToRun = nextNode;
      continue;
    }

    if (nodeToRun === 'dispatch' && runtimeGraph && !runtimeGraph.canDispatch(nextState)) {
      return blockSuperpowersDispatch(nextState);
    }

    if (runtimeGraph && isSuperpowersPlanningRouteNode(nodeToRun)) {
      nextState = await runSuperpowersPlanningNode(nodeToRun, nextState, tools, nodes, runtimeGraph);
    } else if (runtimeGraph && isSuperpowersExecutionRouteNode(nodeToRun)) {
      nextState = await runSuperpowersExecutionNode(nodeToRun, nextState, tools, runtimeGraph);
    } else if (nodeToRun === 'context') {
      nextState = await nodes.contextNode(nextState);
    } else if (nodeToRun === 'planning') {
      nextState = await nodes.planningNode(nextState);
    } else if (nodeToRun === 'approval') {
      nextState = await nodes.approvalNode(nextState);
    } else if (nodeToRun === 'dispatch') {
      nextState = await nodes.dispatchNode(nextState);
    } else if (nodeToRun === 'execute') {
      nextState = await nodes.executeNode(nextState);
    } else if (nodeToRun === 'review') {
      nextState = await nodes.reviewNode(nextState);
    } else if (nodeToRun === 'repair_decision') {
      nextState = await nodes.repairDecisionNode(nextState);
    } else if (nodeToRun === 'verify') {
      nextState = await nodes.verifyNode(nextState);
      if (runtimeGraph) {
        nextState = applySuperpowersVerificationEvidence(nextState);
        tools.updateGraphState(nextState.workflowRunId, serializeGraphState(nextState));
        if (!runtimeGraph.canLeaveVerify(nextState)) {
          return blockSuperpowersVerify({
            ...nextState,
            status: 'blocked',
            error: getSuperpowersVerifyGateError(nextState),
          });
        }
      }
    } else if (nodeToRun === 'acceptance') {
      nextState = await nodes.acceptanceNode(nextState);
    } else if (nodeToRun === 'memory') {
      nextState = await nodes.memoryNode(nextState);
    }
    if (shouldWaitForActiveAgentRun(nodeToRun, nextState)) {
      return nextState;
    }
    nodeToRun = nextNodeAfter(nodeToRun, nextState, routePlan);
  }

  throw new Error('graph retry exceeded resume limit');
}

function inferWorkflowPromptKind(snapshot: WorkflowDefinitionSnapshot | null): 'analysis_document' | 'development' {
  if (snapshot?.builtinKey === 'analysis-document') return 'analysis_document';
  if (snapshot && !snapshot.definition.nodes.some((node) =>
    node.type === 'execute' || node.type === 'review' || node.type === 'verify',
  )) {
    return 'analysis_document';
  }
  return 'development';
}

async function runSuperpowersPlanningNode(
  nodeToRun: SuperpowersPlanningNodeName,
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  nodes: ReturnType<typeof createGraphNodes>,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  if (nodeToRun === 'writing_plans') {
    return runSuperpowersWritingPlansNode(state, tools, nodes, runtimeGraph);
  }

  const context = tools.readWorkflowContext(state.workflowRunId);
  const phaseStep = runtimeGraph.phaseSteps.find((step) => step.nodeName === nodeToRun);
  if (!phaseStep) throw new Error(`unknown Superpowers planning node: ${nodeToRun}`);

  const step = tools.createGraphStep({
    workflow_run_id: context.run.id,
    task_id: context.task.id,
    stage: phaseStep.stage,
    node_name: nodeToRun as never,
    status: 'running',
    sort_order: tools.nextStepSortOrder(context.run.id),
  });
  const rawNextState = await callSuperpowersNode(nodeToRun, state, runtimeGraph);
  const nextState: AgentWorkflowState = {
    ...rawNextState,
    currentNode: 'planning',
    currentStepId: step.id,
  };
  const completedStep = tools.updateGraphStep(step.id, {
    node_name: nodeToRun as never,
    status: nextState.status === 'blocked' ? 'failed' : 'completed',
    error: nextState.status === 'blocked' ? nextState.error : null,
  });
  if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);
  const updatedRun = tools.updateRun(context.run.id, {
    status: nextState.status === 'blocked' ? 'blocked' : 'running',
    current_stage: phaseStep.stage,
    error: nextState.status === 'blocked' ? nextState.error : null,
  });
  if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
  tools.updateGraphState(context.run.id, serializeGraphState(nextState));
  return nextState;
}

async function runSuperpowersWritingPlansNode(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  nodes: ReturnType<typeof createGraphNodes>,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  const context = tools.readWorkflowContext(state.workflowRunId);
  const beforeStepIds = new Set(tools.listSteps(context.run.id).map((step) => step.id));
  let plannedState: AgentWorkflowState;

  try {
    plannedState = await nodes.planningNode(state);
  } catch (err) {
    const planningStep = findCreatedPlanningStep(tools, context.run.id, beforeStepIds);
    if (planningStep) {
      tools.updateGraphStep(planningStep.id, {
        node_name: 'writing_plans' as never,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  const planningStep = findCreatedPlanningStep(tools, context.run.id, beforeStepIds);
  if (planningStep) {
    tools.updateGraphStep(planningStep.id, { node_name: 'writing_plans' as never });
  }

  const rawNextState = await runtimeGraph.nodes.writingPlans(plannedState);
  const nextState: AgentWorkflowState = {
    ...rawNextState,
    currentNode: 'planning',
    currentStepId: planningStep?.id ?? plannedState.currentStepId,
  };
  tools.updateGraphState(context.run.id, serializeGraphState(nextState));
  return nextState;
}

function findCreatedPlanningStep(
  tools: ReturnType<typeof createGraphTools>,
  workflowRunId: string,
  beforeStepIds: Set<string>,
) {
  return tools.listSteps(workflowRunId)
    .filter((step) => !beforeStepIds.has(step.id) && step.node_name === 'planning')
    .at(-1);
}

async function callSuperpowersNode(
  nodeToRun: Exclude<SuperpowersPlanningNodeName, 'writing_plans'>,
  state: AgentWorkflowState,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  if (nodeToRun === 'brainstorming') return runtimeGraph.nodes.brainstorming(state);
  if (nodeToRun === 'spec_review') return runtimeGraph.nodes.specReview(state);
  if (nodeToRun === 'worktree') return runtimeGraph.nodes.worktree(state);
  if (nodeToRun === 'plan_review') return runtimeGraph.nodes.planReview(state);
  throw new Error(`unknown Superpowers planning node: ${nodeToRun}`);
}

async function runSuperpowersExecutionNode(
  nodeToRun: SuperpowersExecutionNodeName,
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  const context = tools.readWorkflowContext(state.workflowRunId);
  const step = tools.createGraphStep({
    workflow_run_id: context.run.id,
    task_id: context.task.id,
    stage: nodeToRun === 'tdd_execute' ? 'implementation' : nodeToRun === 'finish_branch' ? 'acceptance' : 'code_review',
    node_name: nodeToRun as never,
    status: 'running',
    sort_order: tools.nextStepSortOrder(context.run.id),
  });
  tools.broadcastStepCreated(context.room.id, step);

  const rawNextState = await callSuperpowersExecutionNode(nodeToRun, state, runtimeGraph);
  const nextState = normalizeSuperpowersReviewState({
    ...rawNextState,
    currentNode: nodeToRun === 'tdd_execute' ? 'execute' : nodeToRun === 'finish_branch' ? 'acceptance' : 'review',
    currentStepId: step.id,
  }, nodeToRun);
  const blocked = nextState.status === 'blocked';
  const completedStep = tools.updateGraphStep(step.id, {
    node_name: nodeToRun as never,
    status: blocked ? 'failed' : 'completed',
    error: blocked ? nextState.error : null,
  });
  if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);

  const updatedRun = tools.updateRun(context.run.id, {
    status: blocked ? 'blocked' : 'running',
    current_stage: nodeToRun === 'tdd_execute' ? 'implementation' : nodeToRun === 'finish_branch' ? 'acceptance' : 'code_review',
    error: blocked ? nextState.error : null,
  });
  if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
  tools.updateGraphState(context.run.id, serializeGraphState(nextState));
  return nextState;
}

async function callSuperpowersExecutionNode(
  nodeToRun: SuperpowersExecutionNodeName,
  state: AgentWorkflowState,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  if (nodeToRun === 'tdd_execute') return runtimeGraph.nodes.tddExecute(state);
  if (nodeToRun === 'spec_compliance_review') return runtimeGraph.nodes.specComplianceReview(state);
  if (nodeToRun === 'code_quality_review') return runtimeGraph.nodes.codeQualityReview(state);
  if (nodeToRun === 'finish_branch') return runtimeGraph.nodes.finishBranch(state);
  throw new Error(`unknown Superpowers execution node: ${nodeToRun}`);
}

function normalizeSuperpowersReviewState(
  state: AgentWorkflowState,
  nodeToRun: SuperpowersExecutionNodeName,
): AgentWorkflowState {
  if (state.reviewVerdict === 'changes_requested') {
    return state;
  }
  if (nodeToRun === 'spec_compliance_review' && !state.specComplianceReview) {
    return {
      ...state,
      specComplianceReview: {
        verdict: state.reviewVerdict === 'failed' ? 'failed' : 'approved',
        findings: state.reviewFindings,
        reviewedAt: null,
      },
    };
  }
  if (nodeToRun === 'code_quality_review' && !state.codeQualityReview) {
    return {
      ...state,
      codeQualityReview: {
        verdict: state.reviewVerdict === 'failed' ? 'failed' : 'approved',
        findings: state.reviewFindings,
        reviewedAt: null,
      },
    };
  }
  return state;
}

function applySuperpowersVerificationEvidence(state: AgentWorkflowState): AgentWorkflowState {
  const commands = state.plan?.verificationCommands?.length
    ? state.plan.verificationCommands
    : (state.plan?.verification ?? []).map((command) => ({ command, reason: '', required: true }));

  return {
    ...state,
    verificationEvidence: mapVerificationResultsToEvidence(
      state.verificationResults,
      commands,
      state.verificationEvidence ?? [],
    ),
  };
}

function applyTddEvidenceFromImplementationOutput(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
): AgentWorkflowState {
  if (!state.currentStepId) return state;
  const step = tools.getStep(state.currentStepId);
  if (!step || step.status !== 'completed') return state;
  const evidence = parseTddEvidence(step.result ?? '');
  if (evidence.length === 0) return state;
  return {
    ...state,
    tddEvidence: [
      ...(state.tddEvidence ?? []),
      ...evidence,
    ],
  };
}

function parseTddEvidence(output: string): NonNullable<AgentWorkflowState['tddEvidence']> {
  if (!output.trim()) return [];
  try {
    const parsed = JSON.parse(output) as {
      tddEvidence?: NonNullable<AgentWorkflowState['tddEvidence']>;
    };
    if (!Array.isArray(parsed.tddEvidence)) return [];
    return parsed.tddEvidence.filter((record) =>
      (record.stage === 'RED' || record.stage === 'GREEN' || record.stage === 'REFACTOR')
      && (record.passed === true || record.passed === false || record.passed === null)
      && (typeof record.command === 'string' || record.command === null)
      && (typeof record.summary === 'string' || record.summary === null),
    );
  } catch {
    return [];
  }
}

function renameLatestExecuteStepAsTddExecute(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
): AgentWorkflowState {
  if (!state.currentStepId) return state;
  const step = tools.getStep(state.currentStepId);
  if (!step || step.node_name !== 'execute') return state;
  const updatedStep = tools.updateGraphStep(step.id, { node_name: 'tdd_execute' as never });
  if (updatedStep) {
    const context = tools.readWorkflowContext(state.workflowRunId);
    tools.broadcastStepUpdated(context.room.id, updatedStep);
  }
  tools.updateGraphState(state.workflowRunId, serializeGraphState({
    ...state,
    superpowersPhase: 'tdd_execute',
  }));
  return {
    ...state,
    superpowersPhase: 'tdd_execute',
  };
}

function blockSuperpowersDispatch(state: AgentWorkflowState): AgentWorkflowState {
  const error = getSuperpowersDispatchGateError(state);
  const blockedState = blockGraphWorkflowRun(state.workflowRunId, state, error);
  if (!blockedState) {
    throw new Error(error);
  }
  return {
    ...blockedState,
    currentNode: 'planning',
    superpowersPhase: 'plan_review',
  };
}

function blockSuperpowersTddExecute(state: AgentWorkflowState): AgentWorkflowState {
  const error = state.error
    ?? 'Superpowers TDD evidence gate requires RED failed and GREEN passed records or an explicit exemption';
  const blockedState = blockGraphWorkflowRun(state.workflowRunId, state, error);
  if (!blockedState) {
    throw new Error(error);
  }
  return {
    ...blockedState,
    currentNode: 'execute',
    superpowersPhase: 'tdd_execute',
  };
}

function blockSuperpowersVerify(state: AgentWorkflowState): AgentWorkflowState {
  const error = getSuperpowersVerifyGateError(state);
  const blockedState = blockGraphWorkflowRun(state.workflowRunId, state, error);
  if (!blockedState) {
    throw new Error(error);
  }
  return {
    ...blockedState,
    currentNode: 'verify',
    superpowersPhase: 'code_quality_review',
  };
}

function getSuperpowersVerifyGateError(state: AgentWorkflowState): string {
  const failedRequired = (state.verificationEvidence ?? []).find((record) =>
    record.required && record.status !== 'passed'
  );
  if (failedRequired) {
    return `Verification failed: ${failedRequired.command}`;
  }
  return 'Superpowers verify gate requires fresh passed required verification evidence';
}

function getSuperpowersDispatchGateError(state: AgentWorkflowState): string {
  if (typeof state.implementationPlanPath !== 'string' || state.implementationPlanPath.trim().length === 0) {
    return 'Superpowers dispatch requires implementationPlanPath';
  }
  if (state.planReviewVerdict !== 'approved') {
    return 'Superpowers dispatch requires approved plan review';
  }
  return 'Superpowers dispatch requires approved implementation plan';
}

function isTerminalResumeState(state: AgentWorkflowState): boolean {
  return (
    state.status === 'awaiting_approval' ||
    state.status === 'awaiting_decision' ||
    state.status === 'blocked' ||
    state.status === 'cancelled' ||
    state.status === 'failed'
  );
}

function shouldWaitForActiveAgentRun(
  nodeJustRun: WorkflowRouteNode,
  state: AgentWorkflowState,
): boolean {
  if (nodeJustRun !== 'execute') return false;
  if (state.status !== 'running' || !state.activeAgentRunId) return false;
  const activeRun = agentRunRepo.get(state.activeAgentRunId);
  return Boolean(
    activeRun &&
    activeRun.status !== 'completed' &&
    activeRun.status !== 'failed' &&
    activeRun.status !== 'cancelled' &&
    activeRun.status !== 'interrupted',
  );
}

function hasRunnableChildTask(state: AgentWorkflowState): boolean {
  return state.childTaskIds
    .map((id) => taskRepo.get(id))
    .some((task) => task?.status === 'todo' || task?.status === 'in_progress');
}

type WorkflowRouteNode = NonNullable<AgentWorkflowState['currentNode']> | SuperpowersPlanningNodeName | SuperpowersExecutionNodeName;
type WorkflowRoutePlan = {
  start: WorkflowRouteNode;
  next: Map<WorkflowRouteNode, Array<{ to: WorkflowRouteNode; condition: string | null }>>;
};

const LEGACY_NODE_TYPE_TO_STATE_NODE: Record<WorkflowDefinitionNodeType, WorkflowRouteNode | null> = {
  context: 'context',
  planning: 'planning',
  brainstorming: null,
  spec_review: null,
  worktree: null,
  writing_plans: null,
  plan_review: null,
  approval_gate: 'approval',
  dispatch: 'dispatch',
  execute: 'execute',
  tdd_execute: null,
  review: 'review',
  spec_compliance_review: null,
  code_quality_review: null,
  repair_decision: 'repair_decision',
  verify: 'verify',
  finish_branch: null,
  acceptance: 'acceptance',
  memory: 'memory',
};

const SUPERPOWERS_NODE_TYPE_TO_STATE_NODE: Record<WorkflowDefinitionNodeType, WorkflowRouteNode | null> = {
  ...LEGACY_NODE_TYPE_TO_STATE_NODE,
  brainstorming: 'brainstorming',
  spec_review: 'spec_review',
  worktree: 'worktree',
  writing_plans: 'writing_plans',
  plan_review: 'plan_review',
  tdd_execute: 'tdd_execute',
  spec_compliance_review: 'spec_compliance_review',
  code_quality_review: 'code_quality_review',
  finish_branch: 'finish_branch',
};

function resolveLegacyRouteNode(
  node: { id: string; type: WorkflowDefinitionNodeType },
  allowSuperpowersNodes: boolean,
): WorkflowRouteNode {
  const mapped = (allowSuperpowersNodes ? SUPERPOWERS_NODE_TYPE_TO_STATE_NODE : LEGACY_NODE_TYPE_TO_STATE_NODE)[node.type];
  if (mapped) return mapped;
  throw new Error(
    `workflow definition node "${node.id}" type "${node.type}" is not supported by legacy graph runtime`,
  );
}

function compileRoutePlan(definition: WorkflowDefinitionGraph, allowSuperpowersNodes = false): WorkflowRoutePlan {
  const idToStateNode = new Map<string, WorkflowRouteNode>();
  for (const node of definition.nodes) {
    idToStateNode.set(node.id, resolveLegacyRouteNode(node, allowSuperpowersNodes));
  }

  const incoming = new Map<string, number>();
  for (const node of definition.nodes) incoming.set(node.id, 0);
  for (const edge of definition.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const startDefinitionNodes = definition.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
  if (startDefinitionNodes.length !== 1) throw new Error('workflow definition must have exactly one start node');

  const next = new Map<WorkflowRouteNode, Array<{ to: WorkflowRouteNode; condition: string | null }>>();
  for (const edge of definition.edges) {
    const from = idToStateNode.get(edge.from);
    const to = idToStateNode.get(edge.to);
    if (!from || !to) throw new Error(`workflow definition has invalid edge ${edge.from} -> ${edge.to}`);
    const list = next.get(from) ?? [];
    list.push({ to, condition: edge.condition ?? null });
    next.set(from, list);
  }

  const start = idToStateNode.get(startDefinitionNodes[0]!.id);
  if (!start) throw new Error('workflow definition has invalid start node');
  return { start, next };
}

function isSuperpowersPlanningRouteNode(node: WorkflowRouteNode): node is SuperpowersPlanningNodeName {
  return (
    node === 'brainstorming'
    || node === 'spec_review'
    || node === 'worktree'
    || node === 'writing_plans'
    || node === 'plan_review'
  );
}

function isSuperpowersExecutionRouteNode(node: WorkflowRouteNode): node is SuperpowersExecutionNodeName {
  return (
    node === 'tdd_execute'
    || node === 'spec_compliance_review'
    || node === 'code_quality_review'
    || node === 'finish_branch'
  );
}

function nextNodeFromDefinition(
  nodeJustRun: WorkflowRouteNode | null,
  state: AgentWorkflowState,
  plan: WorkflowRoutePlan,
): WorkflowRouteNode | null {
  if (isTerminalResumeState(state)) return null;
  const node = nodeJustRun ?? currentRouteNodeFromState(state, plan);
  if (!node) return plan.start;
  const outgoing = plan.next.get(node) ?? [];
  if (outgoing.length === 0) return null;
  if (outgoing.length === 1 && !outgoing[0]!.condition) return outgoing[0]!.to;
  const routed = routeRuntimeNode(node, state);
  if (routed) {
    const matching = outgoing.find((edge) => edge.to === routed);
    if (matching) return matching.to;
    return null;
  }
  for (const edge of outgoing) {
    if (matchesRouteCondition(node, edge.condition, state)) return edge.to;
  }
  return null;
}

function currentRouteNodeFromState(state: AgentWorkflowState, plan: WorkflowRoutePlan): WorkflowRouteNode | null {
  if (state.currentNode === 'planning' && isSuperpowersPlanningPhase(state.superpowersPhase)) {
    return plan.next.has(state.superpowersPhase) ? state.superpowersPhase : state.currentNode;
  }
  if (isSuperpowersExecutionPhase(state.superpowersPhase)) {
    return plan.next.has(state.superpowersPhase) ? state.superpowersPhase : state.currentNode;
  }
  return state.currentNode;
}

function isSuperpowersPlanningPhase(value: unknown): value is SuperpowersPlanningNodeName {
  return (
    value === 'brainstorming'
    || value === 'spec_review'
    || value === 'worktree'
    || value === 'writing_plans'
    || value === 'plan_review'
  );
}

function isSuperpowersExecutionPhase(value: unknown): value is SuperpowersExecutionNodeName {
  return (
    value === 'tdd_execute'
    || value === 'spec_compliance_review'
    || value === 'code_quality_review'
    || value === 'finish_branch'
  );
}

function routeRuntimeNode(
  node: WorkflowRouteNode,
  state: AgentWorkflowState,
): WorkflowRouteNode | null {
  if (isSuperpowersPlanningRouteNode(node)) return null;
  if (isSuperpowersExecutionRouteNode(node)) {
    if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return null;
    if (node === 'tdd_execute') return hasRunnableChildTask(state) ? 'tdd_execute' : 'spec_compliance_review';
    if (node === 'spec_compliance_review') {
      return state.reviewVerdict === 'changes_requested' ? 'tdd_execute' : 'code_quality_review';
    }
    if (node === 'code_quality_review') {
      return state.reviewVerdict === 'changes_requested' ? 'tdd_execute' : 'verify';
    }
    if (node === 'finish_branch') return state.finishBranchDecision ? 'acceptance' : null;
  }
  if (node === 'approval') {
    const route = routeAfterApproval(state);
    return route === END ? null : route;
  }
  if (node === 'execute') {
    const route = routeAfterExecute(state);
    return route === END ? null : route;
  }
  if (node === 'review') {
    const route = routeAfterReview(state);
    return route === END ? null : route;
  }
  if (node === 'repair_decision') {
    const route = routeAfterRepairDecision(state);
    return route === END ? null : route;
  }
  if (node === 'verify') return 'finish_branch';
  if (node === 'acceptance') return state.status === 'completed' ? 'memory' : null;
  return null;
}

function matchesRouteCondition(
  node: WorkflowRouteNode,
  condition: string | null,
  state: AgentWorkflowState,
): boolean {
  if (!condition || condition === 'default' || condition === 'done') return true;
  if (isSuperpowersPlanningRouteNode(node)) return false;
  if (isSuperpowersExecutionRouteNode(node)) {
    if (node === 'tdd_execute' && condition === 'has_runnable_child') return hasRunnableChildTask(state);
    if (condition === 'changes_requested') return state.reviewVerdict === 'changes_requested';
    if (condition === 'pass' || condition === 'approved' || condition === 'verify') return state.reviewVerdict !== 'changes_requested';
    if (node === 'finish_branch' && (condition === 'completed' || condition === 'acceptance')) {
      return Boolean(state.finishBranchDecision);
    }
    return false;
  }
  if (node === 'approval') {
    const route = routeAfterApproval(state);
    if (condition === 'approved') return route === 'dispatch';
    if (condition === 'pending' || condition === 'rejected') return route === END;
  }
  if (node === 'execute') {
    const route = routeAfterExecute(state);
    if (condition === 'has_runnable_child') return route === 'execute';
    if (condition === 'review' || condition === 'complete') return route === 'review';
  }
  if (node === 'review') {
    const route = routeAfterReview(state);
    if (condition === 'changes_requested') return route === 'repair_decision';
    if (condition === 'pass' || condition === 'verify') return route === 'verify';
  }
  if (node === 'repair_decision') {
    const route = routeAfterRepairDecision(state);
    if (condition === 'repair' || condition === 'execute') return route === 'execute';
  }
  if (node === 'verify') return condition === 'pass' || condition === 'acceptance';
  if (node === 'acceptance') return condition === 'completed' ? state.status === 'completed' : false;
  return false;
}

function nextNodeAfter(
  nodeJustRun: WorkflowRouteNode | null,
  state: AgentWorkflowState,
  routePlan?: WorkflowRoutePlan,
): WorkflowRouteNode | null {
  if (isTerminalResumeState(state)) return null;
  if (routePlan) return nextNodeFromDefinition(nodeJustRun, state, routePlan);
  const node = nodeJustRun ?? state.currentNode;
  if (!node) return 'context';
  if (node === 'context') return 'planning';
  if (node === 'planning') return 'approval';
  if (node === 'approval') {
    const route = routeAfterApproval(state);
    return route === END ? null : route;
  }
  if (node === 'dispatch') return 'execute';
  if (node === 'execute') {
    const route = routeAfterExecute(state);
    return route === END ? null : route;
  }
  if (node === 'review') {
    const route = routeAfterReview(state);
    return route === END ? null : route;
  }
  if (node === 'repair_decision') {
    const route = routeAfterRepairDecision(state);
    return route === END ? null : route;
  }
  if (node === 'verify') return 'acceptance';
  if (node === 'acceptance') return state.status === 'completed' ? 'memory' : null;
  if (node === 'memory') return null;
  return null;
}
