import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import { resourceAssetRepo } from './resource-assets.js';
import type { ProjectFile, ProjectFileCreateInput, ProjectFileWithRefs, ResourceAssetType } from '../types.js';

interface FileListFilters {
  projectId?: string;
  roomId?: string;
  sourceType?: ResourceAssetType;
  query?: string;
}

interface AgentDocumentCreateInput {
  project_id: string;
  title: string;
  content: string;
  source_message_id?: string | null;
  source_room_id?: string | null;
  source_agent_id?: string | null;
  source_task_id?: string | null;
}

export const fileRepo = {
  list(filters: FileListFilters = {}): ProjectFileWithRefs[] {
    const includeUploadedFiles = !filters.sourceType || filters.sourceType === 'uploaded_file';
    const includeAgentDocuments = !filters.sourceType || filters.sourceType === 'agent_document';
    const files = includeUploadedFiles ? listUploadedFiles(filters) : [];
    const agentDocuments = includeAgentDocuments ? listAgentDocuments(filters) : [];
    return [...files, ...agentDocuments].sort((a, b) => b.created_at - a.created_at);
  },

  listByProject(projectId: string, filters: Omit<FileListFilters, 'projectId'> = {}): ProjectFileWithRefs[] {
    return this.list({ ...filters, projectId });
  },

  get(id: string): ProjectFile | undefined {
    if (id.startsWith('asset:')) return getAgentDocument(id.slice('asset:'.length));
    return db.prepare(
      `SELECT
        files.*,
        'uploaded_file' AS source_type,
        NULL AS source_message_id,
        NULL AS source_room_id,
        NULL AS source_agent_id,
        NULL AS source_task_id,
        COALESCE(NULLIF(uploaded_by_name, ''), '用户上传') AS source_display_name,
        '用户上传' AS source_label,
        NULL AS source_context_id,
        NULL AS source_context_name,
        NULL AS source_context_type,
        NULL AS content
       FROM files
       WHERE id = ?`,
    ).get(id) as ProjectFile | undefined;
  },

  create(input: ProjectFileCreateInput): ProjectFile {
    const id = nanoid(16);
    db.prepare(
      `INSERT INTO files (
        id, project_id, original_name, stored_name, mime_type, size, url, storage_path,
        uploaded_by_id, uploaded_by_name, created_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      input.project_id,
      input.original_name,
      input.stored_name,
      input.mime_type,
      input.size,
      input.url,
      input.storage_path,
      input.uploaded_by_id,
      input.uploaded_by_name,
      now(),
    );
    return this.get(id)!;
  },

  createAgentDocument(input: AgentDocumentCreateInput): ProjectFile {
    const asset = resourceAssetRepo.ensure({
      project_id: input.project_id,
      asset_type: 'agent_document',
      group_key: 'agent_documents',
      title: input.title,
      content: input.content,
      mime_type: 'text/markdown',
      size: Buffer.byteLength(input.content),
      source_message_id: input.source_message_id ?? null,
      source_room_id: input.source_room_id ?? null,
      source_agent_id: input.source_agent_id ?? null,
      source_task_id: input.source_task_id ?? null,
      unique_source_message_id: input.source_message_id ?? null,
    });
    return this.get(`asset:${asset.id}`)!;
  },

  softDelete(id: string): ProjectFile | undefined {
    if (id.startsWith('asset:')) {
      db.prepare(
        'UPDATE resource_assets SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?',
      ).run(now(), now(), id.slice('asset:'.length));
      return this.get(id);
    }
    db.prepare('UPDATE files SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').run(now(), id);
    return this.get(id);
  },

  addMessageRefs(input: {
    project_id: string;
    room_id: string;
    message_id: string;
    file_ids: string[];
  }): void {
    const uniqueFileIds = [...new Set(input.file_ids)];
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO message_file_refs (id, project_id, room_id, message_id, file_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = db.transaction((fileIds: string[]) => {
      for (const fileId of fileIds) {
        stmt.run(nanoid(16), input.project_id, input.room_id, input.message_id, fileId, now());
      }
    });
    insertMany(uniqueFileIds);
  },

  listActiveByIds(projectId: string, ids: string[]): ProjectFile[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT
           *,
           'uploaded_file' AS source_type,
           NULL AS source_message_id,
           NULL AS source_room_id,
           NULL AS source_agent_id,
           NULL AS source_task_id,
           COALESCE(NULLIF(uploaded_by_name, ''), '用户上传') AS source_display_name,
           '用户上传' AS source_label,
           NULL AS source_context_id,
           NULL AS source_context_name,
           NULL AS source_context_type,
           NULL AS content
         FROM files
         WHERE project_id = ?
           AND deleted_at IS NULL
           AND id IN (${placeholders})
         ORDER BY created_at DESC`,
      )
      .all(projectId, ...uniqueIds) as ProjectFile[];
  },
};

