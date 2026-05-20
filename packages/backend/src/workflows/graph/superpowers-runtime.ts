import type { WorkflowDefinitionGraph, WorkflowDefinitionNodeType } from '../../types.js';
import type { GraphRuntimeDeps } from './tools.js';
import {
  SUPERPOWERS_PLANNING_PHASE_STEPS,
  canDispatchSuperpowersRuntime,
  createSuperpowersRuntimeNodes,
  type SuperpowersPhaseStep,
  type SuperpowersRuntimeNodes,
} from './superpowers-nodes.js';
import type { AgentWorkflowState } from './state.js';

export const SUPERPOWERS_WORKFLOW_DEFINITION_KEY = 'superpowers-development';
export const SUPERPOWERS_RUNTIME_PROFILE = 'superpowers';
export const SUPERPOWERS_GRAPH_VERSION = 'superpowers-v1';

export const SUPERPOWERS_PLACEHOLDER_NODE_TYPES = [
  'brainstorming',
  'spec_review',
  'worktree',
  'writing_plans',
  'plan_review',
  'tdd_execute',
  'spec_compliance_review',
  'code_quality_review',
  'finish_branch',
] as const satisfies readonly WorkflowDefinitionNodeType[];

const SUPERPOWERS_PLACEHOLDER_EXECUTABLE_DEFINITION: WorkflowDefinitionGraph = {
  metadata: {
    runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
    gate_policy: SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
  },
  nodes: [
    { id: 'context', type: 'context', label: '上下文', stage: 'analysis' },
    { id: 'planning', type: 'planning', label: 'Superpowers 占位规划', stage: 'planning', role: 'planner' },
    { id: 'approval', type: 'approval_gate', label: '审批', stage: 'planning' },
    { id: 'dispatch', type: 'dispatch', label: '派发', stage: 'assignment', role: 'coordinator' },
    { id: 'execute', type: 'execute', label: 'Superpowers 占位执行', stage: 'implementation', role: 'executor' },
    { id: 'review', type: 'review', label: 'Superpowers 占位审查', stage: 'code_review', role: 'reviewer' },
    { id: 'repair_decision', type: 'repair_decision', label: '修复决策', stage: 'assignment', role: 'coordinator' },
    { id: 'verify', type: 'verify', label: '验证', stage: 'code_review' },
    { id: 'acceptance', type: 'acceptance', label: '验收', stage: 'acceptance', role: 'acceptor' },
    { id: 'memory', type: 'memory', label: '记忆', stage: 'acceptance' },
  ],
  edges: [
    { from: 'context', to: 'planning' },
    { from: 'planning', to: 'approval' },
    { from: 'approval', to: 'dispatch', condition: 'approved' },
    { from: 'dispatch', to: 'execute' },
    { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
    { from: 'execute', to: 'review', condition: 'done' },
    { from: 'review', to: 'repair_decision', condition: 'changes_requested' },
    { from: 'review', to: 'verify', condition: 'pass' },
    { from: 'repair_decision', to: 'execute' },
    { from: 'verify', to: 'acceptance' },
    { from: 'acceptance', to: 'memory', condition: 'completed' },
  ],
};

export interface SuperpowersRuntimeGraph {
  graphVersion: typeof SUPERPOWERS_GRAPH_VERSION;
  runtimeProfile: typeof SUPERPOWERS_RUNTIME_PROFILE;
  placeholderNodeTypes: readonly WorkflowDefinitionNodeType[];
  phaseSteps: readonly SuperpowersPhaseStep[];
  nodes: SuperpowersRuntimeNodes;
  canDispatch: (state: AgentWorkflowState) => boolean;
  executableDefinition: WorkflowDefinitionGraph;
}

export function buildSuperpowersRuntimeGraph(_deps: GraphRuntimeDeps = {}): SuperpowersRuntimeGraph {
  return {
    graphVersion: SUPERPOWERS_GRAPH_VERSION,
    runtimeProfile: SUPERPOWERS_RUNTIME_PROFILE,
    placeholderNodeTypes: SUPERPOWERS_PLACEHOLDER_NODE_TYPES,
    phaseSteps: SUPERPOWERS_PLANNING_PHASE_STEPS,
    nodes: createSuperpowersRuntimeNodes(),
    canDispatch: canDispatchSuperpowersRuntime,
    executableDefinition: SUPERPOWERS_PLACEHOLDER_EXECUTABLE_DEFINITION,
  };
}

export function isSuperpowersDefinitionGraph(definition: WorkflowDefinitionGraph | null | undefined): boolean {
  return definition?.metadata?.runtime_profile === SUPERPOWERS_RUNTIME_PROFILE
    || definition?.metadata?.gate_policy === SUPERPOWERS_WORKFLOW_DEFINITION_KEY
    || definition?.nodes.some((node) => node.type === 'tdd_execute') === true;
}
