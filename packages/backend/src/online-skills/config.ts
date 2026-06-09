import { getVercelOidcToken } from '@vercel/oidc';
import { settingsRepo } from '../repos/settings.js';
import { getSkillsShBearerTokenFromEnv } from './client.js';
import type { OnlineSkillsTokenConfig, OnlineSkillsTokenSource } from './types.js';

export type VercelOidcTokenProvider = () => Promise<string | null>;

const OIDC_EXPIRATION_BUFFER_MS = 5 * 60 * 1000;

export async function resolveSkillsShBearerToken(
  env: NodeJS.ProcessEnv = process.env,
  oidcTokenProvider: VercelOidcTokenProvider = getRuntimeVercelOidcToken,
): Promise<string | null> {
  const storedToken = settingsRepo.getSkillsShApiToken();
  if (storedToken) return storedToken;
  const environmentToken = getSkillsShBearerTokenFromEnv(env);
  if (environmentToken) return environmentToken;
  return await oidcTokenProvider();
}

export async function getOnlineSkillsTokenConfig(
  env: NodeJS.ProcessEnv = process.env,
  oidcTokenProvider: VercelOidcTokenProvider = getRuntimeVercelOidcToken,
): Promise<OnlineSkillsTokenConfig> {
  const storedToken = settingsRepo.getSkillsShApiToken();
  const environmentToken = getSkillsShBearerTokenFromEnv(env);
  const oidcToken = storedToken || environmentToken ? null : await oidcTokenProvider();
  const effectiveToken = storedToken ?? environmentToken ?? oidcToken;
  const source: OnlineSkillsTokenSource = storedToken
    ? 'settings'
    : environmentToken
      ? 'environment'
      : oidcToken
        ? 'vercel_oidc'
        : 'none';

  return {
    tokenConfigured: Boolean(effectiveToken),
    tokenPreview: previewToken(effectiveToken),
    source,
    storedTokenConfigured: Boolean(storedToken),
    storedTokenPreview: previewToken(storedToken),
    environmentTokenConfigured: Boolean(environmentToken),
    environmentTokenPreview: previewToken(environmentToken),
    vercelOidcTokenConfigured: Boolean(oidcToken),
    vercelOidcTokenPreview: previewToken(oidcToken),
  };
}

export async function updateOnlineSkillsTokenConfig(
  token: string | null,
  env: NodeJS.ProcessEnv = process.env,
  oidcTokenProvider: VercelOidcTokenProvider = getRuntimeVercelOidcToken,
): Promise<OnlineSkillsTokenConfig> {
  settingsRepo.updateSkillsShApiToken(token);
  return getOnlineSkillsTokenConfig(env, oidcTokenProvider);
}

async function getRuntimeVercelOidcToken(): Promise<string | null> {
  try {
    return await getVercelOidcToken({ expirationBufferMs: OIDC_EXPIRATION_BUFFER_MS });
  } catch {
    return null;
  }
}

function previewToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
