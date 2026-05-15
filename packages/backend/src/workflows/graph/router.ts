import { END } from '@langchain/langgraph';
import type { AgentWorkflowState } from './state.js';

export function routeAfterApproval(state: AgentWorkflowState): 'dispatch' | typeof END {
  if (state.approval === 'pending') return END;
  if (state.approval === 'rejected') return END;
  return 'dispatch';
}
