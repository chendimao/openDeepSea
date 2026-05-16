import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type { ProjectFile, ProjectFileWithRefs } from '../types.js';

export const fileRepo = {
  listByProject(projectId: string): ProjectFileWithRefs[] {
    return db
      .prepare(
        `SELECT
          files.*,
          COUNT(message_file_refs.id) AS reference_count,
          MAX(message_file_refs.created_at) AS last_referenced_at,
          (
            SELECT refs.room_id
            FROM message_file_refs refs
            WHERE refs.file_id = files.id
            ORDER BY refs.created_at DESC
            LIMIT 1
          ) AS last_referenced_room_id,
          (
            SELECT rooms.name
            FROM message_file_refs refs
            JOIN rooms ON rooms.id = refs.room_id
            WHERE refs.file_id = files.id
            ORDER BY refs.created_at DESC
            LIMIT 1
          ) AS last_referenced_room_name
        FROM files
        LEFT JOIN message_file_refs ON message_file_refs.file_id = files.id
        WHERE files.project_id = ? AND files.deleted_at IS NULL
        GROUP BY files.id
        ORDER BY files.created_at DESC`,
      )
      .all(projectId) as ProjectFileWithRefs[];
  },

  get(id: string): ProjectFile | undefined {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as ProjectFile | undefined;
  },

  create(input: Omit<ProjectFile, 'id' | 'created_at' | 'deleted_at'>): ProjectFile {
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

  softDelete(id: string): ProjectFile | undefined {
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
        `SELECT * FROM files
         WHERE project_id = ?
           AND deleted_at IS NULL
           AND id IN (${placeholders})
         ORDER BY created_at DESC`,
      )
      .all(projectId, ...uniqueIds) as ProjectFile[];
  },
};
