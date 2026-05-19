import { db, now } from '../db.js';
import type {
  EffectiveSkillBinding,
  Skill,
  SkillBinding,
  SkillBindingScope,
  SkillExecutableRuntime,
  SkillPermissions,
  SkillRuntimeScope,
  SkillSourceType,
  SkillTriggerMode,
  SkillUpdateApplyMode,
  SkillUpdateCheckMode,
} from './types.js';

const SYSTEM_SCOPE_ID = 'default';

interface SkillRow extends Omit<Skill, 'runtime_scopes' | 'trigger_keywords' | 'permissions'> {
  runtime_scopes: string;
  trigger_keywords: string | null;
  permissions_json: string | null;
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
  package_version?: string | null;
  package_revision?: string | null;
  runtime_type?: SkillExecutableRuntime | null;
  entrypoint?: string | null;
  permissions?: SkillPermissions | null;
  install_source_label?: string | null;
  update_check_mode?: SkillUpdateCheckMode;
  update_apply_mode?: SkillUpdateApplyMode;
  last_update_checked_at?: number | null;
  available_version?: string | null;
  available_revision?: string | null;
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
  package_version?: string | null;
  package_revision?: string | null;
  runtime_type?: SkillExecutableRuntime | null;
  entrypoint?: string | null;
  permissions?: SkillPermissions | null;
  install_source_label?: string | null;
  update_check_mode?: SkillUpdateCheckMode;
  update_apply_mode?: SkillUpdateApplyMode;
  last_update_checked_at?: number | null;
  available_version?: string | null;
  available_revision?: string | null;
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

  findSkillByName(name: string, excludeId?: string): Skill | null {
    const normalized = name.trim();
    if (!normalized) return null;
    const row = excludeId
      ? db.prepare('SELECT * FROM skills WHERE lower(name) = lower(?) AND id != ?').get(normalized, excludeId) as SkillRow | undefined
      : db.prepare('SELECT * FROM skills WHERE lower(name) = lower(?)').get(normalized) as SkillRow | undefined;
    return row ? normalizeSkill(row) : null;
  },

