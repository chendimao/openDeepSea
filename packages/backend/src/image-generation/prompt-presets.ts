import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { ImagePromptPreset, ImagePromptPresetInput } from './types.js';

export interface ImagePromptPresetRepository {
  list(projectId: string, filters?: { query?: string }): ImagePromptPreset[];
  create(projectId: string, input: ImagePromptPresetInput): ImagePromptPreset;
  softDelete(projectId: string, presetId: string): ImagePromptPreset | undefined;
}

export const imagePromptPresetRepo: ImagePromptPresetRepository = {
  list,
  create,
  softDelete,
};

function list(projectId: string, filters: { query?: string } = {}): ImagePromptPreset[] {
  const where = ['project_id = ?', 'deleted_at IS NULL'];
  const args: Array<string> = [projectId];
  const query = normalizeSearchQuery(filters.query);
  if (query) {
    where.push(`(title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')`);
    args.push(query, query);
  }

  return db
    .prepare(
      `SELECT *
       FROM image_prompt_presets
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(...args) as ImagePromptPreset[];
}

function create(projectId: string, input: ImagePromptPresetInput): ImagePromptPreset {
  const id = nanoid(16);
  const timestamp = now();
  db.prepare(
    `INSERT INTO image_prompt_presets (
      id, project_id, title, prompt, created_at, updated_at, deleted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, projectId, input.title, input.prompt, timestamp, timestamp);
  return requirePreset(projectId, id);
}

function softDelete(projectId: string, presetId: string): ImagePromptPreset | undefined {
  const timestamp = now();
  const result = db
    .prepare(
      `UPDATE image_prompt_presets
       SET deleted_at = COALESCE(deleted_at, ?),
           updated_at = ?
       WHERE id = ?
         AND project_id = ?
         AND deleted_at IS NULL`,
    )
    .run(timestamp, timestamp, presetId, projectId);
  return result.changes > 0 ? requirePreset(projectId, presetId, { includeDeleted: true }) : undefined;
}

function requirePreset(
  projectId: string,
  presetId: string,
  options: { includeDeleted?: boolean } = {},
): ImagePromptPreset {
  const where = options.includeDeleted
    ? 'id = ? AND project_id = ?'
    : 'id = ? AND project_id = ? AND deleted_at IS NULL';
  const preset = db
    .prepare(`SELECT * FROM image_prompt_presets WHERE ${where}`)
    .get(presetId, projectId) as ImagePromptPreset | undefined;
  if (!preset) throw new Error('image prompt preset not found');
  return preset;
}

function normalizeSearchQuery(query: string | undefined): string | null {
  const trimmed = query?.trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
}
