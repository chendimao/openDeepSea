import { formatMemoryContext } from '../../memory/context.js';
import { distillFromTask } from '../../memory/distill.js';
import { runAgentOnce, type RespondAsAgentInput } from '../../dispatcher.js';
import { agentRunRepo } from '../../repos/agent-runs.js';
import { memoryRepo } from '../../repos/memory.js';
import { messageRepo } from '../../repos/messages.js';
import { projectRepo } from '../../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../../repos/rooms.js';
import { settingsRepo } from '../../repos/settings.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';
import { recordTaskEvent } from '../../task-conversation.js';
import type {
  AgentRun,
  AgentRunStatus,
  Message,
  RoomAgent,
  Task,
  TaskArtifact,
  TaskCreatedFrom,
  TaskEventType,
  WorkflowRole,
  WorkflowRun,
  WorkflowStep,
  SettingsResolution,
} from '../../types.js';
import { wsHub } from '../../ws-hub.js';
import { generateLangChainPlan, type LangChainPlannerInput } from '../langchain-planner.js';
import type { ParsedPlan } from '../plan-parser.js';
import { formatRecentMessagesForPlanner } from '../orchestrator.js';
import { parseGraphState } from './state.js';

export interface GraphRuntimeDeps {
  planner?: (input: LangChainPlannerInput) => Promise<ParsedPlan>;
  runAcpAgent?: (input: RespondAsAgentInput) => Promise<{
    run: AgentRun;
    message: Message;
    status: AgentRunStatus;
  }>;
}

interface WorkflowRuntimeContext {
  run: NonNullable<ReturnType<typeof workflowRepo.getRun>>;
  room: NonNullable<ReturnType<typeof roomRepo.get>>;
  project: NonNullable<ReturnType<typeof projectRepo.get>>;
  task: NonNullable<ReturnType<typeof taskRepo.get>>;
  agents: RoomAgent[];
  artifacts: ReturnType<typeof workflowRepo.listArtifacts>;
  memories: string;
  recentMessages: string[];
}

export interface GraphTools {
  readWorkflowContext: (workflowRunId: string) => WorkflowRuntimeContext;
  generatePlan: (input: LangChainPlannerInput) => Promise<ParsedPlan>;
  createGraphStep: typeof workflowRepo.createStep;
  updateGraphStep: typeof workflowRepo.updateStep;
  createArtifact: typeof workflowRepo.createArtifact;
  createChildTask: typeof taskRepo.create;
  updateTaskStatus: typeof taskRepo.updateStatus;
  listChildTasks: typeof taskRepo.listChildren;
  listSteps: typeof workflowRepo.listSteps;
  listArtifacts: typeof workflowRepo.listArtifacts;
  broadcastWorkflowUpdated: (workflow: WorkflowRun) => void;
  broadcastStepCreated: (roomId: string, step: WorkflowStep) => void;
  broadcastStepUpdated: (roomId: string, step: WorkflowStep) => void;
  broadcastArtifactCreated: (roomId: string, artifact: TaskArtifact) => void;
  broadcastTaskCreated: (task: Task) => void;
  broadcastTaskUpdated: (task: Task) => void;
  recordWorkflowEvent: (input: {
    roomId: string;
    taskId: string;
    taskTitle?: string;
    workflowRunId: string;
    workflowStepId?: string | null;
    eventType: TaskEventType;
    origin?: TaskCreatedFrom;
    content: string;
  }) => void;
  updateRun: typeof workflowRepo.updateRun;
  updateGraphState: typeof workflowRepo.updateGraphState;
  nextStepSortOrder: (workflowRunId: string) => number;
  selectAgentForRole: (role: WorkflowRole, agents: RoomAgent[]) => RoomAgent | null;
  runAcpAgent: (input: RespondAsAgentInput) => Promise<{
    run: AgentRun;
    message: Message;
    status: AgentRunStatus;
  }>;
  upsertTaskSummaryMemory: typeof memoryRepo.upsertTaskSummary;
  resolveRoomSettings: (roomId: string) => SettingsResolution | null;
  distillTask: typeof distillFromTask;
  listActiveAgentRunsByWorkflow: typeof agentRunRepo.listActiveByWorkflow;
  interruptAgentRun: typeof agentRunRepo.interruptRun;
  parseGraphState: typeof parseGraphState;
  listRunningSteps: typeof workflowRepo.listRunningSteps;
  getRun: typeof workflowRepo.getRun;
  getStep: typeof workflowRepo.getStep;
  broadcastAgentRunUpdated: (roomId: string, run: AgentRun) => void;
}

