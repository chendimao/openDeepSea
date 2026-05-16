import { END } from '@langchain/langgraph';
import { taskRepo } from '../../repos/tasks.js';
import type { AgentWorkflowState } from './state.js';

export function routeAfterApproval(state: AgentWorkflowState): 'dispatch' | typeof END {
  if (state.approval === 'pending') return END;
  if (state.approval === 'rejected') return END;
  return 'dispatch';
}

export function routeAfterExecute(state: AgentWorkflowState): 'execute' | 'review' | typeof END {
  if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
  const hasRunnableChild = state.childTaskIds
    .map((id) => taskRepo.get(id))
    .some((task) => task?.status === 'todo' || task?.status === 'in_progress');
  if (hasRunnableChild) return 'execute';
  return 'review';
}

export function routeAfterReview(state: AgentWorkflowState): 'verify' | 'repair_decision' | typeof END {
  if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
  if (state.reviewVerdict === 'changes_requested') return 'repair_decision';
  return 'verify';
}

export function routeAfterRepairDecision(state: AgentWorkflowState): 'execute' | typeof END {
  if (state.status === 'blocked' || state.status === 'cancelled' || state.status === 'failed') return END;
  return 'execute';
}
