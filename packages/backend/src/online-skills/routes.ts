import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateLocalAccess } from '../local-access.js';
import { getOnlineSkillsTokenConfig, updateOnlineSkillsTokenConfig } from './config.js';
import { onlineSkillsService } from './service.js';
import type { OnlineSkillsService } from './types.js';

export const onlineSkillsRouter = createOnlineSkillsRouter(onlineSkillsService);

export function createOnlineSkillsRouter(service: OnlineSkillsService): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!requireLocalAccess(req, res)) return;
    next();
  });

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      res.json(await service.listOnlineSkills(parsed.data));
    } catch (err) {
      respondOnlineSkillsError(res, err);
    }
  });

  router.get('/search', async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      res.json(await service.searchOnlineSkills(parsed.data));
    } catch (err) {
      respondOnlineSkillsError(res, err);
    }
  });

  router.get('/config', async (_req, res) => {
    res.json(await getOnlineSkillsTokenConfig());
  });

  router.patch('/config', async (req, res) => {
    const parsed = tokenConfigPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    res.json(await updateOnlineSkillsTokenConfig(parsed.data.token));
  });

  router.get('/:id/audit', async (req, res) => {
    try {
      res.json(await service.getOnlineSkillAudit(req.params.id));
    } catch (err) {
      respondOnlineSkillsError(res, err);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      res.json(await service.getOnlineSkill(req.params.id));
    } catch (err) {
      respondOnlineSkillsError(res, err);
    }
  });

  return router;
}

const listQuerySchema = z.object({
  view: z.enum(['all-time', 'trending', 'hot']).default('all-time'),
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  forceRefresh: z.coerce.boolean().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  page: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  forceRefresh: z.coerce.boolean().optional(),
});

const tokenConfigPatchSchema = z
  .object({
    token: z.union([z.string(), z.null()]).transform((value) => {
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed || null;
    }),
  })
  .strict();

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}

function respondOnlineSkillsError(res: Response, err: unknown): void {
  const message = (err as Error).message;
  if (message === 'upstream_rate_limited') {
    res.status(429).json({ error: 'SkillsMP API rate limit exceeded' });
    return;
  }
  if (message === 'skill_not_found') {
    res.status(404).json({ error: 'skill not found' });
    return;
  }
  if (message === 'audit_not_found') {
    res.status(404).json({ error: 'skill audit not found' });
    return;
  }
  if (message === 'upstream_unavailable') {
    res.status(502).json({ error: 'SkillsMP API request failed' });
    return;
  }
  res.status(502).json({ error: message || 'SkillsMP API request failed' });
}
