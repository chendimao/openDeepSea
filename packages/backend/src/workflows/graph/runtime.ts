import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { agentRunRepo } from '../../repos/agent-runs.js';
import { projectRepo } from '../../repos/projects.js';
import { roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';
import { runRegistry } from '../../run-registry.js';
import type { WorkflowRun } from '../../types.js';
import { createGraphNodes } from './nodes.js';
import { routeAfterApproval, routeAfterExecute, routeAfterRepairDecision, routeAfterReview } from './router.js';
import { emptyAgentWorkflowState, parseGraphState, serializeGraphState, type AgentWorkflowState } from './state.js';
import { createGraphTools, type GraphRuntimeDeps } from './tools.js';

const GraphState = Annotation.Root({
  workflowRunId: Annotation<string>(),
  projectId: Annotation<string>(),
  roomId: Annotation<string>(),
  taskId: Annotation<string>(),
  userGoal: Annotation<string>(),
  projectPath: Annotation<string>(),
  plan: Annotation<AgentWorkflowState['plan']>(),
  currentNode: Annotation<AgentWorkflowState['currentNode']>(),
  currentStepId: Annotation<string | null>(),
  activeAgentRunId: Annotation<string | null>(),
  childTaskIds: Annotation<string[]>(),
  reviewFindings: Annotation<string[]>(),
  reviewVerdict: Annotation<AgentWorkflowState['reviewVerdict']>(),
  verificationResults: Annotation<AgentWorkflowState['verificationResults']>(),
  repairAttempts: Annotation<number>(),
  approval: Annotation<AgentWorkflowState['approval']>(),
  status: Annotation<AgentWorkflowState['status']>(),
  error: Annotation<string | null>(),
});

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
  const { task, room, project } = requireTaskContext(taskId);
  const existing = workflowRepo.getActiveByTask(task.id);
  if (existing) throw new Error('task already has an active workflow');

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
    graph_version: 'phase-b-v1',
    graph_state: serializeGraphState(pendingState),
  });

  const initialState: AgentWorkflowState = {
    ...pendingState,
    workflowRunId: run.id,
  };
  workflowRepo.updateGraphState(run.id, serializeGraphState(initialState));

  const graph = buildRuntimeGraph(deps);
  let finalState: AgentWorkflowState;
  try {
    finalState = await graph.invoke(initialState, {
      configurable: {
        thread_id: run.id,
      },
    }) as AgentWorkflowState;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failedState = blockGraphWorkflowRun(run.id, initialState, error);
    workflowRepo.updateGraphState(run.id, serializeGraphState(failedState));
    throw err;
  }

  workflowRepo.updateGraphState(run.id, serializeGraphState(finalState));
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  return latest;
}

export async function approveGraphWorkflow(
  id: string,
  approvedBy = 'user',
  deps: GraphRuntimeDeps = {},
): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  if (run.status !== 'awaiting_approval') throw new Error('workflow is not awaiting approval');
  const state = requireGraphState(run);
  const approvedState: AgentWorkflowState = {
    ...state,
    approval: 'approved',
    status: 'running',
    error: null,
  };
  workflowRepo.updateRun(run.id, {
    status: 'running',
    approved_by: approvedBy,
    error: null,
  });
  workflowRepo.updateGraphState(run.id, serializeGraphState(approvedState));

  const finalState = await resumeGraphWorkflowFromState(approvedState, deps);
  workflowRepo.updateGraphState(run.id, serializeGraphState(finalState));
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  return latest;
}

export async function retryGraphWorkflow(id: string, deps: GraphRuntimeDeps = {}): Promise<WorkflowRun> {
  const run = requireGraphRun(id);
  if (run.status === 'running' || run.status === 'awaiting_approval') {
    throw new Error('workflow is already running');
  }
  const state = requireGraphState(run);
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

  const finalState = await resumeGraphWorkflowFromState(retryState, deps);
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
  const state = parseGraphState(run.graph_state);
  if (state) {
    workflowRepo.updateGraphState(run.id, serializeGraphState({
      ...state,
      status: 'cancelled',
      error: null,
    }));
  }
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  tools.broadcastWorkflowUpdated(latest);
  return latest;
}

