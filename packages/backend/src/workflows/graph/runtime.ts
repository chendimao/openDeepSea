import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { db } from '../../db.js';
import { agentRunRepo } from '../../repos/agent-runs.js';
import { projectRepo } from '../../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowDefinitionRepo } from '../../repos/workflow-definitions.js';
import { workflowRepo } from '../../repos/workflows.js';
import { workflowArtifactVersionRepo } from '../../repos/workflows.js';
import { runRegistry } from '../../run-registry.js';
import { recordTaskEvent, recordTaskStatusChanged } from '../../task-conversation.js';
import type {
  WorkflowDefinition,
  WorkflowDefinitionGraph,
  WorkflowDefinitionNodeType,
  WorkflowArtifactVersion,
  WorkflowRole,
  WorkflowRun,
  WorkflowStage,
} from '../../types.js';
import type { WorkflowSupervisorDecision } from '../supervisor.js';
import type { AvailableWorkflowAgent } from '../agent-assignment.js';
import { ensureWorkflowAgentsForRun } from '../agent-provisioning.js';
import { buildSuperpowersPhasePrompt } from '../prompts.js';
import { normalizeParsedPlanTaskTitles, parsePlanArtifact, type ParsedPlan } from '../plan-parser.js';
import { generateWorkflowSupervisorDecision } from '../supervisor.js';
import { assessTaskRisk, buildApprovalCard } from '../task-risk.js';
import { createGraphNodes } from './nodes.js';
import { buildCoordinatorWorkflowPlan, deriveCoordinatorPlanFromProductManagerBackground } from './coordinator-plan.js';
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
import {
  createSuperpowersRoutingNodes,
  parseRoutingPlannerEvidence,
  type SuperpowersRoutingPlannerStage,
} from './superpowers-routing-nodes.js';
import { createGraphTools, type GraphRuntimeDeps } from './tools.js';
import { mapVerificationResultsToEvidence } from './verification.js';
import { applySuperpowersEvidencePatch, parseSuperpowersEvidence } from './superpowers-evidence.js';

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
  runtimeProfile: Annotation<AgentWorkflowState['runtimeProfile']>(),
  superpowersPhase: Annotation<AgentWorkflowState['superpowersPhase']>(),
  activeSuperpowersStage: Annotation<AgentWorkflowState['activeSuperpowersStage']>(),
  draftSpecArtifactVersionId: Annotation<AgentWorkflowState['draftSpecArtifactVersionId']>(),
  approvedSpecArtifactVersionId: Annotation<AgentWorkflowState['approvedSpecArtifactVersionId']>(),
  draftPlanArtifactVersionId: Annotation<AgentWorkflowState['draftPlanArtifactVersionId']>(),
  approvedPlanArtifactVersionId: Annotation<AgentWorkflowState['approvedPlanArtifactVersionId']>(),
  lightweightPlanArtifactVersionId: Annotation<AgentWorkflowState['lightweightPlanArtifactVersionId']>(),
  artifactChangeRequestMessageId: Annotation<AgentWorkflowState['artifactChangeRequestMessageId']>(),
  artifactChangeRequestArtifactVersionId: Annotation<AgentWorkflowState['artifactChangeRequestArtifactVersionId']>(),
  agentAssignments: Annotation<AgentWorkflowState['agentAssignments']>(),
  selectedIntent: Annotation<AgentWorkflowState['selectedIntent']>(),
  selectedPath: Annotation<AgentWorkflowState['selectedPath']>(),
  routingArtifactVersionId: Annotation<AgentWorkflowState['routingArtifactVersionId']>(),
  analysisArtifactVersionId: Annotation<AgentWorkflowState['analysisArtifactVersionId']>(),
  agentAssignmentArtifactVersionId: Annotation<AgentWorkflowState['agentAssignmentArtifactVersionId']>(),
  approvedAgentAssignmentArtifactVersionId: Annotation<AgentWorkflowState['approvedAgentAssignmentArtifactVersionId']>(),
  activeChangeRequestId: Annotation<AgentWorkflowState['activeChangeRequestId']>(),
  worktreeDecision: Annotation<AgentWorkflowState['worktreeDecision']>(),
  recoveryState: Annotation<AgentWorkflowState['recoveryState']>(),
  designDocPath: Annotation<AgentWorkflowState['designDocPath']>(),
  designReviewVerdict: Annotation<AgentWorkflowState['designReviewVerdict']>(),
  implementationPlanPath: Annotation<AgentWorkflowState['implementationPlanPath']>(),
  planReviewVerdict: Annotation<AgentWorkflowState['planReviewVerdict']>(),
  worktree: Annotation<AgentWorkflowState['worktree']>(),
  tddEvidence: Annotation<AgentWorkflowState['tddEvidence']>(),
  tddExemption: Annotation<AgentWorkflowState['tddExemption']>(),
  specComplianceReview: Annotation<AgentWorkflowState['specComplianceReview']>(),
  codeQualityReview: Annotation<AgentWorkflowState['codeQualityReview']>(),
  verificationEvidence: Annotation<AgentWorkflowState['verificationEvidence']>(),
  finishBranchDecision: Annotation<AgentWorkflowState['finishBranchDecision']>(),
  riskAssessment: Annotation<AgentWorkflowState['riskAssessment']>(),
  approvalCard: Annotation<AgentWorkflowState['approvalCard']>(),
  agentEvents: Annotation<AgentWorkflowState['agentEvents']>(),
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

