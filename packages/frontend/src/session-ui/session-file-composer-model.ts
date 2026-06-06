import { File, FileText, Folder } from 'lucide-react';
import React from 'react';
import type { ProjectFile, WorkspaceSearchResult } from '../lib/types';
import type { Segment, TriggerSuggestion } from '../components/prompt-area/types';
import { segmentsToPlainText } from '../components/prompt-area/prompt-area-engine';

type SessionLibraryFileSourceType = Extract<ProjectFile['source_type'], 'uploaded_file' | 'agent_document'>;

export type SessionComposerSubmit = {
  content: string;
  workspaceFileRefs?: string[];
  libraryFileRefs?: string[];
};

export type SessionFileReferenceChip =
  | {
      kind: 'workspace';
      path: string;
      name: string;
      entryType: 'file' | 'directory';
    }
  | {
      kind: 'library';
      fileId: string;
      name: string;
      sourceType: SessionLibraryFileSourceType;
      mimeType: string;
      size: number;
    };

export function buildSessionFileSuggestions(input: {
  workspace: WorkspaceSearchResult[];
  library: ProjectFile[];
}): TriggerSuggestion[] {
  const workspaceSuggestions = input.workspace.slice(0, 6).map((entry): TriggerSuggestion => ({
    value: `workspace:${entry.path}`,
    label: entry.name,
    description: entry.path,
    icon: entry.type === 'directory'
      ? React.createElement(Folder, { className: 'h-3.5 w-3.5 text-amber-500', strokeWidth: 1.8 })
      : React.createElement(File, { className: 'h-3.5 w-3.5 text-emerald-500', strokeWidth: 1.8 }),
    groupLabel: 'Source',
    data: {
      kind: 'workspace',
      path: entry.path,
      name: entry.name,
      entryType: entry.type,
    } satisfies SessionFileReferenceChip,
  }));

  const librarySuggestions = input.library
    .filter((file): file is ProjectFile & { source_type: SessionLibraryFileSourceType } =>
      file.source_type === 'uploaded_file' || file.source_type === 'agent_document')
    .slice(0, 6)
    .map((file): TriggerSuggestion => ({
      value: `library:${file.id}`,
      label: file.original_name,
      description: file.source_type === 'agent_document' ? '智能体文档' : formatProjectFileDescription(file),
      icon: React.createElement(FileText, { className: 'h-3.5 w-3.5 text-blue-500', strokeWidth: 1.8 }),
      groupLabel: 'Library',
      data: {
        kind: 'library',
        fileId: file.id,
        name: file.original_name,
        sourceType: file.source_type,
        mimeType: file.mime_type,
        size: file.size,
      } satisfies SessionFileReferenceChip,
    }));

  return [...workspaceSuggestions, ...librarySuggestions];
}

export function collectSessionFileRefsFromSegments(segments: Segment[]): {
  workspaceFileRefs: string[];
  libraryFileRefs: string[];
} {
  const workspaceFileRefs: string[] = [];
  const libraryFileRefs: string[] = [];

  for (const segment of segments) {
    if (segment.type !== 'chip' || segment.trigger !== '@') continue;
    const data = segment.data;
    if (!isSessionFileReferenceChip(data)) continue;
    if (data.kind === 'workspace') workspaceFileRefs.push(data.path);
    if (data.kind === 'library') libraryFileRefs.push(data.fileId);
  }

  return {
    workspaceFileRefs: [...new Set(workspaceFileRefs)],
    libraryFileRefs: [...new Set(libraryFileRefs)],
  };
}

export function isSessionFileReferenceChip(value: unknown): value is SessionFileReferenceChip {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'workspace') {
    return typeof record.path === 'string' &&
      typeof record.name === 'string' &&
      (record.entryType === 'file' || record.entryType === 'directory');
  }
  if (record.kind === 'library') {
    return typeof record.fileId === 'string' &&
      typeof record.name === 'string' &&
      (record.sourceType === 'uploaded_file' || record.sourceType === 'agent_document') &&
      typeof record.mimeType === 'string' &&
      typeof record.size === 'number';
  }
  return false;
}

export function buildSessionComposerSubmit(segments: Segment[]): SessionComposerSubmit | null {
  const content = segmentsToPlainText(segments).trim();
  if (!content) return null;
  const refs = collectSessionFileRefsFromSegments(segments);
  return {
    content,
    workspaceFileRefs: refs.workspaceFileRefs,
    libraryFileRefs: refs.libraryFileRefs,
  };
}

function formatProjectFileDescription(file: ProjectFile): string {
  const size = file.size > 0 ? `${Math.ceil(file.size / 1024)}KB` : '0KB';
  return `${file.mime_type} · ${size}`;
}
