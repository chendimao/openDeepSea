import type {
  AgentRunStatus,
  RoomAgent,
  Task,
  TaskActionKind,
  TaskActionStartResult,
  TaskWorkflowPlan,
} from './types.js';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { agentRepo } from './repos/agents.js';
import { respondAsAgent } from './dispatcher.js';
import { projectRepo } from './repos/projects.js';
import { agentRunRepo } from './repos/agent-runs.js';
import { messageRepo } from './repos/messages.js';
import { roomAgentRepo, roomRepo } from './repos/rooms.js';
import { taskEventRepo } from './repos/task-events.js';
import { taskRepo } from './repos/tasks.js';
import { isExecutableAgent, resolveWorkflowExecutor, selectWorkflowAgentForRole } from './workflows/role-resolver.js';
import { buildSuperpowersPhasePrompt, buildSuperpowersRoutingPrompt } from './workflows/prompts.js';
import type { SuperpowersRuntimePhase } from './workflows/superpowers-skills.js';
import {
  parseSuperpowersRouting,
  routingActionToTaskAction,
  type SuperpowersRouting,
} from './workflows/superpowers-routing.js';
import { wsHub } from './ws-hub.js';

const TASK_ACTION_KINDS: readonly TaskActionKind[] = [
  'start_execution',
  'auto_advance',
  'route_skills',
  'brainstorming',
  'writing_plans',
  'subagent_execution',
  'systematic_debugging',
  'verification',
  'finish_branch',
];

export interface TaskActionAgentResult {
  status: AgentRunStatus | 'failed';
  content: string;
  error: string | null;
  runId?: string;
  messageId?: string;
}

export interface TaskActionRunAgentInput {
  agent: RoomAgent;
  prompt: string;
  taskId: string;
  sourceMessageId?: string | null;
}

export interface StartTaskActionInput {
  roomId: string;
  taskId: string;
  action: TaskActionKind;
  senderId?: string;
  senderName?: string;
  runAgent?: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}

export async function startTaskAction(input: StartTaskActionInput): Promise<TaskActionStartResult> {
  const task = taskRepo.get(input.taskId);
  if (!task || task.room_id !== input.roomId) throw new Error('task not found');
  const room = roomRepo.get(input.roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');

  const runningActionBlock = findRunningTaskActionBlock(input.taskId, input.action);
  if (runningActionBlock) {
    return {
      action: input.action,
      status: 'blocked',
      run_ids: [],
      blocked_reason: '任务动作正在运行，请等待当前动作完成',
    };
  }

  const activeRunBlock = findActiveTaskRunBlock(input.taskId);
  if (activeRunBlock) {
    return {
      action: input.action,
      status: 'blocked',
      run_ids: [activeRunBlock.id],
      blocked_reason: '任务已有运行中的智能体执行，请等待当前执行完成',
    };
  }

  if (input.action === 'start_execution') {
    recordTaskActionEvent(input.roomId, input.taskId, input.action, 'running', {});
    let workflow: TaskWorkflowPlan;
    try {
      workflow = ensureFixedRosterWorkflow(input.roomId, task.title);
    } catch (error) {
      const blockedReason = toErrorMessage(error, 'locked roster could not be created');
      const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
        blocked_reason: blockedReason,
        error: blockedReason,
      });
      return {
        action: input.action,
        status: 'blocked',
        message_id: messageId,
        run_ids: [],
        blocked_reason: blockedReason,
      };
    }
    const stageResult = await runLockedRosterStagesSafely({
      roomId: input.roomId,
      taskId: input.taskId,
      workflow,
      sourceMessageId: task.source_message_id,
      runAgent: input.runAgent ?? defaultRunAgent,
    });
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, stageResult.status, {
      workflow,
      run_ids: stageResult.runIds,
      error: stageResult.error,
      blocked_reason: stageResult.status === 'blocked' ? stageResult.error : undefined,
    });
    return {
      action: input.action,
      status: stageResult.status,
      workflow,
      message_id: messageId,
      run_ids: stageResult.runIds,
      blocked_reason: stageResult.status === 'blocked' ? stageResult.error ?? undefined : undefined,
    };
  }

  if (input.action === 'route_skills') {
    return runSuperpowersRoutingAction({
      roomId: input.roomId,
      taskId: input.taskId,
      action: input.action,
      runAgent: input.runAgent ?? defaultRunAgent,
    });
  }

  if (input.action === 'auto_advance') {
    return runAutoAdvanceAction({
      roomId: input.roomId,
      taskId: input.taskId,
      runAgent: input.runAgent ?? defaultRunAgent,
    });
  }

  return runSuperpowersPhaseAction({
    roomId: input.roomId,
    taskId: input.taskId,
    action: input.action,
    runAgent: input.runAgent ?? defaultRunAgent,
  });
}