function listUploadedFiles(filters: FileListFilters): ProjectFileWithRefs[] {
  const where = ['files.deleted_at IS NULL'];
  const params: { projectId?: string; roomId?: string; query?: string } = {};
  const roomReferenceFilter = filters.roomId ? ' AND refs.room_id = @roomId' : '';
  const joinRoomFilter = filters.roomId ? ' AND message_file_refs.room_id = @roomId' : '';
  if (filters.projectId) {
    where.push('files.project_id = @projectId');
    params.projectId = filters.projectId;
  }
  if (filters.roomId) {
    where.push(
      `EXISTS (
          SELECT 1
          FROM message_file_refs room_refs
          WHERE room_refs.file_id = files.id
            AND room_refs.room_id = @roomId
        )`,
    );
    params.roomId = filters.roomId;
  }
  const query = normalizeSearchQuery(filters.query);
  if (query) {
    where.push(
      `(
        files.original_name LIKE @query ESCAPE '\\'
        OR files.stored_name LIKE @query ESCAPE '\\'
        OR files.mime_type LIKE @query ESCAPE '\\'
        OR COALESCE(files.uploaded_by_name, '') LIKE @query ESCAPE '\\'
        OR COALESCE(files.uploaded_by_id, '') LIKE @query ESCAPE '\\'
        OR '用户上传' LIKE @query ESCAPE '\\'
      )`,
    );
    params.query = query;
  }

  const bindArgs = Object.keys(params).length > 0 ? [params] : [];

  return db
    .prepare(
      `SELECT
          files.*,
          'uploaded_file' AS source_type,
          NULL AS source_message_id,
          NULL AS source_room_id,
          NULL AS source_agent_id,
          NULL AS source_task_id,
          COALESCE(NULLIF(files.uploaded_by_name, ''), '用户上传') AS source_display_name,
          '用户上传' AS source_label,
          NULL AS source_context_id,
          NULL AS source_context_name,
          NULL AS source_context_type,
          NULL AS content,
          COUNT(message_file_refs.id) AS reference_count,
          MAX(message_file_refs.created_at) AS last_referenced_at,
          (
            SELECT refs.message_id
            FROM message_file_refs refs
            WHERE refs.file_id = files.id
              ${roomReferenceFilter}
            ORDER BY refs.created_at DESC
            LIMIT 1
          ) AS last_referenced_message_id,
          (
            SELECT refs.room_id
            FROM message_file_refs refs
            WHERE refs.file_id = files.id
              ${roomReferenceFilter}
            ORDER BY refs.created_at DESC
            LIMIT 1
          ) AS last_referenced_room_id,
          (
            SELECT rooms.name
            FROM message_file_refs refs
            JOIN rooms ON rooms.id = refs.room_id
            WHERE refs.file_id = files.id
              ${roomReferenceFilter}
            ORDER BY refs.created_at DESC
            LIMIT 1
          ) AS last_referenced_room_name
        FROM files
        LEFT JOIN message_file_refs ON message_file_refs.file_id = files.id${joinRoomFilter}
        WHERE ${where.join(' AND ')}
        GROUP BY files.id
        ORDER BY files.created_at DESC`,
    )
    .all(...bindArgs) as ProjectFileWithRefs[];
}

