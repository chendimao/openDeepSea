export interface LangGraphWorkflowConfig {
  enabled: boolean;
  graphVersion: 'phase-b-v1';
}

export function getLangGraphWorkflowConfig(
  env: Partial<Pick<NodeJS.ProcessEnv, 'LANGGRAPH_WORKFLOW_ENABLED'>> = process.env,
): LangGraphWorkflowConfig {
  return {
    enabled: env.LANGGRAPH_WORKFLOW_ENABLED === '1' || env.LANGGRAPH_WORKFLOW_ENABLED === 'true',
    graphVersion: 'phase-b-v1',
  };
}
