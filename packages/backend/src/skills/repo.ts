import { db, now } from '../db.js';
import type {
  EffectiveSkillBinding,
  Skill,
  SkillBinding,
  SkillBindingScope,
  SkillRuntimeScope,
  SkillSourceType,
  SkillTriggerMode,
} from './types.js';

const SYSTEM_SCOPE_ID = 'default';

interface SkillRow extends Omit<Skill, 'runtime_scopes' | 'trigger_keywords'> {
  runtime_scopes: string;
  trigger_keywords: string | null;
}

interface SkillBindingRow extends SkillBinding {}

interface CreateSkillInput {
  id: string;
  name: string;
  description?: string | null;
  source_type: SkillSourceType;
  source_uri?: string | null;
  install_path: string;
  manifest_path?: string | null;
  runtime_scopes: SkillRuntimeScope[];
  trigger_mode: SkillTriggerMode;
  trigger_keywords?: string[];
  enabled?: boolean;
  priority?: number;
  checksum?: string | null;
}

interface UpdateSkillInput {
  name?: string;
  description?: string | null;
  source_type?: SkillSourceType;
  source_uri?: string | null;
  install_path?: string;
  manifest_path?: string | null;
  runtime_scopes?: SkillRuntimeScope[];
  trigger_mode?: SkillTriggerMode;
  trigger_keywords?: string[];
  enabled?: boolean;
  priority?: number;
  checksum?: string | null;
}

interface UpsertBindingInput {
  id: string;
  skill_id: string;
  scope: SkillBindingScope;
  scope_id: string;
  enabled?: boolean;
  priority_override?: number | null;
}

interface BindingFilter {
  scope?: SkillBindingScope;
  scope_id?: string;
  skill_id?: string;
}

interface EffectiveBindingInput {
  projectId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
}