async function runSuperpowersRoutingAction(input: {
  roomId: string;
  taskId: string;
  action: TaskActionKind;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<TaskActionStartResult & { routing?: SuperpowersRouting }> {
  recordTaskActionEvent(input.roomId, input.taskId, input.action, 'running', {
    superpowers_phase: 'using_superpowers',
  });

  const context = buildTaskPromptContext(input.roomId, input.taskId, `任务动作入口：${input.action}`);
  let planner: RoomAgent;
  try {
    planner = selectOrAddPlanner(input.roomId);
  } catch (error) {
    const blockedReason = toErrorMessage(error, 'planner agent is not executable');
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
      superpowers_phase: 'using_superpowers',
      blocked_reason: blockedReason,
      error: blockedReason,
    });
    return {
      action: input.action,
      status: 'blocked',
      message_id: messageId,
      run_ids: [],
      blocked_reason: blockedReason,
    };
  }

  let result: TaskActionAgentResult;
  try {
    result = await input.runAgent({
      agent: planner,
      taskId: input.taskId,
      sourceMessageId: context.task.source_message_id,
      prompt: buildSuperpowersRoutingPrompt(context),
    });
  } catch (error) {
    const errorMessage = toErrorMessage(error, 'superpowers routing failed');
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'failed', {
      superpowers_phase: 'using_superpowers',
      error: errorMessage,
    });
    return {
      action: input.action,
      status: 'failed',
      message_id: messageId,
      run_ids: [],
    };
  }

  const runIds = result.runId ? [result.runId] : [];
  const parsed = parseSuperpowersRouting(result.content);
  if (parsed.ok) {
    const error = result.status === 'completed'
      ? undefined
      : result.error ?? `${input.action} 未完成：${result.status}`;
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'completed', {
      superpowers_phase: 'using_superpowers',
      run_id: result.runId,
      run_ids: runIds,
      error,
      superpowers_routing: parsed.routing,
    });
    return {
      action: input.action,
      status: 'completed',
      message_id: messageId,
      run_ids: runIds,
      routing: parsed.routing,
    };
  }

  if (result.status !== 'completed') {
    const error = result.error ?? `${input.action} 未完成：${result.status}`;
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'failed', {
      superpowers_phase: 'using_superpowers',
      run_id: result.runId,
      run_ids: runIds,
      error,
    });
    return {
      action: input.action,
      status: 'failed',
      message_id: messageId,
      run_ids: runIds,
    };
  }

  if (!parsed.ok) {
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
      superpowers_phase: 'using_superpowers',
      run_id: result.runId,
      run_ids: runIds,
      blocked_reason: parsed.error,
      error: parsed.error,
    });
    return {
      action: input.action,
      status: 'blocked',
      message_id: messageId,
      run_ids: runIds,
      blocked_reason: parsed.error,
    };
  }

  throw new Error('unreachable routing parse state');
}

