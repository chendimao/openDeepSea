import type { WorkflowDefinitionGraph, WorkflowDefinitionNode, WorkflowDefinitionNodeType } from '../../types.js';
import {
  SUPERPOWERS_PLANNING_PHASE_STEPS,
  canDispatchSuperpowersRuntime,
  createSuperpowersRuntimeNodes,
  type SuperpowersPhaseStep,
  type SuperpowersRuntimeNodes,
} from './superpowers-nodes.js';
import { canLeaveTddExecute, canLeaveVerify } from './superpowers-gates.js';
import type { AgentWorkflowState } from './state.js';
import { createGraphTools, type GraphRuntimeDeps } from './tools.js';

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

const SUPERPOWERS_EXECUTABLE_DEFINITION: WorkflowDefinitionGraph = {
  metadata: {
    runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
    gate_policy: SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
  },
  nodes: [
    { id: 'context', type: 'context', label: '上下文', stage: 'analysis' },
    ...SUPERPOWERS_PLANNING_PHASE_STEPS.map(createSuperpowersPhaseDefinitionNode),
    { id: 'approval', type: 'approval_gate', label: '审批', stage: 'planning' },
    { id: 'dispatch', type: 'dispatch', label: '派发', stage: 'assignment', role: 'coordinator' },
    { id: 'tdd_execute', type: 'tdd_execute', label: 'TDD 执行', stage: 'implementation', role: 'executor' },
    { id: 'spec_compliance_review', type: 'spec_compliance_review', label: '规格符合审查', stage: 'code_review', role: 'reviewer' },
    { id: 'code_quality_review', type: 'code_quality_review', label: '代码质量审查', stage: 'code_review', role: 'reviewer' },
    { id: 'verify', type: 'verify', label: '验证', stage: 'code_review' },
    { id: 'finish_branch', type: 'finish_branch', label: '分支收口', stage: 'acceptance', role: 'coordinator' },
    { id: 'acceptance', type: 'acceptance', label: '验收', stage: 'acceptance', role: 'acceptor' },
    { id: 'memory', type: 'memory', label: '记忆', stage: 'acceptance' },
  ],
  edges: [
    { from: 'context', to: 'brainstorming' },
    { from: 'brainstorming', to: 'spec_review' },
    { from: 'spec_review', to: 'worktree' },
    { from: 'worktree', to: 'writing_plans' },
    { from: 'writing_plans', to: 'plan_review' },
    { from: 'plan_review', to: 'approval' },
    { from: 'approval', to: 'dispatch', condition: 'approved' },
    { from: 'dispatch', to: 'tdd_execute' },
    { from: 'tdd_execute', to: 'tdd_execute', condition: 'has_runnable_child' },
    { from: 'tdd_execute', to: 'spec_compliance_review', condition: 'done' },
    { from: 'spec_compliance_review', to: 'tdd_execute', condition: 'changes_requested' },
    { from: 'spec_compliance_review', to: 'code_quality_review', condition: 'pass' },
    { from: 'code_quality_review', to: 'tdd_execute', condition: 'changes_requested' },
    { from: 'code_quality_review', to: 'verify', condition: 'pass' },
    { from: 'verify', to: 'finish_branch' },
    { from: 'finish_branch', to: 'acceptance', condition: 'completed' },
    { from: 'acceptance', to: 'memory', condition: 'completed' },
  ],
};

function createSuperpowersPhaseDefinitionNode(step: SuperpowersPhaseStep): WorkflowDefinitionNode {
  return {
    id: step.nodeName,
    type: step.nodeType,
    label: step.label,
    stage: step.stage,
    role: step.role,
    metadata: step.gate
      ? {
        runtime_profile: SUPERPOWERS_RUNTIME_PROFILE,
        gate_policy: step.gate,
      }
      : { runtime_profile: SUPERPOWERS_RUNTIME_PROFILE },
  };
}

export interface SuperpowersRuntimeGraph {
  graphVersion: typeof SUPERPOWERS_GRAPH_VERSION;
  runtimeProfile: typeof SUPERPOWERS_RUNTIME_PROFILE;
  placeholderNodeTypes: readonly WorkflowDefinitionNodeType[];
  phaseSteps: readonly SuperpowersPhaseStep[];
  nodes: SuperpowersRuntimeNodes;
  canDispatch: (state: AgentWorkflowState) => boolean;
  canLeaveTddExecute: (state: AgentWorkflowState) => boolean;
  canLeaveVerify: (state: AgentWorkflowState) => boolean;
  executableDefinition: WorkflowDefinitionGraph;
}

export function buildSuperpowersRuntimeGraph(
  deps: GraphRuntimeDeps = {},
  tools?: ReturnType<typeof createGraphTools>,
): SuperpowersRuntimeGraph {
  const runtimeTools = tools ?? (Object.keys(deps).length > 0 ? createGraphTools(deps) : undefined);

  return {
    graphVersion: SUPERPOWERS_GRAPH_VERSION,
    runtimeProfile: SUPERPOWERS_RUNTIME_PROFILE,
    placeholderNodeTypes: SUPERPOWERS_PLACEHOLDER_NODE_TYPES,
    phaseSteps: SUPERPOWERS_PLANNING_PHASE_STEPS,
    nodes: createSuperpowersRuntimeNodes(runtimeTools),
    canDispatch: canDispatchSuperpowersRuntime,
    canLeaveTddExecute,
    canLeaveVerify,
    executableDefinition: SUPERPOWERS_EXECUTABLE_DEFINITION,
  };
}

export function isSuperpowersDefinitionGraph(definition: WorkflowDefinitionGraph | null | undefined): boolean {
  return definition?.metadata?.runtime_profile === SUPERPOWERS_RUNTIME_PROFILE
    || definition?.metadata?.gate_policy === SUPERPOWERS_WORKFLOW_DEFINITION_KEY
    || definition?.nodes.some((node) => node.type === 'tdd_execute') === true;
}
