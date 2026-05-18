import { Router } from 'express';
import { z } from 'zod';
import { importLocalSkill, installedPathLabel, removeInstalledSkill } from './installer.js';
import { formatSkillPrompt } from './prompt.js';
import { skillRepo } from './repo.js';
import { selectSkills } from './selector.js';
import type { Skill, SkillBinding, SkillBindingScope, SkillRuntimeScope, SkillTriggerMode } from './types.js';

export const skillsRouter = Router();

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

skillsRouter.get('/:skillId', (req, res) => {
  const skill = skillRepo.getSkill(req.params.skillId);
  if (!skill) return res.status(404).json({ error: 'not found' });
  res.json(toSkillDto(skill));
});

skillsRouter.patch('/:skillId', (req, res) => {
  const parsed = skillPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
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
