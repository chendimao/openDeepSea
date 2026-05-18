import { loadSkillFromDirectory } from './loader.js';
import { skillRepo } from './repo.js';
import type { EffectiveSkillBinding, Skill, SkillRuntimeScope } from './types.js';

export interface SkillSelectionInput {
  runtimeScopes: SkillRuntimeScope[];
  projectId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
  message?: string;
  skillIds?: string[];
  maxSkills?: number;
  maxInstructionChars?: number;
  bindings?: EffectiveSkillBinding[];
  loadInstructions?: (skill: Skill, maxInstructionChars: number) => Promise<{
    instructions: string;
    truncated: boolean;
  }>;
}

export interface SelectedSkill {
  skill: Skill;
  effectivePriority: number;
  reasons: string[];
  instructions: string;
  truncated: boolean;
}

interface Candidate {
  binding: EffectiveSkillBinding;
  reasons: string[];
}

export async function selectSkills(input: SkillSelectionInput): Promise<SelectedSkill[]> {
  const maxSkills = Math.max(0, input.maxSkills ?? 3);
  const maxInstructionChars = Math.max(0, input.maxInstructionChars ?? 4000);
  const explicitIds = new Set(input.skillIds ?? []);
  const message = input.message ?? '';
  const bindings = input.bindings ?? skillRepo.resolveEffectiveBindings({
    projectId: input.projectId,
    roomId: input.roomId,
    agentId: input.agentId,
  });
  const candidates = dedupeCandidates(buildCandidates(bindings, input.runtimeScopes, message, explicitIds));
  const selected: SelectedSkill[] = [];
  const alwaysForScopeSeen = new Set<SkillRuntimeScope>();

  for (const candidate of candidates) {
    if (selected.length >= maxSkills) break;
    const alwaysScope = candidate.reasons
      .map((reason) => reason.match(/^always_for_scope (.+)$/)?.[1])
      .find((scope): scope is SkillRuntimeScope => Boolean(scope));
    if (alwaysScope) {
      if (alwaysForScopeSeen.has(alwaysScope)) continue;
      alwaysForScopeSeen.add(alwaysScope);
    }
    const loaded = await (input.loadInstructions ?? defaultLoadInstructions)(candidate.binding.skill, maxInstructionChars);
    const instructions = loaded.instructions.slice(0, maxInstructionChars);
    selected.push({
      skill: candidate.binding.skill,
      effectivePriority: candidate.binding.effectivePriority,
      reasons: candidate.reasons,
      instructions,
      truncated: loaded.truncated || loaded.instructions.length > instructions.length,
    });
  }

  return selected;
}

function buildCandidates(
  bindings: EffectiveSkillBinding[],
  runtimeScopes: SkillRuntimeScope[],
  message: string,
  explicitIds: Set<string>,
): Candidate[] {
  const normalizedMessage = message.toLocaleLowerCase();
  const requestedScopes = new Set(runtimeScopes);
  const candidates: Candidate[] = [];

  for (const binding of bindings) {
    const matchingScopes = binding.skill.runtime_scopes.filter((scope) => requestedScopes.has(scope));
    if (matchingScopes.length === 0) continue;
    const reasons: string[] = [];
    if (explicitIds.has(binding.skill.id)) {
      reasons.push('explicit skill request');
    } else if (binding.skill.trigger_mode === 'keyword') {
      const keyword = binding.skill.trigger_keywords.find((item) =>
        normalizedMessage.includes(item.toLocaleLowerCase()),
      );
      if (keyword) reasons.push(`keyword match "${keyword}"`);
    } else if (binding.skill.trigger_mode === 'always_for_scope') {
      reasons.push(`always_for_scope ${matchingScopes[0]}`);
    }
    if (reasons.length > 0) candidates.push({ binding, reasons });
  }

  return candidates.sort((a, b) =>
    a.binding.effectivePriority - b.binding.effectivePriority ||
    b.binding.scopeSpecificity - a.binding.scopeSpecificity ||
    a.binding.skill.name.localeCompare(b.binding.skill.name),
  );
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = candidate.binding.skill.name.toLocaleLowerCase();
    if (!byKey.has(key)) byKey.set(key, candidate);
  }
  return Array.from(byKey.values());
}

async function defaultLoadInstructions(skill: Skill, maxInstructionChars: number): Promise<{
  instructions: string;
  truncated: boolean;
}> {
  const loaded = await loadSkillFromDirectory(skill.install_path, { maxInstructionChars });
  return {
    instructions: loaded.instructions,
    truncated: loaded.truncated,
  };
}
