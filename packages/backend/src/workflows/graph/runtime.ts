import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { projectRepo } from '../../repos/projects.js';
import { roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';
import type { WorkflowRun } from '../../types.js';
import { createGraphNodes } from './nodes.js';
import { routeAfterApproval } from './router.js';
import { emptyAgentWorkflowState, serializeGraphState, type AgentWorkflowState } from './state.js';
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
    .addEdge(START, 'context')
    .addEdge('context', 'planning')
    .addEdge('planning', 'approval_gate')
    .addConditionalEdges('approval_gate', routeAfterApproval)
    .addEdge('dispatch', END)
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
  const finalState = await graph.invoke(initialState, {
    configurable: {
      thread_id: run.id,
    },
  });

  workflowRepo.updateGraphState(run.id, serializeGraphState(finalState as AgentWorkflowState));
  const latest = workflowRepo.getRun(run.id);
  if (!latest) throw new Error('workflow not found');
  return latest;
}
