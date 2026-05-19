import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  ResourceAsset,
  ResourceAssetGroupKey,
  ResourceAssetListItem,
  ResourceAssetType,
} from '../types.js';

interface ResourceAssetCreateInput {
  project_id: string;
  asset_type: ResourceAssetType;
  group_key?: ResourceAssetGroupKey;
  title: string;
  content?: string | null;
  mime_type?: string | null;
  size?: number | null;
  url?: string | null;
  file_id?: string | null;
  source_message_id?: string | null;
  source_room_id?: string | null;
  source_agent_id?: string | null;
  source_task_id?: string | null;
  metadata?: Record<string, unknown> | string | null;
}

interface ResourceAssetListFilters {
  projectId: string;
  assetType?: ResourceAssetType;
  groupKey?: ResourceAssetGroupKey;
}

export const resourceAssetRepo = {
  create(input: ResourceAssetCreateInput): ResourceAsset {
    validateProjectBoundary(input);
    const id = nanoid(16);
    const timestamp = now();
    db.prepare(
      `INSERT INTO resource_assets (
        id, project_id, asset_type, group_key, title, content, mime_type, size, url, file_id,
        source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      input.project_id,
      input.asset_type,
      input.group_key ?? defaultGroupKey(input.asset_type),
      input.title,
      input.content ?? null,
      input.mime_type ?? null,
      input.size ?? null,
      input.url ?? null,
      input.file_id ?? null,
      input.source_message_id ?? null,
      input.source_room_id ?? null,
      input.source_agent_id ?? null,
      input.source_task_id ?? null,
      normalizeMetadata(input.metadata),
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  },

  get(id: string): ResourceAsset | undefined {
    if (id.startsWith('file:')) return getUploadedFileAsset(id.slice('file:'.length));
    return db.prepare('SELECT * FROM resource_assets WHERE id = ?').get(id) as ResourceAsset | undefined;
  },

  list(filters: ResourceAssetListFilters): ResourceAssetListItem[] {
    const assets = listAgentDocuments(filters);
    const includeUploadedFiles = !filters.assetType || filters.assetType === 'uploaded_file';
    const uploadedFiles = includeUploadedFiles && (!filters.groupKey || filters.groupKey === 'uploaded_files')
      ? listUploadedFileAssets(filters.projectId)
      : [];
    return [...assets, ...uploadedFiles].sort((a, b) => b.created_at - a.created_at);
  },

  softDelete(id: string): ResourceAsset | undefined {
    if (id.startsWith('file:')) return undefined;
    db.prepare(
      'UPDATE resource_assets SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?',
    ).run(now(), now(), id);
    return this.get(id);
  },
};

function listAgentDocuments(filters: ResourceAssetListFilters): ResourceAssetListItem[] {
  const where = ['project_id = @projectId', 'deleted_at IS NULL'];
  const params: Record<string, unknown> = { projectId: filters.projectId };
  if (filters.assetType) {
    where.push('asset_type = @assetType');
    params.assetType = filters.assetType;
  }
  if (filters.groupKey) {
    where.push('group_key = @groupKey');
    params.groupKey = filters.groupKey;
  }
  return db.prepare(
    `SELECT
       id, project_id, asset_type, group_key, title, mime_type, size, url, file_id,
       source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
       created_at, updated_at, deleted_at
     FROM resource_assets
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC`,
  ).all(params) as ResourceAssetListItem[];
}

function listUploadedFileAssets(projectId: string): ResourceAssetListItem[] {
  return db.prepare(
    `SELECT
       'file:' || id AS id,
       project_id,
       'uploaded_file' AS asset_type,
       'uploaded_files' AS group_key,
       original_name AS title,
       mime_type,
       size,
       url,
       id AS file_id,
       NULL AS source_message_id,
       NULL AS source_room_id,
       uploaded_by_id AS source_agent_id,
       NULL AS source_task_id,
       NULL AS metadata,
       created_at,
       created_at AS updated_at,
       deleted_at
     FROM files
     WHERE project_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`,
  ).all(projectId) as ResourceAssetListItem[];
}

function getUploadedFileAsset(fileId: string): ResourceAsset | undefined {
  return db.prepare(
    `SELECT
       'file:' || id AS id,
       project_id,
       'uploaded_file' AS asset_type,
       'uploaded_files' AS group_key,
       original_name AS title,
       NULL AS content,
       mime_type,
       size,
       url,
       id AS file_id,
       NULL AS source_message_id,
       NULL AS source_room_id,
       uploaded_by_id AS source_agent_id,
       NULL AS source_task_id,
       NULL AS metadata,
       created_at,
       created_at AS updated_at,
       deleted_at
     FROM files
     WHERE id = ? AND deleted_at IS NULL`,
  ).get(fileId) as ResourceAsset | undefined;
}

function validateProjectBoundary(input: ResourceAssetCreateInput): void {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.project_id) as { id: string } | undefined;
  if (!project) throw new Error('project not found');
  if (input.source_room_id) {
    const row = db.prepare('SELECT project_id FROM rooms WHERE id = ?').get(input.source_room_id) as
      | { project_id: string }
      | undefined;
    if (!row || row.project_id !== input.project_id) throw new Error('source room does not belong to project');
  }
  if (input.source_message_id) {
    const row = db.prepare(
      `SELECT rooms.project_id
       FROM messages
       JOIN rooms ON rooms.id = messages.room_id
       WHERE messages.id = ?`,
    ).get(input.source_message_id) as { project_id: string } | undefined;
    if (!row || row.project_id !== input.project_id) throw new Error('source message does not belong to project');
  }
  if (input.source_task_id) {
    const row = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.source_task_id) as
      | { project_id: string }
      | undefined;
    if (!row || row.project_id !== input.project_id) throw new Error('source task does not belong to project');
  }
  if (input.file_id) {
    const row = db.prepare('SELECT project_id FROM files WHERE id = ?').get(input.file_id) as
      | { project_id: string }
      | undefined;
    if (!row || row.project_id !== input.project_id) throw new Error('file does not belong to project');
  }
}

function defaultGroupKey(assetType: ResourceAssetType): ResourceAssetGroupKey {
  return assetType === 'uploaded_file' ? 'uploaded_files' : 'agent_documents';
}

function normalizeMetadata(metadata: ResourceAssetCreateInput['metadata']): string | null {
  if (metadata === undefined || metadata === null) return null;
  return typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
}
