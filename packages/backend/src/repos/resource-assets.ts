import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  ResourceAsset,
  ResourceCapabilities,
  ResourceAssetGroupKey,
  ResourceDetail,
  ResourceAssetListItem,
  ResourceListItem,
  ResourceSourceInfo,
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
  query?: string;
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
    return getAgentDocumentAsset(id);
  },

  list(filters: ResourceAssetListFilters): ResourceAssetListItem[] {
    const assets = listAgentDocuments(filters);
    const includeUploadedFiles = !filters.assetType || filters.assetType === 'uploaded_file';
    const uploadedFiles = includeUploadedFiles && (!filters.groupKey || filters.groupKey === 'uploaded_files')
      ? listUploadedFileAssets(filters.projectId, filters.query)
      : [];
    return [...assets, ...uploadedFiles].sort((a, b) => b.created_at - a.created_at);
  },

  listResources(filters: ResourceAssetListFilters): ResourceListItem[] {
    return this.list(filters).map(toResourceListItem);
  },

  getResource(id: string): ResourceDetail | undefined {
    const asset = this.get(id);
    if (!asset) return undefined;
    return toResourceDetail(asset);
  },

  softDelete(id: string): ResourceAsset | undefined {
    if (id.startsWith('file:')) return undefined;
    db.prepare(
      'UPDATE resource_assets SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?',
    ).run(now(), now(), id);
    return this.get(id);
  },
};

function toResourceListItem(asset: ResourceAssetListItem): ResourceListItem {
  return {
    ...asset,
    resource_type: asset.asset_type,
    name: asset.title,
    source: buildResourceSource(asset),
    capabilities: buildResourceCapabilities(asset.asset_type),
    preview_url: asset.asset_type === 'uploaded_file' ? asset.url : null,
    download_url: asset.asset_type === 'uploaded_file' ? asset.url : null,
  };
}

function toResourceDetail(asset: ResourceAsset): ResourceDetail {
  return {
    ...asset,
    resource_type: asset.asset_type,
    name: asset.title,
    source: buildResourceSource(asset),
    capabilities: buildResourceCapabilities(asset.asset_type),
    preview_url: asset.asset_type === 'uploaded_file' ? asset.url : null,
    download_url: asset.asset_type === 'uploaded_file' ? asset.url : null,
    content: asset.asset_type === 'agent_document' ? asset.content : null,
  };
}

function buildResourceSource(asset: Pick<
  ResourceAsset,
  | 'asset_type'
  | 'source_label'
  | 'source_display_name'
  | 'source_agent_id'
  | 'file_id'
  | 'source_message_id'
  | 'source_room_id'
  | 'source_task_id'
  | 'source_context_id'
  | 'source_context_name'
  | 'source_context_type'
>): ResourceSourceInfo {
  return {
    type: asset.asset_type === 'uploaded_file' ? 'user_upload' : 'agent',
    label: asset.source_label,
    display_name: asset.source_display_name,
    agent_id: asset.asset_type === 'agent_document' ? asset.source_agent_id : null,
    user_id: asset.asset_type === 'uploaded_file' ? asset.source_agent_id : null,
    message_id: asset.source_message_id,
    room_id: asset.source_room_id,
    task_id: asset.source_task_id,
    context: asset.source_context_id && asset.source_context_type
      ? {
          id: asset.source_context_id,
          type: asset.source_context_type,
          name: asset.source_context_name,
        }
      : null,
  };
}