async function runAutoAdvanceAction(input: {
  roomId: string;
  taskId: string;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<TaskActionStartResult> {
  recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', 'running', {});

  const routingResult = recoverLatestFailedRoutingResult(input.roomId, input.taskId) ??
    await runSuperpowersRoutingAction({
      roomId: input.roomId,
      taskId: input.taskId,
      action: 'route_skills',
      runAgent: input.runAgent,
    });
  if (routingResult.status !== 'completed' || !routingResult.routing) {
    const status = toTerminalTaskActionStatus(routingResult.status);
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', status, {
      run_ids: routingResult.run_ids,
      blocked_reason: status === 'blocked' ? routingResult.blocked_reason : undefined,
      error: status === 'failed' ? routingResult.blocked_reason ?? 'Superpowers 路由未完成' : undefined,
    });
    return {
      action: 'auto_advance',
      status,
      message_id: messageId,
      run_ids: routingResult.run_ids,
      blocked_reason: routingResult.blocked_reason,
    };
  }

  const targetAction = chooseAutoAdvanceTarget(input.taskId, routingResult.routing);
  if (!targetAction) {
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', 'blocked', {
      run_ids: routingResult.run_ids,
      superpowers_routing: routingResult.routing,
      blocked_reason: routingResult.routing.reason,
    });
    return {
      action: 'auto_advance',
      status: 'blocked',
      message_id: messageId,
      run_ids: routingResult.run_ids,
      blocked_reason: routingResult.routing.reason,
    };
  }

  let phaseAgent: RoomAgent;
  try {
    phaseAgent = selectPhaseAgentForRouting(input.roomId, targetAction, routingResult.routing);
  } catch (error) {
    const blockedReason = toErrorMessage(error, 'recommended phase agent is not executable');
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', 'blocked', {
      run_ids: routingResult.run_ids,
      delegated_action: targetAction,
      superpowers_routing: routingResult.routing,
      blocked_reason: blockedReason,
      error: blockedReason,
    });
    return {
      action: 'auto_advance',
      status: 'blocked',
      message_id: messageId,
      run_ids: routingResult.run_ids,
      blocked_reason: blockedReason,
    };
  }

  const phaseResult = await runSuperpowersPhaseAction({
    roomId: input.roomId,
    taskId: input.taskId,
    action: targetAction,
    agent: phaseAgent,
    skipPlanningPrerequisite: isPlanningSkipExecutionRouting(routingResult.routing),
    runAgent: input.runAgent,
  });
  const runIds = [...routingResult.run_ids, ...phaseResult.run_ids];
  const status = toTerminalTaskActionStatus(phaseResult.status);
  const messageId = recordTaskActionEvent(input.roomId, input.taskId, 'auto_advance', status, {
    run_ids: runIds,
    delegated_action: targetAction,
    superpowers_routing: routingResult.routing,
    blocked_reason: phaseResult.blocked_reason,
  });
  return {
    action: 'auto_advance',
    status,
    message_id: messageId,
    run_ids: runIds,
    blocked_reason: phaseResult.blocked_reason,
  };
}

function recoverLatestFailedRoutingResult(
  roomId: string,
  taskId: string,
): (TaskActionStartResult & { routing: SuperpowersRouting }) | null {
  const latestTerminalEvent = [...taskEventRepo.listByTask(taskId, { layer: 'timeline', limit: 50 })]
    .reverse()
    .find((event) => {
      const action = getTaskActionKind(event.payload.task_action ?? event.payload.action);
      if (!action) return false;
      const status = event.payload.task_action_status ?? event.payload.status;
      return status !== 'queued' && status !== 'running';
    });
  if (!latestTerminalEvent) return null;
  const action = getTaskActionKind(latestTerminalEvent.payload.task_action ?? latestTerminalEvent.payload.action);
  if (action !== 'auto_advance' && action !== 'route_skills') return null;
  const status = latestTerminalEvent.payload.task_action_status ?? latestTerminalEvent.payload.status;
  if (status !== 'failed') return null;

  const runId = extractRunId(latestTerminalEvent.payload);
  if (!runId) return null;
  const run = agentRunRepo.get(runId);
  if (!run || run.task_id !== taskId) return null;
  const parsed = parseSuperpowersRouting(run.stdout);
  if (!parsed.ok) return null;

  const runIds = [run.id];
  const messageId = recordTaskActionEvent(roomId, taskId, 'route_skills', 'completed', {
    superpowers_phase: 'using_superpowers',
    run_id: run.id,
    run_ids: runIds,
    recovered_from_run_id: run.id,
    error: run.error ?? undefined,
    superpowers_routing: parsed.routing,
  });
  return {
    action: 'route_skills',
    status: 'completed',
    message_id: messageId,
    run_ids: runIds,
    routing: parsed.routing,
  };
}

function getTaskActionKind(value: unknown): TaskActionKind | null {
  return typeof value === 'string' && TASK_ACTION_KINDS.includes(value as TaskActionKind)
    ? value as TaskActionKind
    : null;
}

function extractRunId(payload: Record<string, unknown>): string | null {
  if (typeof payload.run_id === 'string' && payload.run_id.trim()) return payload.run_id;
  if (Array.isArray(payload.run_ids)) {
    const runId = payload.run_ids.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return runId ?? null;
  }
  return null;
}