function listAgentDocuments(filters: FileListFilters): ProjectFileWithRefs[] {
  const where = [
    "resource_assets.asset_type = 'agent_document'",
    'resource_assets.deleted_at IS NULL',
  ];
  const params: { projectId?: string; roomId?: string; query?: string } = {};
  if (filters.projectId) {
    where.push('resource_assets.project_id = @projectId');
    params.projectId = filters.projectId;
  }
  if (filters.roomId) {
    where.push('resource_assets.source_room_id = @roomId');
    params.roomId = filters.roomId;
  }
  const query = normalizeSearchQuery(filters.query);
  if (query) {
    where.push(
      `(
        resource_assets.title LIKE @query ESCAPE '\\'
        OR COALESCE(resource_assets.mime_type, '') LIKE @query ESCAPE '\\'
        OR COALESCE(resource_assets.source_agent_id, '') LIKE @query ESCAPE '\\'
        OR COALESCE(messages.sender_name, '') LIKE @query ESCAPE '\\'
        OR COALESCE(resource_assets.content, '') LIKE @query ESCAPE '\\'
        OR COALESCE(rooms.name, '') LIKE @query ESCAPE '\\'
        OR '智能体生成' LIKE @query ESCAPE '\\'
      )`,
    );
    params.query = query;
  }
  const bindArgs = Object.keys(params).length > 0 ? [params] : [];

  return db.prepare(
    `SELECT
       'asset:' || resource_assets.id AS id,
       resource_assets.project_id,
       resource_assets.asset_type AS source_type,
       resource_assets.title AS original_name,
       resource_assets.title AS stored_name,
       COALESCE(resource_assets.mime_type, 'text/markdown') AS mime_type,
       COALESCE(resource_assets.size, LENGTH(COALESCE(resource_assets.content, ''))) AS size,
       COALESCE(resource_assets.url, '') AS url,
       '' AS storage_path,
       NULL AS uploaded_by_id,
       NULL AS uploaded_by_name,
       resource_assets.source_message_id,
       resource_assets.source_room_id,
       resource_assets.source_agent_id,
       resource_assets.source_task_id,
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
       END AS source_context_type,
       resource_assets.content,
       resource_assets.created_at,
       resource_assets.deleted_at,
       CASE WHEN resource_assets.source_message_id IS NULL THEN 0 ELSE 1 END AS reference_count,
       resource_assets.created_at AS last_referenced_at,
       resource_assets.source_message_id AS last_referenced_message_id,
       resource_assets.source_room_id AS last_referenced_room_id,
       rooms.name AS last_referenced_room_name
     FROM resource_assets
     LEFT JOIN messages ON messages.id = resource_assets.source_message_id
     LEFT JOIN rooms ON rooms.id = resource_assets.source_room_id
     LEFT JOIN tasks ON tasks.id = resource_assets.source_task_id
     WHERE ${where.join(' AND ')}
     ORDER BY resource_assets.created_at DESC`,
  ).all(...bindArgs) as ProjectFileWithRefs[];
}

function getAgentDocument(id: string): ProjectFile | undefined {
  return db.prepare(
    `SELECT
       'asset:' || resource_assets.id AS id,
       resource_assets.project_id,
       resource_assets.asset_type AS source_type,
       resource_assets.title AS original_name,
       resource_assets.title AS stored_name,
       COALESCE(resource_assets.mime_type, 'text/markdown') AS mime_type,
       COALESCE(resource_assets.size, LENGTH(COALESCE(resource_assets.content, ''))) AS size,
       COALESCE(resource_assets.url, '') AS url,
       '' AS storage_path,
       NULL AS uploaded_by_id,
       NULL AS uploaded_by_name,
       resource_assets.source_message_id,
       resource_assets.source_room_id,
       resource_assets.source_agent_id,
       resource_assets.source_task_id,
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
       END AS source_context_type,
       resource_assets.content,
       resource_assets.created_at,
       resource_assets.deleted_at
     FROM resource_assets
     LEFT JOIN messages ON messages.id = resource_assets.source_message_id
     LEFT JOIN rooms ON rooms.id = resource_assets.source_room_id
     LEFT JOIN tasks ON tasks.id = resource_assets.source_task_id
     WHERE resource_assets.id = ?
       AND resource_assets.asset_type = 'agent_document'`,
  ).get(id) as ProjectFile | undefined;
}

function normalizeSearchQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  return `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
