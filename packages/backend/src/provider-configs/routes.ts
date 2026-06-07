import { Router } from 'express';
import { z } from 'zod';
import { providerConfigService } from './service.js';
import { isAcpProvider } from './types.js';

export const providerConfigRouter = Router();

const sourcePatchSchema = z.object({
  config_dir: z.string().trim().min(1).nullable().optional(),
  use_default_config_dir: z.boolean().optional(),
  auto_sync_enabled: z.boolean().optional(),
});

const nullableTrimmedStringSchema = z.union([z.string(), z.null()]).optional().transform((value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
});

const profileInputSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.enum(['claudecode', 'opencode', 'codex']),
  model: nullableTrimmedStringSchema,
  base_url: nullableTrimmedStringSchema,
  api_key: nullableTrimmedStringSchema,
  reasoning_effort: nullableTrimmedStringSchema,
  run_overrides_enabled: z.boolean().optional(),
  activate: z.boolean().optional(),
});

const profilePatchSchema = profileInputSchema.omit({ provider: true }).partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'at least one field is required' },
);

providerConfigRouter.get('/settings/provider-configs', (_req, res) => {
  res.json(providerConfigService.listProviderConfigs());
});

providerConfigRouter.patch('/settings/provider-configs/:provider/source', (req, res) => {
  if (!isAcpProvider(req.params.provider)) return res.status(400).json({ error: 'invalid provider' });
  const parsed = sourcePatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const source = providerConfigService.updateSource(req.params.provider, parsed.data);
    res.json(source);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid provider source' });
  }
});

providerConfigRouter.post('/settings/provider-configs/:provider/sync', async (req, res) => {
  if (!isAcpProvider(req.params.provider)) return res.status(400).json({ error: 'invalid provider' });
  res.json(await providerConfigService.syncProvider(req.params.provider));
});

providerConfigRouter.post('/settings/provider-configs/sync', async (_req, res) => {
  res.json(await providerConfigService.syncAll());
});

providerConfigRouter.post('/settings/provider-configs/:provider/import-profile', async (req, res) => {
  if (!isAcpProvider(req.params.provider)) return res.status(400).json({ error: 'invalid provider' });
  try {
    const profile = await providerConfigService.importProfileFromSnapshot(req.params.provider);
    if (!profile) return res.status(404).json({ error: 'snapshot not found' });
    res.status(201).json(profile);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid provider profile import' });
  }
});

providerConfigRouter.post('/settings/provider-profiles', (req, res) => {
  const parsed = profileInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const profile = providerConfigService.createProfile(parsed.data);
    res.status(201).json(profile);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid provider profile' });
  }
});

providerConfigRouter.patch('/settings/provider-profiles/:profileId', (req, res) => {
  const parsed = profilePatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const profile = providerConfigService.updateProfile(req.params.profileId, parsed.data);
    if (!profile) return res.status(404).json({ error: 'not found' });
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid provider profile' });
  }
});

providerConfigRouter.post('/settings/provider-profiles/:profileId/activate', (req, res) => {
  const profile = providerConfigService.activateProfile(req.params.profileId);
  if (!profile) return res.status(404).json({ error: 'not found' });
  res.json(profile);
});

providerConfigRouter.delete('/settings/provider-profiles/:profileId', (req, res) => {
  const deleted = providerConfigService.deleteProfile(req.params.profileId);
  if (!deleted) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});