async function runSuperpowersPhaseAction(input: {
  roomId: string;
  taskId: string;
  action: TaskActionKind;
  agent?: RoomAgent;
  skipPlanningPrerequisite?: boolean;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<TaskActionStartResult> {
  const phase = actionToPhase(input.action);
  if (!phase) throw new Error(`unsupported action: ${input.action}`);

  recordTaskActionEvent(input.roomId, input.taskId, input.action, 'running', { superpowers_phase: phase });
  const prerequisiteError = validatePhasePrerequisite(input.action, input.taskId, {
    skipPlanningPrerequisite: input.skipPlanningPrerequisite === true,
  });
  if (prerequisiteError) {
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
      superpowers_phase: phase,
      blocked_reason: prerequisiteError,
      error: prerequisiteError,
    });
    return {
      action: input.action,
      status: 'blocked',
      message_id: messageId,
      run_ids: [],
      blocked_reason: prerequisiteError,
    };
  }

  const task = taskRepo.get(input.taskId);
  if (!task || task.room_id !== input.roomId) throw new Error('task not found');
  const room = roomRepo.get(input.roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');

  let phaseAgent: RoomAgent;
  try {
    phaseAgent = input.agent ?? selectDefaultPhaseAgent(input.roomId, task, input.action);
  } catch (error) {
    const blockedReason = toErrorMessage(error, 'phase agent is not executable');
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'blocked', {
      superpowers_phase: phase,
      blocked_reason: blockedReason,
      error: blockedReason,
    });
    return {
      action: input.action,
      status: 'blocked',
      message_id: messageId,
      run_ids: [],
      blocked_reason: blockedReason,
    };
  }
  const agents = roomAgentRepo.listByRoom(input.roomId);
  const prompt = buildSuperpowersPhasePrompt(phase, {
    projectName: project.name,
    projectPath: project.path,
    room,
    task,
    agents,
    workflowContext: `任务动作入口：${input.action}`,
  });

  let result: TaskActionAgentResult;
  try {
    result = await input.runAgent({
      agent: phaseAgent,
      taskId: input.taskId,
      sourceMessageId: task.source_message_id,
      prompt,
    });
  } catch (error) {
    const errorMessage = toErrorMessage(error, 'superpowers phase failed');
    const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, 'failed', {
      superpowers_phase: phase,
      error: errorMessage,
    });
    return {
      action: input.action,
      status: 'failed',
      message_id: messageId,
      run_ids: [],
    };
  }

  const evidence = extractSuperpowersEvidence(result.content);
  const evidenceError = result.status === 'completed'
    ? validateCompletedPhaseEvidence(phase, evidence, project.path)
    : null;
  const nonCompletedError = result.status === 'completed'
    ? null
    : result.error ?? `${phase} 阶段未完成：${result.status}`;
  const status = result.status === 'completed' && !evidenceError ? 'completed' : 'failed';
  const error = evidenceError ?? nonCompletedError;
  const messageId = recordTaskActionEvent(input.roomId, input.taskId, input.action, status, {
    superpowers_phase: phase,
    run_id: result.runId,
    run_ids: result.runId ? [result.runId] : [],
    error,
    evidence,
  });
  return {
    action: input.action,
    status,
    message_id: messageId,
    run_ids: result.runId ? [result.runId] : [],
  };
}

function actionToPhase(action: TaskActionKind): SuperpowersRuntimePhase | null {
  if (action === 'brainstorming') return 'brainstorming';
  if (action === 'writing_plans') return 'writing_plans';
  if (action === 'subagent_execution') return 'tdd_execute';
  if (action === 'systematic_debugging') return 'systematic_debugging';
  if (action === 'verification') return 'verify';
  if (action === 'finish_branch') return 'finish_branch';
  return null;
}

function validatePhasePrerequisite(
  action: TaskActionKind,
  taskId: string,
  options?: { skipPlanningPrerequisite?: boolean },
): string | null {
  if (options?.skipPlanningPrerequisite) return null;
  if (action === 'writing_plans') {
    const error = validateCompletedArtifactEvidence(taskId, 'brainstorming', 'designDocPath', 'spec');
    if (error) return error;
  }
  if (
    (action === 'subagent_execution' ||
      action === 'systematic_debugging' ||
      action === 'verification' ||
      action === 'finish_branch')
  ) {
    const error = validateCompletedArtifactEvidence(taskId, 'writing_plans', 'implementationPlanPath', 'implementation plan');
    if (error) return error;
  }
  return null;
}

