import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { importLocalSkill, installedPathLabel, removeInstalledSkill } from './installer.js';
import { invokeSkill } from './executor.js';
import { skillRunRepo } from './run-repo.js';
import { validateLocalAccess } from '../local-access.js';
import { formatSkillPrompt } from './prompt.js';
import { DuplicateSkillNameError, skillRepo } from './repo.js';
import { selectSkills } from './selector.js';
import type { Skill, SkillBinding, SkillBindingScope, SkillRun, SkillRuntimeScope, SkillTriggerMode } from './types.js';

export const skillsRouter = Router();
skillsRouter.use((req, res, next) => {
  if (!requireLocalAccess(req, res)) return;
  next();
});

const runtimeScopeSchema = z.enum(['planner', 'model_chat', 'workflow', 'memory', 'review']);
const bindingScopeSchema = z.enum(['system', 'project', 'room', 'agent']);
const triggerModeSchema = z.enum(['manual', 'keyword', 'always_for_scope']);

const skillPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  runtime_scopes: z.array(runtimeScopeSchema).optional(),
  trigger_mode: triggerModeSchema.optional(),
  trigger_keywords: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const bindingInputSchema = z.object({
  id: z.string().min(1).optional(),
  skill_id: z.string().min(1),
  scope: bindingScopeSchema,
  scope_id: z.string().min(1),
  enabled: z.boolean().optional(),
  priority_override: z.number().int().nullable().optional(),
});


const runSkillSchema = z.object({
  projectId: z.string().min(1),
  roomId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1).nullable().optional(),
  invokedBy: z.enum(['workflow', 'agent', 'manual']).optional(),
  input: z.unknown().optional(),
});

const previewSchema = z.object({
  runtimeScopes: z.array(runtimeScopeSchema).min(1),
  projectId: z.string().nullable().optional(),
  roomId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  message: z.string().optional(),
  skillIds: z.array(z.string()).optional(),
});

skillsRouter.get('/', (_req, res) => {
  res.json(skillRepo.listSkills().map(toSkillDto));
});

