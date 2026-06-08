import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateLocalAccess } from '../local-access.js';
import { terminalService } from './service.js';

export const terminalRouter = Router();

terminalRouter.use((req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  next();
});

const createTerminalSessionSchema = z.object({
  profile: z.enum(['project_shell', 'skills_install']),
  projectId: z.string().trim().min(1).nullable().optional(),
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(8).max(80),
});

terminalRouter.post('/', (req, res) => {
  const parsed = createTerminalSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.status(201).json(terminalService.create(parsed.data));
  } catch (err) {
    if ((err as Error).message === 'project not found') {
      return res.status(404).json({ error: 'project not found' });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

terminalRouter.get('/:id', (req, res) => {
  const session = terminalService.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'terminal session not found' });
  res.json(session);
});

terminalRouter.post('/:id/kill', (req, res) => {
  try {
    terminalService.kill(req.params.id);
    res.status(204).end();
  } catch (err) {
    if ((err as Error).message === 'terminal session not found') {
      return res.status(404).json({ error: 'terminal session not found' });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}