export function startGraphWorkflowInBackground(taskId: string, deps: GraphRuntimeDeps = {}): WorkflowRun {
  const run = createGraphWorkflowRun(taskId);
  recordWorkflowStartedEvent(run);
  enqueueGraphWorkflow(run.id, deps);
  return run;
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
  const defaultSupervisor = (deps as SupervisorDepsOverride).defaultSupervisor;
  const supervisor = deps.supervisor
    ?? defaultSupervisor
    ?? ((input: Parameters<typeof generateWorkflowSupervisorDecision>[0], options?: Parameters<typeof generateWorkflowSupervisorDecision>[2]) =>
      generateWorkflowSupervisorDecision(input, undefined, options));

  try {
    const skillContext = await deps.buildSkillContext?.({
      runtimeScopes: ['workflow'],
      projectId: project.id,
      roomId: room.id,
      message: [
        task.title,
        task.description ?? '',
        `${definition.name}: ${definition.description ?? ''}`,
      ].filter(Boolean).join('\n\n'),
    }) ?? '';
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

export function enqueueExistingGraphWorkflowRun(
  runId: string,
  deps: GraphRuntimeDeps = {},
): { run: WorkflowRun; enqueued: true } {
  const run = requireGraphRun(runId);
  requireGraphStateOrBlock(run);
  recordWorkflowStartedEvent(run);
  enqueueGraphWorkflow(run.id, deps);
  return { run, enqueued: true };
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
  const resetChildTaskIds = new Set<string>();
  for (const child of taskRepo.listChildren(run.task_id).filter((item) =>
    state.childTaskIds.includes(item.id) && (item.status === 'failed' || item.status === 'in_progress'),
  )) {
    const resetChild = db.transaction(() => {
      const after = taskRepo.updateStatus(child.id, 'todo');
      if (after) {
        recordTaskStatusChanged({
          before: child,
          after,
          metadata: {
            workflow_run_id: run.id,
            graph_retry: true,
          },
        });
      }
      return after;
    })();
    if (resetChild) {
      resetChildTaskIds.add(resetChild.id);
      tools.broadcastTaskUpdated(resetChild);
    }
  }
  const retryState: AgentWorkflowState = {
    ...state,
    workflowPlan: resetWorkflowPlanTasksForRetry(state, resetChildTaskIds),
    currentNode: retryCurrentNode(state),
    currentStepId: null,
    status: 'running',
    error: null,
    activeAgentRunId: null,
  };
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

function resetWorkflowPlanTasksForRetry(
  state: AgentWorkflowState,
  childTaskIds: Set<string>,
): AgentWorkflowState['workflowPlan'] {
  if (!state.workflowPlan || childTaskIds.size === 0) return state.workflowPlan ?? null;
  const planIndexes = new Set(Object.entries(state.childTaskPlanIndexes ?? {})
    .filter(([childTaskId]) => childTaskIds.has(childTaskId))
    .map(([, planIndex]) => planIndex));
  if (planIndexes.size === 0) return state.workflowPlan;
  return {
    ...state.workflowPlan,
    tasks: state.workflowPlan.tasks.map((task, index) => {
      if (!planIndexes.has(index)) return task;
      return {
        ...task,
        status: 'pending',
        progress: 0,
      };
    }),
  };
}

export async function cancelGraphWorkflow(id: string): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  const tools = createGraphTools();
  const parsedState = tryParseGraphState(run);
  const state = parsedState.ok ? parsedState.state : null;
  const childTaskIdSet = new Set(state?.childTaskIds ?? []);
  const cancelledChildTaskIds = new Set<string>();
  for (const agentRun of tools.listActiveAgentRunsByWorkflow(run.id)) {
    runRegistry.cancel(agentRun.id);
    const cancelledRun = agentRunRepo.updateStatus(agentRun.id, 'cancelled', { error: 'Workflow cancelled' });
    if (cancelledRun) tools.broadcastAgentRunUpdated(run.room_id, cancelledRun);
  }
  for (const step of workflowRepo.listSteps(run.id).filter((item) => item.status === 'running')) {
    if (step.task_id && childTaskIdSet.has(step.task_id)) {
      cancelledChildTaskIds.add(step.task_id);
    }
    const cancelledStep = workflowRepo.updateStep(step.id, {
      status: 'cancelled',
      error: 'Workflow cancelled',
    });
    if (cancelledStep) tools.broadcastStepUpdated(run.room_id, cancelledStep);
  }
  for (const childTaskId of cancelledChildTaskIds) {
    const child = taskRepo.get(childTaskId);
    if (child?.status !== 'in_progress') continue;
    const cancelledChild = taskRepo.updateStatus(child.id, 'failed');
    if (cancelledChild) tools.broadcastTaskUpdated(cancelledChild);
  }
  const updated = workflowRepo.updateRun(run.id, {
    status: 'cancelled',
    error: null,
  });
  if (!updated) throw new Error('workflow not found');
  if (state) {
    workflowRepo.updateGraphState(run.id, serializeGraphState({
      ...state,
      workflowPlan: markWorkflowPlanTasksBlockedByChildIds(state, cancelledChildTaskIds),
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

function markWorkflowPlanTasksBlockedByChildIds(
  state: AgentWorkflowState,
  childTaskIds: Set<string>,
): AgentWorkflowState['workflowPlan'] {
  if (!state.workflowPlan || childTaskIds.size === 0) return state.workflowPlan ?? null;
  const planIndexes = new Set(Object.entries(state.childTaskPlanIndexes ?? {})
    .filter(([childTaskId]) => childTaskIds.has(childTaskId))
    .map(([, planIndex]) => planIndex));
  if (planIndexes.size === 0) return state.workflowPlan;
  return {
    ...state.workflowPlan,
    tasks: state.workflowPlan.tasks.map((task, index) =>
      planIndexes.has(index) ? { ...task, status: 'blocked' } : task
    ),
  };
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
  const childTaskIdSet = new Set(state?.childTaskIds ?? []);
  const failedChildTaskIds = new Set<string>();
  for (const step of workflowRepo.listSteps(runId).filter((item) => item.status === 'running')) {
    if (step.task_id && childTaskIdSet.has(step.task_id)) {
      failedChildTaskIds.add(step.task_id);
    }
    workflowRepo.updateStep(step.id, {
      status: 'failed',
      error,
    });
  }
  for (const childTaskId of failedChildTaskIds) {
    const child = taskRepo.get(childTaskId);
    if (child?.status !== 'in_progress') continue;
    taskRepo.updateStatus(child.id, 'failed');
  }
  if (!state) return null;
  return {
    ...state,
    workflowRunId: run?.id ?? runId,
    workflowPlan: markWorkflowPlanTasksBlockedByChildIds(state, failedChildTaskIds),
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
    let parsedState: AgentWorkflowState | null = null;
    try {
      parsedState = tools.parseGraphState(run.graph_state);
    } catch (err) {
      console.warn(`[graph-recovery] invalid graph_state for run ${run.id}: ${(err as Error).message}`);
    }
    const childTaskIdSet = new Set(parsedState?.childTaskIds ?? []);
    const interruptedChildTaskIds = new Set<string>();
    if (step.task_id && childTaskIdSet.has(step.task_id)) {
      interruptedChildTaskIds.add(step.task_id);
    }

    for (const activeRun of tools.listActiveAgentRunsByWorkflow(run.id)) {
      const interruptedRun = tools.interruptAgentRun(activeRun.id, error);
      if (interruptedRun) tools.broadcastAgentRunUpdated(run.room_id, interruptedRun);
    }

    const interruptedStep = tools.updateGraphStep(step.id, { status: 'interrupted', error });
    if (interruptedStep) tools.broadcastStepUpdated(run.room_id, interruptedStep);
    for (const childTaskId of interruptedChildTaskIds) {
      const child = taskRepo.get(childTaskId);
      if (child?.status !== 'in_progress') continue;
      const failedChild = taskRepo.updateStatus(child.id, 'failed');
      if (failedChild) tools.broadcastTaskUpdated(failedChild);
    }

    const blockedRun = tools.updateRun(run.id, { status: 'blocked', error });
    if (parsedState) {
      const nextState = {
        ...parsedState,
        workflowPlan: markWorkflowPlanTasksBlockedByChildIds(parsedState, interruptedChildTaskIds),
        currentNode: step.node_name ?? parsedState.currentNode,
        currentStepId: step.id,
        status: 'blocked' as const,
        error,
      };
      tools.updateGraphState(run.id, serializeGraphState(nextState));
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
    ? buildSuperpowersRuntimeGraph(deps, tools)
    : null;
  const routeDefinition = runtimeGraph?.executableDefinition
    ?? snapshot?.definition
    ?? null;
  const routePlan = routeDefinition ? compileRoutePlan(routeDefinition, Boolean(runtimeGraph)) : undefined;
  let nextState = state;
  if (isPlannerRevisionChangeRequestBlocked(nextState)) {
    return nextState;
  }
  let nodeToRun = nextNodeAfter(null, nextState, routePlan);
  if (
    runtimeGraph &&
    nextState.superpowersPhase === 'systematic_debugging' &&
    hasRunnableChildTask(nextState)
  ) {
    nodeToRun = 'systematic_debugging';
  }

  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (!nodeToRun || isTerminalResumeState(nextState)) {
      return nextState;
    }

    if (nodeToRun === 'systematic_debugging' && runtimeGraph) {
      if ((nextState.childTaskIds ?? []).length === 0 && (nextState.plan?.tasks.length ?? 0) > 0) {
        nextState = await nodes.dispatchNode(nextState);
        if (isPlannerRevisionChangeRequestBlocked(nextState)) {
          return nextState;
        }
        if (nextState.status === 'blocked' || nextState.status === 'failed' || nextState.status === 'cancelled') {
          return nextState;
        }
      }

      if (hasRunnableChildTask(nextState)) {
        const executedState = await nodes.executeNode({
          ...nextState,
          superpowersPhase: 'systematic_debugging',
        });
        if (isPlannerRevisionChangeRequestBlocked(executedState)) {
          return executedState;
        }
        nextState = renameLatestExecuteStep(
          executedState,
          tools,
          'systematic_debugging',
          'systematic_debugging',
        );
        if (shouldWaitForActiveAgentRun('execute', nextState)) {
          return nextState;
        }
      }

      nodeToRun = nextNodeAfter('systematic_debugging', nextState, routePlan);
      continue;
    }

    if (nodeToRun === 'tdd_execute' && runtimeGraph && hasRunnableChildTask(nextState)) {
      const executedState = await nodes.executeNode(nextState);
      if (isPlannerRevisionChangeRequestBlocked(executedState)) {
        return executedState;
      }
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

    if (nodeToRun === 'worktree' && runtimeGraph && !hasApprovedSuperpowersSpecArtifact(nextState)) {
      return blockSuperpowersSpecConfirm(nextState);
    }

    if (nodeToRun === 'approval' && runtimeGraph && !hasApprovedSuperpowersPlanArtifact(nextState)) {
      return blockSuperpowersPlanConfirm(nextState);
    }

    if (nodeToRun === 'dispatch' && runtimeGraph && !runtimeGraph.canDispatch(nextState)) {
      return blockSuperpowersDispatch(nextState);
    }

    if (runtimeGraph && isSuperpowersRoutingRouteNode(nodeToRun)) {
      nextState = await runSuperpowersRoutingNode(nodeToRun, nextState, tools);
    } else if (runtimeGraph && isSuperpowersPlanningRouteNode(nodeToRun)) {
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
    if (isPlannerRevisionChangeRequestBlocked(nextState)) {
      return nextState;
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

async function runSuperpowersRoutingNode(
  nodeToRun: SuperpowersRoutingNodeName,
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
): Promise<AgentWorkflowState> {
  const context = tools.readWorkflowContext(state.workflowRunId);
  const routingStep = nodeToRun === 'agent_assignment' || nodeToRun === 'reviewer_assignment'
    ? tools.createGraphStep({
      workflow_run_id: context.run.id,
      task_id: context.task.id,
      stage: inferStageForRoutingNode(nodeToRun),
      node_name: nodeToRun as never,
      status: 'running',
      sort_order: tools.nextStepSortOrder(context.run.id),
    })
    : null;
  if (routingStep) tools.broadcastStepCreated(context.room.id, routingStep);
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      return tools.createArtifactVersionDraft(input);
    },
    createAssistantMessage(input) {
      return tools.createWorkflowSessionMessage(input);
    },
    invokePlannerStage(input) {
      return invokeRoutingPlannerStage({
        tools,
        state: input.state,
        stageId: input.stageId,
        requiredFields: input.requiredFields,
        fallbackEvidence: input.fallbackEvidence,
      });
    },
    listAvailableWorkflowAgents() {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const provisioning = ensureWorkflowAgentsForRun({
        roomId: context.room.id,
        agents: context.agents,
        planTasks: state.plan?.tasks ?? [],
      });
      for (const agent of provisioning.joinedAgents) {
        tools.broadcastAgentJoined(context.room.id, agent);
      }
      return provisioning.agents
        .filter((agent) => agent.left_at === null)
        .map((agent): AvailableWorkflowAgent => ({
          id: agent.agent_id,
          roomAgentId: agent.id,
          name: agent.agent_name,
          provider: agent.acp_backend ?? 'codex',
          capabilities: agent.capabilities,
          workflowRoles: agent.workflow_role ? [agent.workflow_role] : [],
          acpEnabled: agent.acp_enabled === 1,
          acpPermissionMode: agent.acp_permission_mode,
          toolPolicyAllowed: agent.tool_policy?.allowed ?? [],
          workspaceWrite: agent.workspace_policy?.write ?? [],
          available: true,
          fallback: agent.agent_id === 'fullstack-engineer',
        }));
    },
  });

  let nextState: AgentWorkflowState;
  if (nodeToRun === 'intake') nextState = await nodes.intake(state);
  else if (nodeToRun === 'route_skills') nextState = await nodes.routeSkills(state);
  else if (nodeToRun === 'answer') nextState = await nodes.answer(state);
  else if (nodeToRun === 'analysis_plan') nextState = await nodes.analysisPlan(state);
  else if (nodeToRun === 'lightweight_plan') nextState = await nodes.lightweightPlan(state);
  else if (nodeToRun === 'debug_plan') nextState = await nodes.debugPlan(state);
  else if (nodeToRun === 'review_plan') nextState = await nodes.reviewPlan(state);
  else if (nodeToRun === 'agent_assignment') nextState = await nodes.agentAssignment(state);
  else nextState = await nodes.passthrough(state, nodeToRun);

  const updatedRun = tools.updateRun(context.run.id, {
    status: nextState.status,
    current_stage: inferStageForRoutingNode(nodeToRun),
    error: nextState.error,
  });
  if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
  if (routingStep) {
    const completedStep = tools.updateGraphStep(routingStep.id, {
      status: nextState.status === 'blocked' ? 'failed' : 'completed',
      error: nextState.status === 'blocked' ? nextState.error : null,
    });
    if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);
  }
  tools.updateGraphState(context.run.id, serializeGraphState(nextState));
  return nextState;
}

async function invokeRoutingPlannerStage(input: {
  tools: ReturnType<typeof createGraphTools>;
  state: AgentWorkflowState;
  stageId: SuperpowersRoutingPlannerStage;
  requiredFields: string[];
  fallbackEvidence: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const context = input.tools.readWorkflowContext(input.state.workflowRunId);
  const planner = input.tools.selectAgentForRole('planner', context.agents);
  if (!planner) return null;

  const prompt = [
    `当前 Superpowers 路由阶段：${input.stageId}`,
    '你是 planner controller。请分析用户消息、项目上下文和当前 workflow state，然后输出 fenced JSON evidence。',
    '不要执行代码修改，不要替 worker/reviewer/verifier 完成后续阶段。',
    '',
    '用户目标：',
    input.state.userGoal,
    '',
    '当前 workflow state 摘要：',
    JSON.stringify({
      selectedIntent: input.state.selectedIntent,
      selectedPath: input.state.selectedPath,
      activeSuperpowersStage: input.state.activeSuperpowersStage,
      artifactChangeRequestMessageId: input.state.artifactChangeRequestMessageId,
      artifactChangeRequestArtifactVersionId: input.state.artifactChangeRequestArtifactVersionId,
    }, null, 2),
    '',
    '项目上下文：',
    context.workflowContext || '(empty)',
    '',
    '必须输出 JSON 字段：',
    ...input.requiredFields.map((field) => `- ${field}`),
  ].join('\n');
  const step = input.tools.createGraphStep({
    workflow_run_id: context.run.id,
    task_id: context.task.id,
    stage: inferStageForRoutingNode(input.stageId),
    node_name: input.stageId,
    status: 'running',
    room_agent_id: planner.id,
    assigned_room_agent_id: planner.id,
    prompt,
    sort_order: input.tools.nextStepSortOrder(context.run.id),
  });
  input.tools.broadcastStepCreated(context.room.id, step);
  try {
    const runResult = await input.tools.runAcpAgent({
      agent: planner,
      projectPath: context.project.path,
      roomId: context.room.id,
      prompt,
      taskId: context.task.id,
      workflowRunId: context.run.id,
      workflowStepId: step.id,
      workflowStage: inferStageForRoutingNode(input.stageId),
    });
    const output = runResult.run.stdout || runResult.message.content;
    const evidence = runResult.status === 'completed'
      ? parseRoutingPlannerEvidence(output)
      : null;
    const missing = evidence
      ? input.requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(evidence, field))
      : input.requiredFields;
    const completedStep = input.tools.updateGraphStep(step.id, {
      status: evidence && missing.length === 0 ? 'completed' : 'skipped',
      agent_run_id: runResult.run.id,
      result: output,
      result_message_id: runResult.message.id,
      error: evidence && missing.length === 0
        ? null
        : `Routing planner evidence incomplete; fallback used for ${input.stageId}`,
    });
    if (completedStep) input.tools.broadcastStepUpdated(context.room.id, completedStep);
    return evidence && missing.length === 0 ? evidence : null;
  } catch (error) {
    const skippedStep = input.tools.updateGraphStep(step.id, {
      status: 'skipped',
      error: `Routing planner invocation failed; fallback used for ${input.stageId}: ${(error as Error).message}`,
    });
    if (skippedStep) input.tools.broadcastStepUpdated(context.room.id, skippedStep);
    return null;
  }
}

function inferStageForRoutingNode(node: SuperpowersRoutingNodeName): WorkflowStage {
  if (node === 'intake' || node === 'route_skills' || node === 'analysis_plan') return 'analysis';
  if (node === 'agent_assignment' || node === 'reviewer_assignment') return 'assignment';
  if (node === 'systematic_debugging') return 'implementation';
  if (node === 'answer') return 'acceptance';
  return 'planning';
}

async function runSuperpowersPlanningNode(
  nodeToRun: SuperpowersPlanningNodeName,
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  _nodes: ReturnType<typeof createGraphNodes>,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  if (nodeToRun === 'brainstorming') {
    return runSuperpowersPlannerRouteNode(nodeToRun, state, tools, runtimeGraph);
  }
  if (nodeToRun === 'writing_plans') {
    return runSuperpowersWritingPlansNode(state, tools, runtimeGraph);
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
  const promptedState = await runSuperpowersPhaseAgentIfAvailable({
    phase: nodeToRun,
    state: rawNextState,
    tools,
    stage: phaseStep.stage,
    role: phaseStep.role,
    stepId: step.id,
  });
  const nextState: AgentWorkflowState = {
    ...promptedState,
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

async function runSuperpowersPlannerRouteNode(
  nodeToRun: 'brainstorming',
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  const context = tools.readWorkflowContext(state.workflowRunId);
  const phaseStep = runtimeGraph.phaseSteps.find((step) => step.nodeName === nodeToRun);
  if (!phaseStep) throw new Error(`unknown Superpowers planning node: ${nodeToRun}`);

  const rawNextState = await callSuperpowersNode(nodeToRun, state, runtimeGraph);
  const nextState: AgentWorkflowState = {
    ...rawNextState,
    currentNode: 'planning',
    status: rawNextState.draftSpecArtifactVersionId ? 'awaiting_approval' : rawNextState.status,
    error: rawNextState.draftSpecArtifactVersionId ? 'Waiting for approved spec artifact version' : rawNextState.error,
  };
  const blocked = nextState.status === 'blocked';
  const awaitingApproval = nextState.status === 'awaiting_approval';
  const updatedRun = tools.updateRun(context.run.id, {
    status: blocked ? 'blocked' : awaitingApproval ? 'awaiting_approval' : 'running',
    current_stage: phaseStep.stage,
    error: blocked ? nextState.error : null,
  });
  if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
  tools.updateGraphState(context.run.id, serializeGraphState(nextState));
  return nextState;
}

async function runSuperpowersWritingPlansNode(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  runtimeGraph: SuperpowersRuntimeGraph,
): Promise<AgentWorkflowState> {
  const context = tools.readWorkflowContext(state.workflowRunId);
  const rawNextState = await runtimeGraph.nodes.writingPlans(state);
  let plannedState: AgentWorkflowState;
  try {
    plannedState = await hydratePlanStateFromWritingPlansArtifact(rawNextState, tools);
  } catch (err) {
    if (rawNextState.currentStepId) {
      const failedStep = tools.updateGraphStep(rawNextState.currentStepId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      if (failedStep) tools.broadcastStepUpdated(context.room.id, failedStep);
    }
    throw err;
  }
  const nextState: AgentWorkflowState = {
    ...plannedState,
    currentNode: 'planning',
    status: plannedState.draftPlanArtifactVersionId ? 'awaiting_approval' : plannedState.status,
    error: plannedState.draftPlanArtifactVersionId ? 'Waiting for approved plan artifact version' : plannedState.error,
  };
  const blocked = nextState.status === 'blocked';
  const awaitingApproval = nextState.status === 'awaiting_approval';
  const updatedRun = tools.updateRun(context.run.id, {
    status: blocked ? 'blocked' : awaitingApproval ? 'awaiting_approval' : 'running',
    current_stage: 'planning',
    error: blocked ? nextState.error : null,
  });
  if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
  tools.updateGraphState(context.run.id, serializeGraphState(nextState));
  return nextState;
}

async function hydratePlanStateFromWritingPlansArtifact(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
): Promise<AgentWorkflowState> {
  const draftPlanId = state.draftPlanArtifactVersionId;
  const draftPlan = typeof draftPlanId === 'string' ? workflowArtifactVersionRepo.get(draftPlanId) : null;
  if (!draftPlan || draftPlan.workflow_run_id !== state.workflowRunId || draftPlan.artifact_type !== 'plan') {
    return state;
  }

  const context = tools.readWorkflowContext(state.workflowRunId);
  const planRead = await readPlanFromWritingPlansArtifactOrPlanner(draftPlan.content, tools, context);
  const workflowPlan = planRead.plan.tasks.length > 0
    ? buildCoordinatorWorkflowPlan({
      workflowName: context.task.title,
      sourceMessageId: context.task.source_message_id ?? context.task.id,
      workflowPlan: state.workflowPlan,
      parsedPlan: planRead.plan,
    })
    : null;
  const riskAssessment = assessTaskRisk({
    title: context.task.title,
    description: context.task.description ?? '',
    scopeRead: Array.from(new Set(planRead.plan.tasks.flatMap((task) => task.scopeRead))),
    scopeWrite: Array.from(new Set(planRead.plan.tasks.flatMap((task) => task.scopeWrite))),
    acceptance: planRead.plan.tasks.flatMap((task) => task.acceptance),
    verificationCommands: planRead.plan.verificationCommands,
  });
  const approvalCard = riskAssessment.requiresApproval && riskAssessment.riskLevel !== 'low'
    ? buildApprovalCard({
      assessment: riskAssessment,
      agents: context.agents.map((agent) => agent.agent_id),
      executionMode: workflowPlan?.tasks.some((task) => task.mode === 'parallel') ? 'hybrid' : 'serial',
      risks: planRead.plan.risks,
      assumptions: planRead.plan.assumptions,
    })
    : null;
  const planWithRisk = {
    ...planRead.plan,
    taskKind: planRead.plan.taskKind ?? riskAssessment.taskKind,
    riskLevel: planRead.plan.riskLevel ?? riskAssessment.riskLevel,
    approvalReason: planRead.plan.approvalReason ?? riskAssessment.approvalReason,
    needsApproval: planRead.plan.needsApproval || riskAssessment.requiresApproval,
  };
  if (planRead.canonicalizeArtifact) {
    persistCanonicalWritingPlansDraftArtifact(draftPlan, {
      plan: planWithRisk,
      workflowPlan,
      riskAssessment,
      approvalCard,
      canonicalizedFrom: planRead.source === 'artifact' ? 'planner' : planRead.source,
      parseError: planRead.parseError,
    });
  }
  persistWritingPlansTaskArtifactMetadata(state, {
    plan: planWithRisk,
    workflowPlan,
    riskAssessment,
    approvalCard,
  });

  return {
    ...state,
    plan: planWithRisk,
    workflowPlan,
    riskAssessment,
    approvalCard,
  };
}

function persistCanonicalWritingPlansDraftArtifact(
  artifact: WorkflowArtifactVersion,
  metadata: {
    plan: NonNullable<AgentWorkflowState['plan']>;
    workflowPlan: AgentWorkflowState['workflowPlan'];
    riskAssessment: NonNullable<AgentWorkflowState['riskAssessment']>;
    approvalCard: AgentWorkflowState['approvalCard'];
    canonicalizedFrom: 'background' | 'planner';
    parseError: string;
  },
): void {
  workflowArtifactVersionRepo.updateDraftContent(artifact.id, {
    content: formatHydratedPlanArtifact(metadata.plan),
    structured_data: {
      plan: metadata.plan,
      workflow_plan_json: metadata.workflowPlan,
      risk_assessment: metadata.riskAssessment,
      approval_card: metadata.approvalCard,
      canonicalized: true,
      canonicalized_from: metadata.canonicalizedFrom,
      canonicalized_at: new Date().toISOString(),
      original_parse_error: metadata.parseError,
    },
  });
}

function persistWritingPlansTaskArtifactMetadata(
  state: AgentWorkflowState,
  metadata: {
    plan: NonNullable<AgentWorkflowState['plan']>;
    workflowPlan: AgentWorkflowState['workflowPlan'];
    riskAssessment: NonNullable<AgentWorkflowState['riskAssessment']>;
    approvalCard: AgentWorkflowState['approvalCard'];
  },
): void {
  if (!state.currentStepId) return;
  db.prepare(
    `UPDATE task_artifacts
     SET metadata = ?
     WHERE workflow_run_id = ?
       AND workflow_step_id = ?
       AND artifact_type = 'plan'`,
  ).run(JSON.stringify({
    ...metadata.plan,
    workflow_plan_json: metadata.workflowPlan,
    risk_assessment: metadata.riskAssessment,
    approval_card: metadata.approvalCard,
  }), state.workflowRunId, state.currentStepId);
}

async function readPlanFromWritingPlansArtifactOrPlanner(
  content: string,
  tools: ReturnType<typeof createGraphTools>,
  context: ReturnType<ReturnType<typeof createGraphTools>['readWorkflowContext']>,
): Promise<{
  plan: ParsedPlan;
  canonicalizeArtifact: boolean;
  source: 'artifact' | 'background' | 'planner';
  parseError: string;
}> {
  try {
    return {
      plan: normalizeParsedPlanTaskTitles(parsePlanArtifact(content), {
        parentTitle: context.task.title,
      }),
      canonicalizeArtifact: false,
      source: 'artifact',
      parseError: '',
    };
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const backgroundPlan = deriveCoordinatorPlanFromProductManagerBackground({
      taskTitle: context.task.title,
      taskDescription: context.task.description,
    });
    if (backgroundPlan) {
      return {
        plan: normalizeParsedPlanTaskTitles(backgroundPlan, {
          parentTitle: context.task.title,
        }),
        canonicalizeArtifact: true,
        source: 'background',
        parseError,
      };
    }
    return {
      plan: normalizeParsedPlanTaskTitles(await tools.generatePlan({
        projectName: context.project.name,
        projectPath: context.project.path,
        room: context.room,
        task: context.task,
        agents: context.agents,
        memories: context.memories ? [context.memories] : [],
        recentMessages: context.recentMessages,
      }), {
        parentTitle: context.task.title,
      }),
      canonicalizeArtifact: true,
      source: 'planner',
      parseError,
    };
  }
}

function formatHydratedPlanArtifact(plan: ParsedPlan): string {
  const verificationCommands = plan.verificationCommands.length > 0
    ? plan.verificationCommands
    : plan.verification.map((command) => ({
      command,
      reason: '',
      required: true,
    }));
  const artifact = {
    goal: plan.goal ?? plan.summary,
    summary: plan.summary,
    ...(plan.taskKind ? { taskKind: plan.taskKind } : {}),
    ...(plan.riskLevel ? { riskLevel: plan.riskLevel } : {}),
    ...(plan.approvalReason ? { approvalReason: plan.approvalReason } : {}),
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
    verification: verificationCommands,
    needsApproval: plan.needsApproval,
  };
  return `\`\`\`json\n${JSON.stringify(artifact, null, 2)}\n\`\`\``;
}

async function runSuperpowersPhaseAgentIfAvailable(input: {
  phase: SuperpowersPlanningNodeName;
  state: AgentWorkflowState;
  tools: ReturnType<typeof createGraphTools>;
  stage: WorkflowStage;
  role: WorkflowRole;
  stepId: string;
}): Promise<AgentWorkflowState> {
  const context = input.tools.readWorkflowContext(input.state.workflowRunId);
  const agent = input.tools.selectAgentForRole(input.role, context.agents);
  if (!agent) return input.state;

  const prompt = buildSuperpowersPhasePrompt(superpowersPlanningNodeToPhase(input.phase), {
    projectName: context.project.name,
    projectPath: context.project.path,
    room: context.room,
    task: context.task,
    agents: context.agents,
    workflowContext: context.workflowContext,
    childTasks: input.tools.listChildTasks(context.task.id),
    memoryContext: context.memories,
  });
  input.tools.updateGraphStep(input.stepId, {
    room_agent_id: agent.id,
    assigned_room_agent_id: agent.id,
    prompt,
  });

  const runResult = await input.tools.runAcpAgent({
    agent,
    projectPath: context.project.path,
    roomId: context.room.id,
    prompt,
    taskId: context.task.id,
    workflowRunId: context.run.id,
    workflowStepId: input.stepId,
    workflowStage: input.stage,
  });
  const output = runResult.run.stdout || runResult.message.content;
  input.tools.updateGraphStep(input.stepId, {
    agent_run_id: runResult.run.id,
    result: output,
    result_message_id: runResult.message.id,
    error: runResult.run.error,
  });
  if (runResult.status !== 'completed') {
    return {
      ...input.state,
      activeAgentRunId: runResult.run.id,
      status: runResult.status === 'cancelled' ? 'cancelled' : 'blocked',
      error: runResult.run.error ?? 'Superpowers phase agent failed',
    };
  }
  return applySuperpowersEvidencePatch({
    ...input.state,
    activeAgentRunId: runResult.run.id,
  }, parseSuperpowersEvidence(output));
}

function superpowersPlanningNodeToPhase(node: SuperpowersPlanningNodeName): Parameters<typeof buildSuperpowersPhasePrompt>[0] {
  if (node === 'writing_plans') return 'writing_plans';
  if (node === 'worktree') return 'worktree';
  return 'brainstorming';
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
  if (nodeToRun === 'spec_compliance_review' || nodeToRun === 'code_quality_review') {
    const existingReview = nodeToRun === 'spec_compliance_review'
      ? state.specComplianceReview
      : state.codeQualityReview;
    if (existingReview) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const step = tools.createGraphStep({
        workflow_run_id: context.run.id,
        task_id: context.task.id,
        stage: 'code_review',
        node_name: nodeToRun as never,
        status: 'running',
        sort_order: tools.nextStepSortOrder(context.run.id),
      });
      tools.broadcastStepCreated(context.room.id, step);
      const rawNextState = await callSuperpowersExecutionNode(nodeToRun, state, runtimeGraph);
      const nextState = normalizeSuperpowersReviewState({
        ...rawNextState,
        currentNode: 'review',
        currentStepId: step.id,
      }, nodeToRun);
      const blocked = nextState.status === 'blocked';
      const completedStep = tools.updateGraphStep(step.id, {
        status: blocked ? 'failed' : 'completed',
        error: blocked ? nextState.error : null,
      });
      if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);
      const updatedRun = tools.updateRun(context.run.id, {
        status: blocked ? 'blocked' : 'running',
        current_stage: 'code_review',
        error: blocked ? nextState.error : null,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
      return nextState;
    }

    const rawNextState = await callSuperpowersExecutionNode(nodeToRun, state, runtimeGraph);
    const nextState = normalizeSuperpowersReviewState({
      ...rawNextState,
      currentNode: 'review',
    }, nodeToRun);
    const blocked = nextState.status === 'blocked';
    const failed = nextState.status === 'failed';
    if (blocked || failed) {
      const context = tools.readWorkflowContext(state.workflowRunId);
      const updatedRun = tools.updateRun(context.run.id, {
        status: blocked ? 'blocked' : 'failed',
        current_stage: 'code_review',
        error: nextState.error,
      });
      if (updatedRun) tools.broadcastWorkflowUpdated(updatedRun);
      tools.updateGraphState(context.run.id, serializeGraphState(nextState));
    }
    return nextState;
  }

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
  const nextState = normalizeSuperpowersReviewState(applySuperpowersEvidenceFromLatestStepResult({
    ...rawNextState,
    currentNode: nodeToRun === 'tdd_execute' ? 'execute' : nodeToRun === 'finish_branch' ? 'acceptance' : 'review',
    currentStepId: step.id,
  }), nodeToRun);
  const blocked = nextState.status === 'blocked';
  const awaitingDecision = nextState.status === 'awaiting_decision';
  const completedStep = tools.updateGraphStep(step.id, {
    node_name: nodeToRun as never,
    status: blocked ? 'failed' : awaitingDecision ? 'awaiting_approval' : 'completed',
    error: blocked ? nextState.error : null,
  });
  if (completedStep) tools.broadcastStepUpdated(context.room.id, completedStep);

  const updatedRun = tools.updateRun(context.run.id, {
    status: blocked ? 'blocked' : awaitingDecision ? 'awaiting_decision' : 'running',
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
  return state;
}

function applySuperpowersVerificationEvidence(state: AgentWorkflowState): AgentWorkflowState {
  const commands = state.plan?.verificationCommands?.length
    ? state.plan.verificationCommands
    : (state.plan?.verification ?? []).map((command) => ({ command, reason: '', required: true }));

  const mappedState = {
    ...state,
    verificationEvidence: mapVerificationResultsToEvidence(
      state.verificationResults,
      commands,
      state.verificationEvidence ?? [],
    ),
  };
  return applySuperpowersEvidenceFromLatestStepResult(mappedState);
}

function applyTddEvidenceFromImplementationOutput(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
): AgentWorkflowState {
  if (!state.currentStepId) return state;
  const step = tools.getStep(state.currentStepId);
  if (!step || step.status !== 'completed') return state;
  const evidence = parseTddEvidence(step.result ?? '');
  const stateWithLegacyEvidence = evidence.length === 0 ? state : {
    ...state,
    tddEvidence: [
      ...(state.tddEvidence ?? []),
      ...evidence,
    ],
  };
  return applySuperpowersEvidencePatch(
    stateWithLegacyEvidence,
    parseSuperpowersEvidence(step.result ?? ''),
  );
}

function applySuperpowersEvidenceFromLatestStepResult(state: AgentWorkflowState): AgentWorkflowState {
  if (!state.currentStepId) return state;
  const step = workflowRepo.getStep(state.currentStepId);
  if (!step?.result) return state;
  return applySuperpowersEvidencePatch(state, parseSuperpowersEvidence(step.result));
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
  return renameLatestExecuteStep(state, tools, 'tdd_execute', 'tdd_execute');
}

function renameLatestExecuteStep(
  state: AgentWorkflowState,
  tools: ReturnType<typeof createGraphTools>,
  nodeName: 'tdd_execute' | 'systematic_debugging',
  superpowersPhase: AgentWorkflowState['superpowersPhase'],
): AgentWorkflowState {
  if (!state.currentStepId) return state;
  const step = tools.getStep(state.currentStepId);
  if (!step || step.node_name !== 'execute') return state;
  const updatedStep = tools.updateGraphStep(step.id, { node_name: nodeName as never });
  if (updatedStep) {
    const context = tools.readWorkflowContext(state.workflowRunId);
    tools.broadcastStepUpdated(context.room.id, updatedStep);
  }
  tools.updateGraphState(state.workflowRunId, serializeGraphState({
    ...state,
    superpowersPhase,
  }));
  return {
    ...state,
    superpowersPhase,
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
    currentNode: 'dispatch',
    superpowersPhase: 'plan_review',
  };
}

function blockSuperpowersSpecConfirm(state: AgentWorkflowState): AgentWorkflowState {
  const error = 'Superpowers planning requires approved spec artifact version';
  const blockedState = blockGraphWorkflowRun(state.workflowRunId, state, error);
  if (!blockedState) {
    throw new Error(error);
  }
  return {
    ...blockedState,
    currentNode: 'planning',
    superpowersPhase: 'spec_review',
  };
}

function blockSuperpowersPlanConfirm(state: AgentWorkflowState): AgentWorkflowState {
  const error = 'Superpowers planning requires approved plan artifact version';
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
  if (!hasApprovedSuperpowersPlanArtifact(state)) {
    return 'Superpowers dispatch requires approved plan artifact version';
  }
  return 'Superpowers dispatch requires approved implementation plan';
}

function hasApprovedSuperpowersPlanArtifact(state: AgentWorkflowState): boolean {
  return isApprovedSuperpowersPlanArtifact(state.approvedPlanArtifactVersionId, state.workflowRunId, 'plan') ||
    isApprovedSuperpowersPlanArtifact(state.lightweightPlanArtifactVersionId, state.workflowRunId, 'lightweight_plan');
}

function hasApprovedSuperpowersSpecArtifact(state: AgentWorkflowState): boolean {
  return isApprovedSuperpowersArtifact(state.approvedSpecArtifactVersionId, state.workflowRunId, 'spec');
}

function isApprovedSuperpowersPlanArtifact(
  artifactVersionId: string | null | undefined,
  workflowRunId: string,
  artifactType: 'plan' | 'lightweight_plan',
): boolean {
  return isApprovedSuperpowersArtifact(artifactVersionId, workflowRunId, artifactType);
}

function isApprovedSuperpowersArtifact(
  artifactVersionId: string | null | undefined,
  workflowRunId: string,
  artifactType: 'spec' | 'plan' | 'lightweight_plan',
): boolean {
  if (typeof artifactVersionId !== 'string' || artifactVersionId.trim().length === 0) return false;
  const artifact = workflowArtifactVersionRepo.get(artifactVersionId.trim());
  return artifact?.workflow_run_id === workflowRunId &&
    artifact.artifact_type === artifactType &&
    artifact.status === 'approved';
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

function isPlannerRevisionChangeRequestBlocked(state: AgentWorkflowState): boolean {
  return state.error === 'scope_change_request' || state.error === 'plan_change_request';
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

type SuperpowersRoutingNodeName =
  | 'intake'
  | 'route_skills'
  | 'answer'
  | 'analysis_plan'
  | 'lightweight_plan'
  | 'debug_plan'
  | 'debug_plan_confirm'
  | 'systematic_debugging'
  | 'review_plan'
  | 'reviewer_assignment'
  | 'agent_assignment';

type WorkflowRouteNode =
  | NonNullable<AgentWorkflowState['currentNode']>
  | SuperpowersRoutingNodeName
  | SuperpowersPlanningNodeName
  | SuperpowersExecutionNodeName;
type WorkflowRoutePlan = {
  start: WorkflowRouteNode;
  next: Map<WorkflowRouteNode, Array<{ to: WorkflowRouteNode; condition: string | null }>>;
};

const LEGACY_NODE_TYPE_TO_STATE_NODE: Record<WorkflowDefinitionNodeType, WorkflowRouteNode | null> = {
  context: 'context',
  intake: null,
  route_skills: null,
  answer: null,
  analysis_plan: null,
  lightweight_plan: null,
  debug_plan: null,
  debug_plan_confirm: null,
  systematic_debugging: null,
  review_plan: null,
  reviewer_assignment: null,
  agent_assignment: null,
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
  intake: 'intake',
  route_skills: 'route_skills',
  answer: 'answer',
  analysis_plan: 'analysis_plan',
  lightweight_plan: 'lightweight_plan',
  debug_plan: 'debug_plan',
  debug_plan_confirm: 'debug_plan_confirm',
  systematic_debugging: 'systematic_debugging',
  review_plan: 'review_plan',
  reviewer_assignment: 'reviewer_assignment',
  agent_assignment: 'agent_assignment',
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

function isSuperpowersRoutingRouteNode(node: WorkflowRouteNode): node is SuperpowersRoutingNodeName {
  return (
    node === 'intake'
    || node === 'route_skills'
    || node === 'answer'
    || node === 'analysis_plan'
    || node === 'lightweight_plan'
    || node === 'debug_plan'
    || node === 'debug_plan_confirm'
    || node === 'systematic_debugging'
    || node === 'review_plan'
    || node === 'reviewer_assignment'
    || node === 'agent_assignment'
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
  if (outgoing.length === 0) {
    if (node === 'agent_assignment') {
      return state.selectedIntent === 'debug' ? 'systematic_debugging' : 'dispatch';
    }
    return null;
  }
  if (node === 'approval' && state.runtimeProfile === 'superpowers' && !state.agentAssignmentArtifactVersionId) {
    const route = routeAfterApproval(state);
    if (route === END) return null;
    return 'agent_assignment';
  }
  if (outgoing.length === 1 && !outgoing[0]!.condition) return outgoing[0]!.to;
  const routed = routeRuntimeNode(node, state);
  if (routed) {
    if (node === 'approval' && routed === 'agent_assignment') return routed;
    const matching = outgoing.find((edge) => edge.to === routed);
    if (matching) return matching.to;
    if (node !== 'approval') return null;
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

function isSuperpowersExecutionPhase(value: unknown): value is SuperpowersExecutionNodeName | 'systematic_debugging' {
  return (
    value === 'tdd_execute'
    || value === 'systematic_debugging'
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
    if (state.selectedIntent === 'review_only') {
      if (node === 'spec_compliance_review') return 'verify';
      if (node === 'code_quality_review') return 'verify';
      if (node === 'tdd_execute') return 'spec_compliance_review';
    }
    if (node === 'tdd_execute') return hasRunnableChildTask(state) ? 'tdd_execute' : 'spec_compliance_review';
    if (node === 'spec_compliance_review') {
      return state.reviewVerdict === 'changes_requested' ? 'tdd_execute' : 'code_quality_review';
    }
    if (node === 'code_quality_review') {
      return state.reviewVerdict === 'changes_requested' ? 'tdd_execute' : 'verify';
    }
    if (node === 'finish_branch') return state.finishBranchDecision?.decision ? 'acceptance' : null;
  }
  if (node === 'approval') {
    if (state.runtimeProfile === 'superpowers') {
      const route = routeAfterApproval(state);
      if (route === END) return null;
      return state.agentAssignmentArtifactVersionId ? route : 'agent_assignment';
    }
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
  if (node === 'route_skills') {
    return condition === state.selectedIntent;
  }
  if (node === 'agent_assignment') {
    if (condition === 'debug') return state.selectedIntent === 'debug';
    return state.selectedIntent !== 'debug';
  }
  if (isSuperpowersPlanningRouteNode(node)) return false;
  if (isSuperpowersExecutionRouteNode(node)) {
    if (state.selectedIntent === 'review_only') {
      if (node === 'spec_compliance_review') {
        if (condition === 'changes_requested') return false;
        if (condition === 'review_only') return true;
        if (condition === 'pass' || condition === 'approved' || condition === 'verify') return true;
      }
      if (node === 'code_quality_review') {
        if (condition === 'changes_requested') return false;
        if (condition === 'pass' || condition === 'approved' || condition === 'verify') return true;
      }
      if (node === 'tdd_execute' && condition === 'has_runnable_child') return false;
    }
    if (node === 'tdd_execute' && condition === 'has_runnable_child') return hasRunnableChildTask(state);
    if (condition === 'changes_requested') return state.reviewVerdict === 'changes_requested';
    if (condition === 'pass' || condition === 'approved' || condition === 'verify') return state.reviewVerdict !== 'changes_requested';
    if (node === 'finish_branch' && (condition === 'completed' || condition === 'acceptance')) {
      return Boolean(state.finishBranchDecision?.decision);
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
    if (state.runtimeProfile === 'superpowers') {
      const route = routeAfterApproval(state);
      if (route === END) return null;
      return state.agentAssignmentArtifactVersionId ? route : 'agent_assignment';
    }
    const route = routeAfterApproval(state);
    return route === END ? null : route;
  }
  if (node === 'agent_assignment') return state.selectedIntent === 'debug' ? 'systematic_debugging' : 'dispatch';
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