  createSkill(input: CreateSkillInput): Skill {
    assertUniqueSkillName(input.name);
    const ts = now();
    db.prepare(
      `INSERT INTO skills (
        id, name, description, source_type, source_uri, install_path, manifest_path,
        runtime_scopes, trigger_mode, trigger_keywords, enabled, priority, checksum,
        package_version, package_revision, runtime_type, entrypoint, permissions_json,
        install_source_label, update_check_mode, update_apply_mode, last_update_checked_at,
        available_version, available_revision, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.package_version ?? null,
      input.package_revision ?? null,
      input.runtime_type ?? null,
      input.entrypoint ?? null,
      stringifyNullableJson(input.permissions ?? null),
      input.install_source_label ?? null,
      input.update_check_mode ?? 'startup',
      input.update_apply_mode ?? 'prompt',
      input.last_update_checked_at ?? null,
      input.available_version ?? null,
      input.available_revision ?? null,
      ts,
      ts,
    );
    return this.getSkill(input.id)!;
  },

  updateSkill(id: string, patch: UpdateSkillInput): Skill | null {
    const existing = this.getSkill(id);
    if (!existing) return null;
    if (patch.name !== undefined) assertUniqueSkillName(patch.name, id);
    const updated: Skill = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.source_type !== undefined ? { source_type: patch.source_type } : {}),
      ...(patch.source_uri !== undefined ? { source_uri: patch.source_uri } : {}),
      ...(patch.install_path !== undefined ? { install_path: patch.install_path } : {}),
      ...(patch.manifest_path !== undefined ? { manifest_path: patch.manifest_path } : {}),
      ...(patch.runtime_scopes !== undefined ? { runtime_scopes: patch.runtime_scopes } : {}),
      ...(patch.trigger_mode !== undefined ? { trigger_mode: patch.trigger_mode } : {}),
      ...(patch.trigger_keywords !== undefined ? { trigger_keywords: patch.trigger_keywords } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled === false ? 0 as const : 1 as const } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.checksum !== undefined ? { checksum: patch.checksum } : {}),
      ...(patch.package_version !== undefined ? { package_version: patch.package_version } : {}),
      ...(patch.package_revision !== undefined ? { package_revision: patch.package_revision } : {}),
      ...(patch.runtime_type !== undefined ? { runtime_type: patch.runtime_type } : {}),
      ...(patch.entrypoint !== undefined ? { entrypoint: patch.entrypoint } : {}),
      ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
      ...(patch.install_source_label !== undefined ? { install_source_label: patch.install_source_label } : {}),
      ...(patch.update_check_mode !== undefined ? { update_check_mode: patch.update_check_mode } : {}),
      ...(patch.update_apply_mode !== undefined ? { update_apply_mode: patch.update_apply_mode } : {}),
      ...(patch.last_update_checked_at !== undefined ? { last_update_checked_at: patch.last_update_checked_at } : {}),
      ...(patch.available_version !== undefined ? { available_version: patch.available_version } : {}),
      ...(patch.available_revision !== undefined ? { available_revision: patch.available_revision } : {}),
      updated_at: now(),
    };
    db.prepare(
      `UPDATE skills
       SET name = ?, description = ?, source_type = ?, source_uri = ?, install_path = ?, manifest_path = ?,
           runtime_scopes = ?, trigger_mode = ?, trigger_keywords = ?, enabled = ?, priority = ?, checksum = ?,
           package_version = ?, package_revision = ?, runtime_type = ?, entrypoint = ?, permissions_json = ?,
           install_source_label = ?, update_check_mode = ?, update_apply_mode = ?, last_update_checked_at = ?,
           available_version = ?, available_revision = ?,
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
      updated.package_version,
      updated.package_revision,
      updated.runtime_type,
      updated.entrypoint,
      stringifyNullableJson(updated.permissions),
      updated.install_source_label,
      updated.update_check_mode,
      updated.update_apply_mode,
      updated.last_update_checked_at,
      updated.available_version,
      updated.available_revision,
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

export class DuplicateSkillNameError extends Error {
  constructor(name: string) {
    super(`A skill with the same name already exists: ${name}`);
    this.name = 'DuplicateSkillNameError';
  }
}

function assertUniqueSkillName(name: string, excludeId?: string): void {
  if (skillRepo.findSkillByName(name, excludeId)) {
    throw new DuplicateSkillNameError(name);
  }
}

function normalizeSkill(row: SkillRow): Skill {
  return {
    ...row,
    runtime_scopes: parseStringArray(row.runtime_scopes).filter(isSkillRuntimeScope),
    trigger_keywords: parseStringArray(row.trigger_keywords),
    permissions: parsePermissions(row.permissions_json),
    runtime_type: isSkillExecutableRuntime(row.runtime_type) ? row.runtime_type : null,
    update_check_mode: isSkillUpdateCheckMode(row.update_check_mode) ? row.update_check_mode : 'startup',
    update_apply_mode: isSkillUpdateApplyMode(row.update_apply_mode) ? row.update_apply_mode : 'prompt',
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

function stringifyNullableJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function isSkillRuntimeScope(value: string): value is SkillRuntimeScope {
  return ['planner', 'model_chat', 'workflow', 'memory', 'review'].includes(value);
}

function isSkillExecutableRuntime(value: string | null): value is SkillExecutableRuntime {
  return value === 'node' || value === 'python' || value === 'shell';
}

function isSkillUpdateCheckMode(value: string | null): value is SkillUpdateCheckMode {
  return value === 'off' || value === 'startup' || value === 'manual' || value === 'scheduled';
}

function isSkillUpdateApplyMode(value: string | null): value is SkillUpdateApplyMode {
  return value === 'prompt' || value === 'download' || value === 'auto';
}

function parsePermissions(raw: string | null): SkillPermissions | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<SkillPermissions>;
    if (candidate.filesystem !== 'project') return null;
    if (typeof candidate.network !== 'boolean') return null;
    if (!Array.isArray(candidate.commands) || !candidate.commands.every((item) => typeof item === 'string')) {
      return null;
    }
    return {
      filesystem: 'project',
      network: candidate.network,
      commands: candidate.commands,
    };
  } catch {
    return null;
  }
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