export function createGraphTools(deps: GraphRuntimeDeps = {}): GraphTools {
  const planner = deps.planner ?? ((input: LangChainPlannerInput) => generateLangChainPlan(input));
  const runAcpAgent = deps.runAcpAgent ?? runAgentOnce;

  return {
    readWorkflowContext(workflowRunId: string) {
      const run = workflowRepo.getRun(workflowRunId);
      if (!run) throw new Error('workflow not found');
      const room = roomRepo.get(run.room_id);
      const project = projectRepo.get(run.project_id);
      const task = taskRepo.get(run.task_id);
      if (!room || !project || !task) throw new Error('workflow context is incomplete');

      const memories = formatMemoryContext(
        memoryRepo.listForRoomContext({
          projectId: project.id,
          roomId: room.id,
          taskId: task.id,
        }),
      );
      const recentMessages = formatRecentMessagesForPlanner(messageRepo.listByRoom(room.id, 20), {
        limit: 20,
      });

      return {
        run,
        room,
        project,
        task,
        agents: roomAgentRepo.listByRoom(run.room_id),
        artifacts: workflowRepo.listArtifacts(run.id),
        memories,
        recentMessages,
      };
    },
    async generatePlan(input: LangChainPlannerInput) {
      return planner(input);
    },
    createGraphStep: workflowRepo.createStep.bind(workflowRepo),
    updateGraphStep: workflowRepo.updateStep.bind(workflowRepo),
    createArtifact: workflowRepo.createArtifact.bind(workflowRepo),
    createChildTask: taskRepo.create.bind(taskRepo),
    updateTaskStatus: taskRepo.updateStatus.bind(taskRepo),
    listChildTasks: taskRepo.listChildren.bind(taskRepo),
    listSteps: workflowRepo.listSteps.bind(workflowRepo),
    listArtifacts: workflowRepo.listArtifacts.bind(workflowRepo),
    broadcastWorkflowUpdated(workflow: WorkflowRun) {
      wsHub.broadcast(workflow.room_id, { type: 'workflow:updated', roomId: workflow.room_id, workflow });
    },
    broadcastStepCreated(roomId: string, step: WorkflowStep) {
      wsHub.broadcast(roomId, { type: 'workflow_step:created', roomId, step });
    },
    broadcastStepUpdated(roomId: string, step: WorkflowStep) {
      wsHub.broadcast(roomId, { type: 'workflow_step:updated', roomId, step });
    },
    broadcastArtifactCreated(roomId: string, artifact: TaskArtifact) {
      wsHub.broadcast(roomId, { type: 'workflow_artifact:created', roomId, artifact });
    },
    broadcastTaskCreated(task: Task) {
      wsHub.broadcast(task.room_id, { type: 'task:created', task });
    },
    broadcastTaskUpdated(task: Task) {
      wsHub.broadcast(task.room_id, { type: 'task:updated', task });
    },
    recordWorkflowEvent(input) {
      recordTaskEvent({
        roomId: input.roomId,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        workflowRunId: input.workflowRunId,
        workflowStepId: input.workflowStepId ?? null,
        eventType: input.eventType,
        origin: input.origin,
        content: input.content,
      });
    },
    updateRun: workflowRepo.updateRun.bind(workflowRepo),
    updateGraphState: workflowRepo.updateGraphState.bind(workflowRepo),
    nextStepSortOrder(workflowRunId: string) {
      return workflowRepo.listSteps(workflowRunId).length + 1;
    },
    selectAgentForRole(role: WorkflowRole, agents: RoomAgent[]) {
      const executableAgents = agents.filter((agent) => agent.acp_enabled && agent.acp_backend);
      const exact = executableAgents.filter((agent) => agent.workflow_role === role);
      if (exact.length > 0) return exact[0] ?? null;
      if (role !== 'executor') return this.selectAgentForRole('executor', executableAgents);
      return null;
    },
    runAcpAgent,
    upsertTaskSummaryMemory: memoryRepo.upsertTaskSummary.bind(memoryRepo),
    resolveRoomSettings: settingsRepo.resolveForRoom.bind(settingsRepo),
    distillTask: distillFromTask,
    listActiveAgentRunsByWorkflow: agentRunRepo.listActiveByWorkflow.bind(agentRunRepo),
    interruptAgentRun: agentRunRepo.interruptRun.bind(agentRunRepo),
    parseGraphState,
    listRunningSteps: workflowRepo.listRunningSteps.bind(workflowRepo),
    getRun: workflowRepo.getRun.bind(workflowRepo),
    getStep: workflowRepo.getStep.bind(workflowRepo),
    broadcastAgentRunUpdated(roomId: string, run: AgentRun) {
      wsHub.broadcast(roomId, { type: 'agent_run:updated', roomId, run });
    },
  };
}
