import { END } from '@langchain/langgraph';
import type { AgentWorkflowState } from './state.js';

export function routeAfterApproval(state: AgentWorkflowState): 'dispatch' | typeof END {
  if (state.approval === 'pending') return END;
  if (state.approval === 'rejected') return END;
  return 'dispatch';
}

export function routeAfterReview(state: AgentWorkflowState): 'verify' | 'repair_decision' | typeof END {
  if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
  if (state.error === 'Code review requested changes') return 'repair_decision';
  return 'verify';
}

export function routeAfterRepairDecision(state: AgentWorkflowState): 'execute' | typeof END {
  if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
  return 'execute';
}