function chooseAutoAdvanceTarget(taskId: string, routing: SuperpowersRouting): TaskActionKind | null {
  if (isPlanningSkipExecutionRouting(routing)) return routingActionToTaskAction(routing.next_action);
  if (validateCompletedArtifactEvidence(taskId, 'brainstorming', 'designDocPath', 'spec')) return 'brainstorming';
  if (validateCompletedArtifactEvidence(taskId, 'writing_plans', 'implementationPlanPath', 'implementation plan')) return 'writing_plans';
  return routingActionToTaskAction(routing.next_action);
}

function isPlanningSkipExecutionRouting(routing: SuperpowersRouting): boolean {
  return routing.planning_required === false && routing.next_action === 'subagent_execution';
}

function selectPhaseAgentForRouting(
  roomId: string,
  action: TaskActionKind,
  routing: SuperpowersRouting,
): RoomAgent {
  if (action === 'brainstorming' || action === 'writing_plans') return selectOrAddPlanner(roomId);
  return selectOrAddExecutableAgentByAgentId(roomId, routing.recommended_agent_id);
}

function selectDefaultPhaseAgent(roomId: string, task: Task, action: TaskActionKind): RoomAgent {
  if (action === 'brainstorming' || action === 'writing_plans') return selectOrAddPlanner(roomId);

  if (action === 'subagent_execution' || action === 'systematic_debugging') {
    ensureBuiltInPhaseAgent(roomId, 'backend-executor');
    ensureBuiltInPhaseAgent(roomId, 'frontend-executor');
    const executor = resolveWorkflowExecutor(roomAgentRepo.listByRoom(roomId), task);
    if (executor) return executor;
    throw new Error('no executable executor agent available');
  }

  if (action === 'verification' || action === 'finish_branch') {
    ensureBuiltInPhaseAgent(roomId, 'reviewer');
    ensureBuiltInPhaseAgent(roomId, 'acceptor');
    const agents = roomAgentRepo.listByRoom(roomId);
    const reviewer = selectWorkflowAgentForRole('reviewer', agents, { task }) ??
      selectWorkflowAgentForRole('acceptor', agents, { task });
    if (reviewer) return reviewer;
    throw new Error('no executable review agent available');
  }

  return selectOrAddPlanner(roomId);
}

function selectOrAddExecutableAgentByAgentId(roomId: string, agentId: string): RoomAgent {
  const normalizedAgentId = agentId.trim();
  const existing = roomAgentRepo.listByRoom(roomId).find((agent) =>
    (agent.id === normalizedAgentId || agent.agent_id === normalizedAgentId) &&
    isExecutableAgent(agent)
  );
  if (existing) return existing;

  const globalAgent = agentRepo.getByAgentId(normalizedAgentId);
  if (!globalAgent) throw new Error(`recommended agent not found: ${normalizedAgentId}`);
  const added = globalAgent.builtin_key
    ? roomAgentRepo.ensureBuiltInAgent(roomId, globalAgent.builtin_key)
    : roomAgentRepo.addFromGlobalAgent({ room_id: roomId, global_agent_id: globalAgent.id });
  if (!isExecutableAgent(added)) throw new Error(`recommended agent is not executable: ${normalizedAgentId}`);
  return added;
}

function ensureBuiltInPhaseAgent(roomId: string, agentId: string): void {
  try {
    roomAgentRepo.ensureBuiltInAgent(roomId, agentId);
  } catch {
    // Optional built-ins are best-effort; caller still validates executable candidates.
  }
}

function buildTaskPromptContext(roomId: string, taskId: string, workflowContextValue: string) {
  const task = taskRepo.get(taskId);
  if (!task || task.room_id !== roomId) throw new Error('task not found');
  const room = roomRepo.get(roomId);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');
  const agents = roomAgentRepo.listByRoom(roomId);
  return {
    projectName: project.name,
    projectPath: project.path,
    room,
    task,
    agents,
    workflowContext: workflowContextValue,
  };
}

