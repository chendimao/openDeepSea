import { settingsRepo } from '../repos/settings.js';
import { getSkillsMpBearerTokenFromEnv } from './client.js';
import type { OnlineSkillsTokenConfig, OnlineSkillsTokenSource } from './types.js';

export async function resolveSkillsMpBearerToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const storedToken = settingsRepo.getSkillsMpApiToken();
  if (storedToken) return storedToken;
  return getSkillsMpBearerTokenFromEnv(env);
}

export async function getOnlineSkillsTokenConfig(env: NodeJS.ProcessEnv = process.env): Promise<OnlineSkillsTokenConfig> {
  const storedToken = settingsRepo.getSkillsMpApiToken();
  const environmentToken = getSkillsMpBearerTokenFromEnv(env);
  const effectiveToken = storedToken ?? environmentToken;
  const source: OnlineSkillsTokenSource = storedToken ? 'settings' : environmentToken ? 'environment' : 'none';

  return {
    tokenConfigured: Boolean(effectiveToken),
    tokenPreview: previewToken(effectiveToken),
    source,
    storedTokenConfigured: Boolean(storedToken),
    storedTokenPreview: previewToken(storedToken),
    environmentTokenConfigured: Boolean(environmentToken),
    environmentTokenPreview: previewToken(environmentToken),
  };
}

export async function updateOnlineSkillsTokenConfig(
  token: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OnlineSkillsTokenConfig> {
  settingsRepo.updateSkillsMpApiToken(token);
  return getOnlineSkillsTokenConfig(env);
}

function previewToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