export const skillRepo = {
  listSkills(): Skill[] {
    const rows = db.prepare('SELECT * FROM skills ORDER BY priority ASC, updated_at DESC, name ASC').all() as SkillRow[];
    return rows.map(normalizeSkill);
  },

  getSkill(id: string): Skill | null {
    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
    return row ? normalizeSkill(row) : null;
  },

  createSkill(input: CreateSkillInput): Skill {
    const ts = now();
    db.prepare(
      `INSERT INTO skills (
        id, name, description, source_type, source_uri, install_path, manifest_path,
        runtime_scopes, trigger_mode, trigger_keywords, enabled, priority, checksum, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.description ?? null,
      input.source_type,
      input.source_uri ?? null,
      input.install_path,
      input.manifest_path ?? null,
      stringifyArray(input.runtime_scopes),
      input.trigger_mode,
      stringifyArray(input.trigger_keywords ?? []),
      input.enabled === false ? 0 : 1,
      input.priority ?? 100,
      input.checksum ?? null,
      ts,
      ts,
    );
    return this.getSkill(input.id)!;
  },

  updateSkill(id: string, patch: UpdateSkillInput): Skill | null {
    const existing = this.getSkill(id);
    if (!existing) return null;
    const updated: Skill = {
      ...existing,
      ...('name' in patch ? { name: patch.name ?? existing.name } : {}),
      ...('description' in patch ? { description: patch.description ?? null } : {}),
      ...('source_type' in patch ? { source_type: patch.source_type ?? existing.source_type } : {}),
      ...('source_uri' in patch ? { source_uri: patch.source_uri ?? null } : {}),
      ...('install_path' in patch ? { install_path: patch.install_path ?? existing.install_path } : {}),
      ...('manifest_path' in patch ? { manifest_path: patch.manifest_path ?? null } : {}),
      ...('runtime_scopes' in patch ? { runtime_scopes: patch.runtime_scopes ?? [] } : {}),
      ...('trigger_mode' in patch ? { trigger_mode: patch.trigger_mode ?? existing.trigger_mode } : {}),
      ...('trigger_keywords' in patch ? { trigger_keywords: patch.trigger_keywords ?? [] } : {}),
      ...('enabled' in patch ? { enabled: patch.enabled === false ? 0 as const : 1 as const } : {}),
      ...('priority' in patch ? { priority: patch.priority ?? existing.priority } : {}),
      ...('checksum' in patch ? { checksum: patch.checksum ?? null } : {}),
      updated_at: now(),
    };
    db.prepare(
      `UPDATE skills
       SET name = ?, description = ?, source_type = ?, source_uri = ?, install_path = ?, manifest_path = ?,
           runtime_scopes = ?, trigger_mode = ?, trigger_keywords = ?, enabled = ?, priority = ?, checksum = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      updated.name,
      updated.description,
      updated.source_type,
      updated.source_uri,
      updated.install_path,
      updated.manifest_path,
      stringifyArray(updated.runtime_scopes),
      updated.trigger_mode,
      stringifyArray(updated.trigger_keywords),
      updated.enabled,
      updated.priority,
      updated.checksum,
      updated.updated_at,
      id,
    );
    return this.getSkill(id);
  },

  deleteSkill(id: string): boolean {
    const result = db.prepare('DELETE FROM skills WHERE id = ?').run(id);
    return result.changes > 0;
  },

  listBindings(filter: BindingFilter = {}): SkillBinding[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.scope) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.scope_id) {
      clauses.push('scope_id = ?');
      params.push(normalizeScopeId(filter.scope, filter.scope_id));
    }
    if (filter.skill_id) {
      clauses.push('skill_id = ?');
      params.push(filter.skill_id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM skill_bindings ${where} ORDER BY updated_at DESC`).all(...params) as SkillBinding[];
  },

  upsertBinding(input: UpsertBindingInput): SkillBinding {
    const ts = now();
    const scopeId = normalizeScopeId(input.scope, input.scope_id);
    db.prepare(
      `INSERT INTO skill_bindings (
        id, skill_id, scope, scope_id, enabled, priority_override, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id, scope, scope_id) DO UPDATE SET
         id = excluded.id,
         enabled = excluded.enabled,
         priority_override = excluded.priority_override,
         updated_at = excluded.updated_at`,
    ).run(
      input.id,
      input.skill_id,
      input.scope,
      scopeId,
      input.enabled === false ? 0 : 1,
      input.priority_override ?? null,
      ts,
      ts,
    );
    return db.prepare('SELECT * FROM skill_bindings WHERE skill_id = ? AND scope = ? AND scope_id = ?')
      .get(input.skill_id, input.scope, scopeId) as SkillBinding;
  },

  deleteBinding(id: string): boolean {
    const result = db.prepare('DELETE FROM skill_bindings WHERE id = ?').run(id);
    return result.changes > 0;
  },

  resolveEffectiveBindings(input: EffectiveBindingInput): EffectiveSkillBinding[] {
    const rows = db.prepare(
      `SELECT
         b.id AS binding_id,
         b.skill_id AS binding_skill_id,
         b.scope AS binding_scope,
         b.scope_id AS binding_scope_id,
         b.enabled AS binding_enabled,
         b.priority_override AS binding_priority_override,
         b.created_at AS binding_created_at,
         b.updated_at AS binding_updated_at,
         s.*
       FROM skill_bindings b
       JOIN skills s ON s.id = b.skill_id
       WHERE s.enabled = 1 AND (
         (b.scope = 'system' AND b.scope_id = ?)
         OR (b.scope = 'project' AND b.scope_id = ?)
         OR (b.scope = 'room' AND b.scope_id = ?)
         OR (b.scope = 'agent' AND b.scope_id = ?)
       )`,
    ).all(
      SYSTEM_SCOPE_ID,
      input.projectId ?? '',
      input.roomId ?? '',
      input.agentId ?? '',
    ) as Array<SkillRow & {
      binding_id: string;
      binding_skill_id: string;
      binding_scope: SkillBindingScope;
      binding_scope_id: string;
      binding_enabled: 0 | 1;
      binding_priority_override: number | null;
      binding_created_at: number;
      binding_updated_at: number;
    }>;

    const bySkill = new Map<string, EffectiveSkillBinding>();
    for (const row of rows) {
      const candidate: EffectiveSkillBinding = {
        skill: normalizeSkill(row),
        binding: {
          id: row.binding_id,
          skill_id: row.binding_skill_id,
          scope: row.binding_scope,
          scope_id: row.binding_scope_id,
          enabled: row.binding_enabled,
          priority_override: row.binding_priority_override,
          created_at: row.binding_created_at,
          updated_at: row.binding_updated_at,
        },
        effectivePriority: row.binding_priority_override ?? row.priority,
        scopeSpecificity: scopeSpecificity(row.binding_scope),
      };
      const existing = bySkill.get(candidate.skill.id);
      if (!existing || candidate.scopeSpecificity > existing.scopeSpecificity) {
        bySkill.set(candidate.skill.id, candidate);
      }
    }

    return Array.from(bySkill.values())
      .filter((item) => item.binding.enabled === 1)
      .sort((a, b) =>
        a.effectivePriority - b.effectivePriority ||
        b.scopeSpecificity - a.scopeSpecificity ||
        a.skill.name.localeCompare(b.skill.name),
      );
  },
};

function normalizeSkill(row: SkillRow): Skill {
  return {
    ...row,
    runtime_scopes: parseStringArray(row.runtime_scopes).filter(isSkillRuntimeScope),
    trigger_keywords: parseStringArray(row.trigger_keywords),
    enabled: row.enabled ? 1 : 0,
  };
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function stringifyArray(values: string[]): string {
  return JSON.stringify(values);
}

function isSkillRuntimeScope(value: string): value is SkillRuntimeScope {
  return ['planner', 'model_chat', 'workflow', 'memory', 'review'].includes(value);
}

function normalizeScopeId(scope: SkillBindingScope | undefined, scopeId: string): string {
  return scope === 'system' ? SYSTEM_SCOPE_ID : scopeId;
}

function scopeSpecificity(scope: SkillBindingScope): number {
  if (scope === 'agent') return 4;
  if (scope === 'room') return 3;
  if (scope === 'project') return 2;
  return 1;
}
