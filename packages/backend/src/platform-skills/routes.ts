import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateLocalAccess } from '../local-access.js';
import { writeSkillsShPackage } from '../skills/installer-runner.js';
import { SkillsShClient } from '../skills/skills-sh-client.js';
import {
  assertCanInstallDirectoryToPlatforms,
  getPlatformSkill,
  installDirectoryToPlatforms,
  listPlatformSkills,
  listPlatformSummaries,
  removePlatformSkill,
} from './service.js';
import type { PlatformSkillProvider } from './types.js';

export const platformSkillsRouter = Router();
platformSkillsRouter.use((req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  next();
});

const providerSchema = z.enum(['codex', 'claudecode', 'opencode']);
const installModeSchema = z.enum(['copy', 'symlink']);
const querySchema = z.object({ q: z.string().optional() });
const installSchema = z.object({
  installLabel: z.string().min(1),
  targets: z.array(providerSchema).min(1),
  installMode: installModeSchema.default('copy'),
});
const importLocalSchema = z.object({
  path: z.string().min(1),
  targets: z.array(providerSchema).min(1),
  installMode: installModeSchema.default('copy'),
});

platformSkillsRouter.get('/platforms', async (_req, res) => {
  res.json(await listPlatformSummaries());
});

platformSkillsRouter.get('/marketplace', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const results = await new SkillsShClient().search(parsed.data.q ?? '');
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

platformSkillsRouter.post('/install', async (req, res) => {
  const parsed = installSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tempSourceDir = await mkdtemp(join(tmpdir(), 'opendeepsea-platform-skill-'));
  let shouldRemoveTempSource = true;
  try {
    const client = new SkillsShClient();
    const pkg = await client.fetchPackage(parsed.data.installLabel);
    const materialized = await writeSkillsShPackage(pkg, tempSourceDir);
    let sourceDir = tempSourceDir;
    if (parsed.data.installMode === 'symlink') {
      const persistentSourceDir = await resolvePersistentSkillsShSourceDir(parsed.data.installLabel, materialized.checksum);
      if (existsSync(persistentSourceDir)) {
        const persistentStats = await lstat(persistentSourceDir);
        if (!persistentStats.isDirectory()) throw new Error('persistent skill source path is not a directory');
        sourceDir = persistentSourceDir;
      } else {
        await assertCanInstallDirectoryToPlatforms({
          sourceDir: tempSourceDir,
          targets: parsed.data.targets as PlatformSkillProvider[],
        });
        await mkdir(dirname(persistentSourceDir), { recursive: true });
        await rename(tempSourceDir, persistentSourceDir);
        shouldRemoveTempSource = false;
        sourceDir = persistentSourceDir;
      }
    }
    const installed = await installDirectoryToPlatforms({
      sourceDir,
      targets: parsed.data.targets as PlatformSkillProvider[],
      installMode: parsed.data.installMode,
      sourceLabel: pkg.installLabel,
    });
    res.status(201).json(installed);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  } finally {
    if (shouldRemoveTempSource) {
      await rm(tempSourceDir, { recursive: true, force: true });
    }
  }
});

platformSkillsRouter.post('/import-local', async (req, res) => {
  const parsed = importLocalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const installed = await installDirectoryToPlatforms({
      sourceDir: parsed.data.path,
      targets: parsed.data.targets as PlatformSkillProvider[],
      installMode: parsed.data.installMode,
      sourceLabel: `local:${parsed.data.path}`,
    });
    res.status(201).json(installed);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

platformSkillsRouter.get('/:provider', async (req, res) => {
  const parsed = providerSchema.safeParse(req.params.provider);
  if (!parsed.success) return res.status(404).json({ error: 'platform not found' });
  res.json(await listPlatformSkills(parsed.data));
});

platformSkillsRouter.get('/:provider/:skillName', async (req, res) => {
  const parsed = providerSchema.safeParse(req.params.provider);
  if (!parsed.success) return res.status(404).json({ error: 'platform not found' });
  const skill = await getPlatformSkill(parsed.data, req.params.skillName);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  res.json(skill);
});

platformSkillsRouter.delete('/:provider/:skillName', async (req, res) => {
  const parsed = providerSchema.safeParse(req.params.provider);
  if (!parsed.success) return res.status(404).json({ error: 'platform not found' });
  try {
    const removed = await removePlatformSkill(parsed.data, req.params.skillName);
    if (!removed) return res.status(404).json({ error: 'skill not found' });
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}

async function resolvePersistentSkillsShSourceDir(installLabel: string, checksum: string): Promise<string> {
  const sourceRoot = process.env.OPENDEEPSEA_PLATFORM_SKILL_SOURCES_DIR?.trim()
    || join(homedir(), '.opendeepsea', 'platform-skill-sources');
  const digest = createHash('sha256').update(installLabel).digest('hex').slice(0, 16);
  const contentDigest = checksum.slice(0, 16);
  const safeLabel = installLabel.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  return join(sourceRoot, 'skills-sh', `${safeLabel}-${digest}-${contentDigest}`);
}
