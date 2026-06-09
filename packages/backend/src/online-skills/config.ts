import { settingsRepo } from '../repos/settings.js';
import { getSkillsShBearerTokenFromEnv } from './client.js';
import type { OnlineSkillsTokenConfig, OnlineSkillsTokenSource } from './types.js';

export function resolveSkillsShBearerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return settingsRepo.getSkillsShApiToken() ?? getSkillsShBearerTokenFromEnv(env);
}

export function getOnlineSkillsTokenConfig(env: NodeJS.ProcessEnv = process.env): OnlineSkillsTokenConfig {
  const storedToken = settingsRepo.getSkillsShApiToken();
  const environmentToken = getSkillsShBearerTokenFromEnv(env);
  const effectiveToken = storedToken ?? environmentToken;
  const source: OnlineSkillsTokenSource = storedToken
    ? 'settings'
    : environmentToken
      ? 'environment'
      : 'none';

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

export function updateOnlineSkillsTokenConfig(
  token: string | null,
  env: NodeJS.ProcessEnv = process.env,
): OnlineSkillsTokenConfig {
  settingsRepo.updateSkillsShApiToken(token);
  return getOnlineSkillsTokenConfig(env);
}

function previewToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
