import { formatMemoryContext } from '../../memory/context.js';
import { memoryRepo } from '../../repos/memory.js';
import { messageRepo } from '../../repos/messages.js';
import { projectRepo } from '../../repos/projects.js';
import { roomAgentRepo, roomRepo } from '../../repos/rooms.js';
import { taskRepo } from '../../repos/tasks.js';
import { workflowRepo } from '../../repos/workflows.js';
import type { RoomAgent, WorkflowRole } from '../../types.js';
import { generateLangChainPlan, type LangChainPlannerInput } from '../langchain-planner.js';
import type { ParsedPlan } from '../plan-parser.js';
import { formatRecentMessagesForPlanner } from '../orchestrator.js';

export interface GraphRuntimeDeps {
  planner?: (input: LangChainPlannerInput) => Promise<ParsedPlan>;
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
  updateRun: typeof workflowRepo.updateRun;
  updateGraphState: typeof workflowRepo.updateGraphState;
  nextStepSortOrder: (workflowRunId: string) => number;
  selectAgentForRole: (role: WorkflowRole, agents: RoomAgent[]) => RoomAgent | null;
}

export function createGraphTools(deps: GraphRuntimeDeps = {}): GraphTools {
  const planner = deps.planner ?? ((input: LangChainPlannerInput) => generateLangChainPlan(input));

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
    updateRun: workflowRepo.updateRun.bind(workflowRepo),
    updateGraphState: workflowRepo.updateGraphState.bind(workflowRepo),
    nextStepSortOrder(workflowRunId: string) {
      return workflowRepo.listSteps(workflowRunId).length + 1;
    },
    selectAgentForRole(role: WorkflowRole, agents: RoomAgent[]) {
      const exact = agents.filter((agent) => agent.workflow_role === role);
      return exact.find((agent) => agent.acp_enabled) ?? exact[0] ?? null;
    },
  };
}