function blockGraphWorkflowRun(runId: string, state: AgentWorkflowState, error: string): AgentWorkflowState {
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
  return {
    ...state,
    workflowRunId: run?.id ?? runId,
    status: 'blocked',
    error,
  };
}

export function recoverGraphWorkflow(error: string): number {
  const tools = createGraphTools();
  let count = 0;
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

function retryCurrentNode(state: AgentWorkflowState): AgentWorkflowState['currentNode'] {
  if (state.currentNode === 'execute') return 'dispatch';
  if (state.currentNode === 'review') return 'execute';
  if (state.currentNode === 'verify') return 'review';
  if (state.currentNode === 'acceptance') return 'verify';
  return state.currentNode;
}

async function resumeGraphWorkflowFromState(
  state: AgentWorkflowState,
  deps: GraphRuntimeDeps,
): Promise<AgentWorkflowState> {
  const tools = createGraphTools(deps);
  const nodes = createGraphNodes(tools);
  let nextState = state;
  let nextNode = nextNodeAfter(nextState);

  for (let iteration = 0; iteration < 20; iteration += 1) {
    if (!nextNode || isTerminalResumeState(nextState)) {
      return nextState;
    }

    if (nextNode === 'context') {
      nextState = await nodes.contextNode(nextState);
    } else if (nextNode === 'planning') {
      nextState = await nodes.planningNode(nextState);
    } else if (nextNode === 'approval') {
      nextState = await nodes.approvalNode(nextState);
    } else if (nextNode === 'dispatch') {
      nextState = await nodes.dispatchNode(nextState);
    } else if (nextNode === 'execute') {
      nextState = await nodes.executeNode(nextState);
    } else if (nextNode === 'review') {
      nextState = await nodes.reviewNode(nextState);
    } else if (nextNode === 'repair_decision') {
      nextState = await nodes.repairDecisionNode(nextState);
    } else if (nextNode === 'verify') {
      nextState = await nodes.verifyNode(nextState);
    } else if (nextNode === 'acceptance') {
      nextState = await nodes.acceptanceNode(nextState);
    } else if (nextNode === 'memory') {
      nextState = await nodes.memoryNode(nextState);
    }
    nextNode = nextNodeAfter(nextState);
  }

  throw new Error('graph retry exceeded resume limit');
}

function isTerminalResumeState(state: AgentWorkflowState): boolean {
  return (
    state.status === 'awaiting_approval' ||
    state.status === 'awaiting_decision' ||
    state.status === 'blocked' ||
    state.status === 'cancelled' ||
    state.status === 'failed' ||
    state.status === 'completed'
  );
}

function nextNodeAfter(state: AgentWorkflowState): AgentWorkflowState['currentNode'] | null {
  if (isTerminalResumeState(state)) return null;
  if (!state.currentNode) return 'context';
  if (state.currentNode === 'context') return 'planning';
  if (state.currentNode === 'planning') return 'approval';
  if (state.currentNode === 'approval') {
    const route = routeAfterApproval(state);
    return route === END ? null : route;
  }
  if (state.currentNode === 'dispatch') return 'execute';
  if (state.currentNode === 'execute') {
    const route = routeAfterExecute(state);
    return route === END ? null : route;
  }
  if (state.currentNode === 'review') {
    const route = routeAfterReview(state);
    return route === END ? null : route;
  }
  if (state.currentNode === 'repair_decision') {
    const route = routeAfterRepairDecision(state);
    return route === END ? null : route;
  }
  if (state.currentNode === 'verify') return 'acceptance';
  if (state.currentNode === 'acceptance') return state.status === 'completed' ? 'memory' : null;
  return null;
}
