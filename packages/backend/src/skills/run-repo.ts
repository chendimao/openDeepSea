import { db, now } from '../db.js';
import type {
  SkillExecutableRuntime,
  SkillRun,
  SkillRunInvoker,
  SkillRunStatus,
} from './types.js';

interface SkillRunRow extends Omit<SkillRun, 'input' | 'allowed_paths' | 'result'> {
  input_json: string | null;
  allowed_paths_json: string | null;
  result_json: string | null;
}

interface CreateSkillRunInput {
  id: string;
  skill_id: string;
  project_id?: string | null;
  room_id?: string | null;
  agent_id?: string | null;
  invoked_by: SkillRunInvoker;
  runtime: SkillExecutableRuntime;
  entrypoint: string;
  input?: unknown;
  allowed_paths?: string[];
  network_enabled: boolean;
  status?: SkillRunStatus;
}

interface UpdateSkillRunInput {
  status?: SkillRunStatus;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  result?: unknown;
  error?: string | null;
}

interface SkillRunFilter {
  skill_id?: string;
  project_id?: string;
  room_id?: string;
  agent_id?: string;
  status?: SkillRunStatus;
}

export const skillRunRepo = {
  createRun(input: CreateSkillRunInput): SkillRun {
    const ts = now();
    db.prepare(
      `INSERT INTO skill_runs (
        id, skill_id, project_id, room_id, agent_id, invoked_by, runtime, entrypoint,
        input_json, allowed_paths_json, network_enabled, status, exit_code, stdout,
        stderr, result_json, error, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.skill_id,
      input.project_id ?? null,
      input.room_id ?? null,
      input.agent_id ?? null,
      input.invoked_by,
      input.runtime,
      input.entrypoint,
      stringifyJson(input.input ?? null),
      stringifyJson(input.allowed_paths ?? []),
      input.network_enabled ? 1 : 0,
      input.status ?? 'queued',
      null,
      null,
      null,
      null,
      null,
      ts,
      ts,
    );
    return this.getRun(input.id)!;
  },

  getRun(id: string): SkillRun | null {
    const row = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(id) as SkillRunRow | undefined;
    return row ? normalizeRun(row) : null;
  },

  listRuns(filter: SkillRunFilter = {}): SkillRun[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.skill_id) {
      clauses.push('skill_id = ?');
      params.push(filter.skill_id);
    }
    if (filter.project_id) {
      clauses.push('project_id = ?');
      params.push(filter.project_id);
    }
    if (filter.room_id) {
      clauses.push('room_id = ?');
      params.push(filter.room_id);
    }
    if (filter.agent_id) {
      clauses.push('agent_id = ?');
      params.push(filter.agent_id);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM skill_runs ${where} ORDER BY created_at DESC`).all(...params) as SkillRunRow[];
    return rows.map(normalizeRun);
  },

  updateRun(id: string, patch: UpdateSkillRunInput): SkillRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;
    const updated: SkillRun = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.exit_code !== undefined ? { exit_code: patch.exit_code } : {}),
      ...(patch.stdout !== undefined ? { stdout: patch.stdout } : {}),
      ...(patch.stderr !== undefined ? { stderr: patch.stderr } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      updated_at: now(),
    };
    db.prepare(
      `UPDATE skill_runs
       SET status = ?, exit_code = ?, stdout = ?, stderr = ?, result_json = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      updated.status,
      updated.exit_code,
      updated.stdout,
      updated.stderr,
      stringifyJson(updated.result ?? null),
      updated.error,
      updated.updated_at,
      id,
    );
    return this.getRun(id);
  },
};

function normalizeRun(row: SkillRunRow): SkillRun {
  return {
    ...row,
    input: parseJson(row.input_json),
    allowed_paths: parseStringArray(row.allowed_paths_json),
    network_enabled: row.network_enabled ? 1 : 0,
    result: parseJson(row.result_json),
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}
