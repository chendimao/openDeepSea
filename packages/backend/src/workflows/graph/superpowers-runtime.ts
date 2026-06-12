import type { WorkflowDefinitionGraph, WorkflowDefinitionNodeType } from '../../types.js';
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
import { buildSuperpowersRouteDefinition } from './superpowers-route-compiler.js';
export {
  SUPERPOWERS_GRAPH_VERSION,
  SUPERPOWERS_RUNTIME_PROFILE,
  SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
} from './superpowers-runtime-constants.js';
import {
  SUPERPOWERS_GRAPH_VERSION,
  SUPERPOWERS_RUNTIME_PROFILE,
  SUPERPOWERS_WORKFLOW_DEFINITION_KEY,
} from './superpowers-runtime-constants.js';

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

const SUPERPOWERS_EXECUTABLE_DEFINITION: WorkflowDefinitionGraph = buildSuperpowersRouteDefinition();

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
