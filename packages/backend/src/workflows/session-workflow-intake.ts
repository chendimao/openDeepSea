import { taskRepo } from '../repos/tasks.js';
import { workflowDefinitionRepo } from '../repos/workflow-definitions.js';
import { workflowRepo } from '../repos/workflows.js';
import { recordTaskCreatedEvent } from '../task-conversation.js';
import type { WorkflowDefinitionGraph } from '../types.js';
import type { PlatformSkillRef, Project, Room, Session, SessionMessage } from '../types.js';
import { wsHub } from '../ws-hub.js';
import { emptyAgentWorkflowState, serializeGraphState } from './graph/state.js';
import { SUPERPOWERS_V2_GRAPH_VERSION } from './superpowers-stage-registry.js';

interface SessionWorkflowIntakeInput {
  project: Project;
  session: Session;
  sourceMessage: SessionMessage;
  room: Room;
  contextContent?: string | null;
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
  platformSkillRefs: PlatformSkillRef[];
}

export function createSessionWorkflowIntake(input: SessionWorkflowIntakeInput) {
  const definition = workflowDefinitionRepo.getSuperpowersDefinition();
  const task = taskRepo.create({
    room_id: input.room.id,
    project_id: input.project.id,
    title: buildIntakeTaskTitle(input.sourceMessage.content),
    description: buildIntakeTaskDescription(input),
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: 'planner',
    source_message_id: input.sourceMessage.id,
    created_from: 'chat_plan',
  });
  wsHub.broadcast(input.room.id, { type: 'task:created', task });
  recordTaskCreatedEvent({
    roomId: input.room.id,
    task,
    origin: 'chat_plan',
    content: `SessionOS 已创建 Superpowers intake 任务「${task.title}」。`,
    metadata: {
      session_id: input.session.id,
      source_message_id: input.sourceMessage.id,
      execution_trigger: 'workflow_intake',
    },
  });
  const pendingState = emptyAgentWorkflowState({
    workflowRunId: 'pending',
    projectId: input.project.id,
    roomId: input.room.id,
    taskId: task.id,
    userGoal: input.sourceMessage.content,
    projectPath: input.project.path,
  });
  const intakeState = {
    ...pendingState,
    currentNode: 'context' as const,
    activeSuperpowersStage: 'intake',
    selectedIntent: null,
    selectedPath: [],
    routingArtifactVersionId: null,
    analysisArtifactVersionId: null,
  };
  const workflow = workflowRepo.createRun({
    room_id: input.room.id,
    project_id: input.project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'planning',
    approval_required: true,
    graph_version: SUPERPOWERS_V2_GRAPH_VERSION,
    graph_state: serializeGraphState(intakeState),
    workflow_definition_id: definition.id,
    workflow_definition_version: definition.version,
    workflow_definition_snapshot: JSON.stringify(createWorkflowDefinitionSnapshot(definition)),
  });
  const updated = workflowRepo.updateGraphState(workflow.id, serializeGraphState({
    ...intakeState,
    workflowRunId: workflow.id,
  }));
  const finalWorkflow = updated ?? workflow;
  wsHub.broadcast(input.room.id, { type: 'workflow:created', roomId: input.room.id, workflow: finalWorkflow });
  return { task, workflow: finalWorkflow };
}

function createWorkflowDefinitionSnapshot(definition: {
  id: string;
  name: string;
  description: string | null;
  builtin_key: string | null;
  version: number;
  definition: WorkflowDefinitionGraph;
}) {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    builtinKey: definition.builtin_key,
    version: definition.version,
    definition: definition.definition,
  };
}

function buildIntakeTaskTitle(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 40 ? `${compact.slice(0, 40)}...` : compact || 'Session workflow';
}

function buildIntakeTaskDescription(input: SessionWorkflowIntakeInput): string {
  const lines = [
    input.sourceMessage.content,
    input.contextContent ? `\n最近会话上下文：\n${input.contextContent}` : null,
    '',
    `Session: ${input.session.id}`,
    `Source message: ${input.sourceMessage.id}`,
  ].filter((line): line is string => line !== null);
  if (input.workspaceFileRefs.length > 0) {
    lines.push('', 'Workspace refs:', ...input.workspaceFileRefs.map((ref) => `- ${ref}`));
  }
  if (input.libraryFileRefs.length > 0) {
    lines.push('', 'Library refs:', ...input.libraryFileRefs.map((ref) => `- ${ref}`));
  }
  if (input.platformSkillRefs.length > 0) {
    lines.push(
      '',
      'Platform skills:',
      ...input.platformSkillRefs.map((ref) => `- ${ref.provider}:${ref.name}`),
    );
  }
  return lines.join('\n');
}