function buildResourceCapabilities(assetType: ResourceAssetType): ResourceCapabilities {
  if (assetType === 'uploaded_file') {
    return {
      preview: true,
      download: true,
      markdown: false,
      delete: true,
    };
  }
  return {
    preview: true,
    download: false,
    markdown: true,
    delete: true,
  };
}

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
  const query = normalizeSearchQuery(filters.query);
  if (query) {
    where.push(
      `(
        title LIKE @query ESCAPE '\\'
        OR COALESCE(mime_type, '') LIKE @query ESCAPE '\\'
        OR COALESCE(source_agent_id, '') LIKE @query ESCAPE '\\'
        OR COALESCE(content, '') LIKE @query ESCAPE '\\'
        OR COALESCE((SELECT sender_name FROM messages WHERE messages.id = resource_assets.source_message_id), '') LIKE @query ESCAPE '\\'
        OR '智能体生成' LIKE @query ESCAPE '\\'
      )`,
    );
    params.query = query;
  }
  return db.prepare(
    `SELECT
       id, project_id, asset_type, group_key, title, mime_type, size, url, file_id,
       source_message_id, source_room_id, source_agent_id, source_task_id, metadata,
       COALESCE(
         (
           SELECT NULLIF(sender_name, '')
           FROM messages
           WHERE messages.id = resource_assets.source_message_id
             AND messages.sender_type = 'agent'
         ),
         NULLIF(source_agent_id, ''),
         '智能体'
       ) AS source_display_name,
       '智能体生成' AS source_label,
       COALESCE(source_task_id, source_room_id) AS source_context_id,
       COALESCE(
         (SELECT title FROM tasks WHERE tasks.id = resource_assets.source_task_id),
         (SELECT name FROM rooms WHERE rooms.id = resource_assets.source_room_id)
       ) AS source_context_name,
       CASE
         WHEN source_task_id IS NOT NULL THEN 'task'
         WHEN source_room_id IS NOT NULL THEN 'room'
         ELSE NULL
       END AS source_context_type,
       created_at, updated_at, deleted_at
     FROM resource_assets
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC`,
  ).all(params) as ResourceAssetListItem[];
}

function listUploadedFileAssets(projectId: string, query?: string): ResourceAssetListItem[] {
  const where = ['project_id = @projectId', 'deleted_at IS NULL'];
  const params: Record<string, unknown> = { projectId };
  const normalizedQuery = normalizeSearchQuery(query);
  if (normalizedQuery) {
    where.push(
      `(
        original_name LIKE @query ESCAPE '\\'
        OR stored_name LIKE @query ESCAPE '\\'
        OR mime_type LIKE @query ESCAPE '\\'
        OR COALESCE(uploaded_by_name, '') LIKE @query ESCAPE '\\'
        OR COALESCE(uploaded_by_id, '') LIKE @query ESCAPE '\\'
        OR '用户上传' LIKE @query ESCAPE '\\'
      )`,
    );
    params.query = normalizedQuery;
  }
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
       COALESCE(NULLIF(uploaded_by_name, ''), '用户上传') AS source_display_name,
       '用户上传' AS source_label,
       NULL AS source_context_id,
       NULL AS source_context_name,
       NULL AS source_context_type,
       NULL AS metadata,
       created_at,
       created_at AS updated_at,
       deleted_at
     FROM files
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC`,
  ).all(params) as ResourceAssetListItem[];
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
       COALESCE(NULLIF(uploaded_by_name, ''), '用户上传') AS source_display_name,
       '用户上传' AS source_label,
       NULL AS source_context_id,
       NULL AS source_context_name,
       NULL AS source_context_type,
       NULL AS metadata,
       created_at,
       created_at AS updated_at,
       deleted_at
     FROM files
     WHERE id = ? AND deleted_at IS NULL`,
  ).get(fileId) as ResourceAsset | undefined;
}

function getAgentDocumentAsset(id: string): ResourceAsset | undefined {
  return db.prepare(
    `SELECT
       resource_assets.*,
       COALESCE(
         CASE WHEN messages.sender_type = 'agent' THEN NULLIF(messages.sender_name, '') END,
         NULLIF(resource_assets.source_agent_id, ''),
         '智能体'
       ) AS source_display_name,
       '智能体生成' AS source_label,
       COALESCE(resource_assets.source_task_id, resource_assets.source_room_id) AS source_context_id,
       COALESCE(tasks.title, rooms.name) AS source_context_name,
       CASE
         WHEN resource_assets.source_task_id IS NOT NULL THEN 'task'
         WHEN resource_assets.source_room_id IS NOT NULL THEN 'room'
         ELSE NULL
       END AS source_context_type
     FROM resource_assets
     LEFT JOIN messages ON messages.id = resource_assets.source_message_id
     LEFT JOIN rooms ON rooms.id = resource_assets.source_room_id
     LEFT JOIN tasks ON tasks.id = resource_assets.source_task_id
     WHERE resource_assets.id = ?`,
  ).get(id) as ResourceAsset | undefined;
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

function normalizeSearchQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  return `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
