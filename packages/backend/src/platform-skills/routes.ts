import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateLocalAccess } from '../local-access.js';
import { resolveSessionPlannerRuntime } from '../session-planner-runtime.js';
import {
  getPlatformSkill,
  listPlatformSkillAggregates,
  listPlatformSkills,
  listPlatformSummaries,
} from './service.js';

export const platformSkillsRouter = Router();
platformSkillsRouter.use((req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  next();
});

const providerSchema = z.enum(['codex', 'claudecode', 'opencode']);

platformSkillsRouter.get('/platforms', async (_req, res) => {
  res.json(await listPlatformSummaries());
});

platformSkillsRouter.get('/', async (_req, res) => {
  res.json(await listPlatformSkillAggregates());
});

platformSkillsRouter.get('/session-planner/:projectId', async (req, res) => {
  try {
    const runtime = resolveSessionPlannerRuntime(req.params.projectId);
    const skills = await listPlatformSkills(runtime.backend);
    res.json({
      provider: runtime.backend,
      skills: skills.filter((skill) => skill.valid),
    });
  } catch (err) {
    if ((err as Error).message === 'project not found') {
      return res.status(404).json({ error: 'project not found' });
    }
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

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}
