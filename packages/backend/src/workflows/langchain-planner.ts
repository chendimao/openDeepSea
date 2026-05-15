export interface LangChainPlannerConfig {
  enabled: boolean;
  model: string | null;
}

export function getLangChainPlannerConfig(
  env: Partial<Pick<NodeJS.ProcessEnv, 'LANGCHAIN_PLANNER_MODEL' | 'OPENAI_API_KEY'>> = process.env,
): LangChainPlannerConfig {
  const model = env.LANGCHAIN_PLANNER_MODEL?.trim() || '';
  const hasApiKey = Boolean(env.OPENAI_API_KEY?.trim());
  return {
    enabled: Boolean(model && hasApiKey),
    model: model || null,
  };
}