function validateCompletedArtifactEvidence(
  taskId: string,
  action: TaskActionKind,
  evidenceKey: 'designDocPath' | 'implementationPlanPath',
  label: 'spec' | 'implementation plan',
): string | null {
  const artifactPath = taskEventRepo.findCompletedTaskActionEvidence({
    taskId,
    action,
    evidenceKey,
  });
  if (!artifactPath) {
    return label === 'spec'
      ? '缺少头脑风暴产出的 spec，请先运行头脑风暴'
      : '缺少编写计划产出的 implementation plan，请先运行编写计划';
  }
  const task = taskRepo.get(taskId);
  if (!task) return 'task not found';
  const project = projectRepo.get(task.project_id);
  if (!project) return 'project not found';
  return validateArtifactPath(project.path, artifactPath, label);
}

function findActiveTaskRunBlock(taskId: string): { id: string } | null {
  const activeRun = agentRunRepo.listActive().find((run) => run.task_id === taskId);
  return activeRun ? { id: activeRun.id } : null;
}

function findRunningTaskActionBlock(taskId: string, action: TaskActionKind): boolean {
  const latest = [...taskEventRepo.listByTask(taskId, { layer: 'timeline', limit: 50 })]
    .reverse()
    .find((event) => event.payload.task_action === action || event.payload.action === action);
  const status = latest?.payload.task_action_status ?? latest?.payload.status;
  return status === 'queued' || status === 'running';
}

function selectOrAddPlanner(roomId: string): RoomAgent {
  const existing = roomAgentRepo.listByRoom(roomId).find((agent) =>
    agent.agent_id === 'planner' &&
    Boolean(agent.acp_enabled) &&
    Boolean(agent.acp_backend)
  );
  if (existing) return existing;
  const globalAgent = agentRepo.getByAgentId('planner') ?? agentRepo.getByBuiltinKey('planner');
  if (!globalAgent) throw new Error('no planner agent available');
  const added = globalAgent.builtin_key
    ? roomAgentRepo.ensureBuiltInAgent(roomId, globalAgent.builtin_key)
    : roomAgentRepo.addFromGlobalAgent({ room_id: roomId, global_agent_id: globalAgent.id });
  if (!added.acp_enabled || !added.acp_backend) throw new Error('no executable planner agent available');
  return added;
}

function extractSuperpowersEvidence(content: string): Record<string, unknown> | null {
  const jsonBlocks = content.matchAll(/```json\s*([\s\S]*?)```/gu);
  for (const match of jsonBlocks) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const superpowers = (parsed as { superpowers?: unknown }).superpowers;
      if (superpowers && typeof superpowers === 'object' && !Array.isArray(superpowers)) {
        return superpowers as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function validateCompletedPhaseEvidence(
  phase: SuperpowersRuntimePhase,
  evidence: Record<string, unknown> | null,
  projectPath: string,
): string | null {
  if (!evidence) return `缺少 ${phase} 阶段的 superpowers evidence`;
  if (phase === 'brainstorming') {
    if (typeof evidence.designDocPath !== 'string' || evidence.designDocPath.trim().length === 0) {
      return '缺少 brainstorming 阶段产出的 designDocPath';
    }
    return validateArtifactPath(projectPath, evidence.designDocPath, 'spec');
  }
  if (phase === 'writing_plans') {
    if (typeof evidence.implementationPlanPath !== 'string' || evidence.implementationPlanPath.trim().length === 0) {
      return '缺少 writing_plans 阶段产出的 implementationPlanPath';
    }
    return validateArtifactPath(projectPath, evidence.implementationPlanPath, 'implementation plan');
  }
  if (phase === 'tdd_execute') {
    return hasValidTddEvidence(evidence.tddEvidence) || hasValidTddExemption(evidence.tddExemption)
      ? null
      : '缺少 tdd_execute 阶段产出的 RED/GREEN tddEvidence 或有效 tddExemption';
  }
  return null;
}

function validateArtifactPath(
  projectPath: string,
  artifactPath: string,
  label: 'spec' | 'implementation plan',
): string | null {
  const resolvedProjectPath = resolve(projectPath);
  const resolvedArtifactPath = resolveArtifactPath(resolvedProjectPath, artifactPath);
  if (!resolvedArtifactPath || !isPathInside(resolvedArtifactPath, resolvedProjectPath)) {
    return `${label} 路径不在项目目录内：${artifactPath}`;
  }
  if (!existsSync(resolvedArtifactPath)) return `${label} 文件不存在：${artifactPath}`;
  try {
    if (!statSync(resolvedArtifactPath).isFile()) return `${label} 路径不是文件：${artifactPath}`;
  } catch {
    return `${label} 文件不可访问：${artifactPath}`;
  }
  return null;
}

function resolveArtifactPath(projectPath: string, artifactPath: string): string | null {
  const trimmed = artifactPath.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectPath, trimmed);
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);
}