skillsRouter.post('/import/local', async (req, res) => {
  const parsed = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const skill = await importLocalSkill(parsed.data.path);
    res.status(201).json(toSkillDto(skill));
  } catch (err) {
    if (err instanceof DuplicateSkillNameError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

skillsRouter.post('/import/git', (_req, res) => {
  res.status(501).json({ error: 'Git skill import is not implemented yet' });
});

skillsRouter.get('/bindings', (req, res) => {
  const parsed = z.object({
    scope: bindingScopeSchema.optional(),
    scopeId: z.string().optional(),
    skillId: z.string().optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(skillRepo.listBindings({
    scope: parsed.data.scope,
    scope_id: parsed.data.scopeId,
    skill_id: parsed.data.skillId,
  }).map(toBindingDto));
});

skillsRouter.put('/bindings', (req, res) => {
  const parsed = bindingInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!skillRepo.getSkill(parsed.data.skill_id)) return res.status(404).json({ error: 'skill not found' });
  const binding = skillRepo.upsertBinding({
    id: parsed.data.id ?? `${parsed.data.skill_id}:${parsed.data.scope}:${parsed.data.scope_id}`,
    skill_id: parsed.data.skill_id,
    scope: parsed.data.scope,
    scope_id: parsed.data.scope_id,
    enabled: parsed.data.enabled ?? true,
    priority_override: parsed.data.priority_override ?? null,
  });
  res.json(toBindingDto(binding));
});

skillsRouter.delete('/bindings/:bindingId', (req, res) => {
  if (!skillRepo.deleteBinding(req.params.bindingId)) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

skillsRouter.post('/preview-selection', async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const selected = await selectSkills({
    runtimeScopes: parsed.data.runtimeScopes,
    projectId: parsed.data.projectId,
    roomId: parsed.data.roomId,
    agentId: parsed.data.agentId,
    message: parsed.data.message,
    skillIds: parsed.data.skillIds,
  });
  res.json({
    skills: selected.map((item) => ({
      id: item.skill.id,
      name: item.skill.name,
      reasons: item.reasons,
      effectivePriority: item.effectivePriority,
      truncated: item.truncated,
    })),
    promptPreview: formatSkillPrompt(selected),
  });
});


skillsRouter.get('/runs', (req, res) => {
  const parsed = z.object({
    skillId: z.string().optional(),
    projectId: z.string().optional(),
    roomId: z.string().optional(),
    agentId: z.string().optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(skillRunRepo.listRuns({
    skill_id: parsed.data.skillId,
    project_id: parsed.data.projectId,
    room_id: parsed.data.roomId,
    agent_id: parsed.data.agentId,
  }).map(toSkillRunDto));
});

skillsRouter.post('/:skillId/run', async (req, res) => {
  const parsed = runSkillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const run = await invokeSkill({
      skillId: req.params.skillId,
      projectId: parsed.data.projectId,
      roomId: parsed.data.roomId,
      agentId: parsed.data.agentId,
      invokedBy: parsed.data.invokedBy ?? 'manual',
      input: parsed.data.input ?? null,
    });
    res.status(run.status === 'completed' ? 200 : 500).json(toSkillRunDto(run));
  } catch (err) {
    const message = (err as Error).message;
    const status = message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

skillsRouter.get('/:skillId', (req, res) => {
  const skill = skillRepo.getSkill(req.params.skillId);
  if (!skill) return res.status(404).json({ error: 'not found' });
  res.json(toSkillDto(skill));
});

skillsRouter.patch('/:skillId', (req, res) => {
  const parsed = skillPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const updated = skillRepo.updateSkill(req.params.skillId, {
      name: parsed.data.name,
      description: parsed.data.description,
      runtime_scopes: parsed.data.runtime_scopes as SkillRuntimeScope[] | undefined,
      trigger_mode: parsed.data.trigger_mode as SkillTriggerMode | undefined,
      trigger_keywords: parsed.data.trigger_keywords,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
    });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(toSkillDto(updated));
  } catch (err) {
    if (err instanceof DuplicateSkillNameError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

skillsRouter.delete('/:skillId', async (req, res) => {
  const skill = skillRepo.getSkill(req.params.skillId);
  if (!skill) return res.status(404).json({ error: 'not found' });
  try {
    await removeInstalledSkill(skill);
    skillRepo.deleteSkill(skill.id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

function toSkillDto(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source_type: skill.source_type,
    manifest_path: skill.manifest_path,
    runtime_scopes: skill.runtime_scopes,
    trigger_mode: skill.trigger_mode,
    trigger_keywords: skill.trigger_keywords,
    enabled: skill.enabled,
    priority: skill.priority,
    checksum: skill.checksum,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
    install_path_set: Boolean(skill.install_path),
    install_path_label: installedPathLabel(skill),
  };
}

function toBindingDto(binding: SkillBinding): {
  id: string;
  skill_id: string;
  scope: SkillBindingScope;
  scope_id: string;
  enabled: 0 | 1;
  priority_override: number | null;
  created_at: number;
  updated_at: number;
} {
  return binding;
}


function toSkillRunDto(run: SkillRun): Record<string, unknown> {
  return {
    id: run.id,
    skill_id: run.skill_id,
    project_id: run.project_id,
    room_id: run.room_id,
    agent_id: run.agent_id,
    invoked_by: run.invoked_by,
    runtime: run.runtime,
    entrypoint: run.entrypoint,
    input: run.input,
    allowed_paths: run.allowed_paths,
    network_enabled: run.network_enabled,
    status: run.status,
    exit_code: run.exit_code,
    stdout: run.stdout,
    stderr: run.stderr,
    result: run.result,
    error: run.error,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

function requireLocalAccess(req: Request, res: Response): boolean {
  const auth = validateLocalAccess(req);
  if (auth.ok) return true;
  res.status(auth.status).json({ error: auth.error });
  return false;
}
