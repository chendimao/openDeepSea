export interface LangGraphWorkflowConfig {
  enabled: boolean;
  graphVersion: 'phase-b-v1';
}

export function getLangGraphWorkflowConfig(
  env: Partial<Pick<NodeJS.ProcessEnv, 'LANGGRAPH_WORKFLOW_ENABLED'>> = process.env,
): LangGraphWorkflowConfig {
  const flag = env.LANGGRAPH_WORKFLOW_ENABLED?.trim().toLowerCase();
  return {
    enabled: flag === undefined || flag === '' || flag === '1' || flag === 'true',
    graphVersion: 'phase-b-v1',
  };
}