function hasValidTddEvidence(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const hasRed = value.some((item) =>
    isRecord(item) &&
    item.stage === 'RED' &&
    item.passed === false
  );
  const hasGreen = value.some((item) =>
    isRecord(item) &&
    item.stage === 'GREEN' &&
    item.passed === true
  );
  return hasRed && hasGreen;
}

function hasValidTddExemption(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const createdAt = value.createdAt;
  return isNonEmptyString(value.reason) &&
    isNonEmptyString(value.approvedBy) &&
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    createdAt > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toTerminalTaskActionStatus(
  status: Exclude<TaskActionStartResult['status'], 'idle'>,
): Exclude<TaskActionStartResult['status'], 'idle' | 'queued'> {
  return status === 'queued' ? 'running' : status;
}

function ensureFixedRosterWorkflow(roomId: string, taskTitle: string): TaskWorkflowPlan {
  const executor = selectOrAddAgentByRole(roomId, 'executor');
  const reviewer = selectOrAddAgentByRole(roomId, 'reviewer');
  const acceptor = selectOrAddAgentByRole(roomId, 'acceptor');
  return {
    mode: 'fixed_roster',
    entry_action: 'start_execution',
    locked: true,
    agents: [
      { agent_id: executor.agent_id, room_agent_id: executor.id, role: 'executor' },
      { agent_id: reviewer.agent_id, room_agent_id: reviewer.id, role: 'reviewer' },
      { agent_id: acceptor.agent_id, room_agent_id: acceptor.id, role: 'acceptor' },
    ],
    stages: [
      { id: 'execute', agent_ids: [executor.agent_id], parallel: false, goal: `实现任务：${taskTitle}` },
      { id: 'review', agent_ids: [reviewer.agent_id], parallel: false, goal: `审查任务实现：${taskTitle}` },
      { id: 'acceptance', agent_ids: [acceptor.agent_id], parallel: false, goal: `验收任务结果：${taskTitle}` },
    ],
  };
}

async function defaultRunAgent(input: TaskActionRunAgentInput): Promise<TaskActionAgentResult> {
  const room = roomRepo.get(input.agent.room_id);
  if (!room) throw new Error('room not found');
  const project = projectRepo.get(room.project_id);
  if (!project) throw new Error('project not found');

  let finalRunId: string | undefined;
  let finalMessageId: string | undefined;
  let finalStatus: AgentRunStatus | 'failed' = 'failed';
  let finalContent = '';
  let finalError: string | null = null;

  await respondAsAgent({
    agent: input.agent,
    projectPath: project.path,
    roomId: room.id,
    prompt: input.prompt,
    taskId: input.taskId,
    sourceMessageId: input.sourceMessageId,
    onFinished: ({ run, message, status }) => {
      finalRunId = run.id;
      finalMessageId = message.id;
      finalStatus = status;
      finalContent = message.content;
      finalError = run.error;
    },
  });

  return {
    status: finalStatus,
    content: finalContent,
    error: finalError,
    runId: finalRunId,
    messageId: finalMessageId,
  };
}

async function runLockedRosterStages(input: {
  roomId: string;
  taskId: string;
  workflow: TaskWorkflowPlan;
  sourceMessageId?: string | null;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<{ status: 'completed' | 'failed' | 'blocked'; runIds: string[]; error: string | null }> {
  const runIds: string[] = [];
  const outputs: string[] = [];

  for (const stage of input.workflow.stages) {
    for (const agentId of stage.agent_ids) {
      const lockedAgent = input.workflow.agents.find((candidate) => candidate.agent_id === agentId);
      if (!lockedAgent) return { status: 'blocked', runIds, error: `locked roster agent missing: ${agentId}` };
      const agent = roomAgentRepo.get(lockedAgent.room_agent_id);
      if (!agent || agent.room_id !== input.roomId || agent.left_at !== null) {
        return { status: 'blocked', runIds, error: `locked roster agent unavailable: ${agentId}` };
      }
      if (agent.agent_id !== lockedAgent.agent_id || !agent.acp_enabled || !agent.acp_backend) {
        return { status: 'blocked', runIds, error: `locked roster agent not executable: ${agentId}` };
      }
      let result: TaskActionAgentResult;
      try {
        result = await input.runAgent({
          agent,
          taskId: input.taskId,
          sourceMessageId: input.sourceMessageId,
          prompt: buildLockedStagePrompt(stage.id, stage.goal, outputs),
        });
      } catch (error) {
        return {
          status: 'failed',
          runIds,
          error: error instanceof Error ? error.message : `${agent.agent_id} failed`,
        };
      }
      if (result.runId) runIds.push(result.runId);
      outputs.push(`${agent.agent_id}: ${result.content}`);
      if (result.status !== 'completed') {
        return { status: 'failed', runIds, error: result.error ?? `${agent.agent_id} failed` };
      }
    }
  }

  return { status: 'completed', runIds, error: null };
}

function buildLockedStagePrompt(stageId: string, goal: string, previousOutputs: string[]): string {
  return [
    `固定编队阶段：${stageId}`,
    `阶段目标：${goal}`,
    '本任务已锁定完整 roster。你不能要求新增智能体；如果发现缺人，说明阻塞原因，不要输出新增 agent 的 task_execution。',
    '',
    previousOutputs.length > 0 ? `前序阶段输出：\n${previousOutputs.join('\n\n')}` : '前序阶段输出：无',
  ].join('\n');
}

function selectOrAddAgentByRole(roomId: string, role: 'executor' | 'reviewer' | 'acceptor'): RoomAgent {
  const existing = roomAgentRepo.listByRoom(roomId).find((agent) =>
    agent.workflow_role === role &&
    Boolean(agent.acp_enabled) &&
    Boolean(agent.acp_backend)
  );
  if (existing) return existing;
  const fallbackId = role === 'executor' ? 'backend-executor' : role;
  const globalAgent = agentRepo.getByAgentId(fallbackId) ?? agentRepo.getByBuiltinKey(fallbackId);
  if (!globalAgent) throw new Error(`no ${role} agent available`);
  const added = globalAgent.builtin_key
    ? roomAgentRepo.ensureBuiltInAgent(roomId, globalAgent.builtin_key)
    : roomAgentRepo.addFromGlobalAgent({ room_id: roomId, global_agent_id: globalAgent.id });
  if (!added.acp_enabled || !added.acp_backend) throw new Error(`no executable ${role} agent available`);
  return added;
}

async function runLockedRosterStagesSafely(input: {
  roomId: string;
  taskId: string;
  workflow: TaskWorkflowPlan;
  sourceMessageId?: string | null;
  runAgent: (input: TaskActionRunAgentInput) => Promise<TaskActionAgentResult>;
}): Promise<{ status: 'completed' | 'failed' | 'blocked'; runIds: string[]; error: string | null }> {
  try {
    return await runLockedRosterStages(input);
  } catch (error) {
    return {
      status: 'failed',
      runIds: [],
      error: toErrorMessage(error, 'locked roster stage failed'),
    };
  }
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function recordTaskActionEvent(
  roomId: string,
  taskId: string,
  action: TaskActionKind,
  status: Exclude<TaskActionStartResult['status'], 'queued'>,
  metadata: Record<string, unknown>,
): string {
  const task = taskRepo.get(taskId);
  const content = `任务动作 ${action} 已进入 ${status}`;
  const message = messageRepo.create({
    room_id: roomId,
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content,
    message_type: 'system',
    layer: 'timeline',
    metadata: {
      task_id: taskId,
      event_type: 'task_updated',
      task_action: action,
      task_action_status: status,
      task_title: task?.title,
      ...metadata,
    },
  });
  wsHub.broadcast(roomId, { type: 'message:new', roomId, message });
  const event = taskEventRepo.create({
    room_id: roomId,
    task_id: taskId,
    type: 'task_updated',
    layer: 'timeline',
    payload: {
      action,
      status,
      task_action: action,
      task_action_status: status,
      message_id: message.id,
      event_message_id: message.id,
      content,
      task_title: task?.title,
      ...metadata,
    },
  });
  wsHub.broadcast(roomId, { type: 'task_event:new', roomId, event });
  return message.id;
}
