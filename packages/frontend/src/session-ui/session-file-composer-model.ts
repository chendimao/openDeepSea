import { File, FileText, Folder } from 'lucide-react';
import React from 'react';
import type { PlatformSkill, PlatformSkillRef, ProjectFile, WorkspaceSearchResult } from '../lib/types';
import { formatFileSize } from '../lib/composerModel';
import type { Segment, TriggerSuggestion } from '../components/prompt-area/types';
import { segmentsToPlainText } from '../components/prompt-area/prompt-area-engine';

type SessionLibraryFileSourceType = Extract<ProjectFile['source_type'], 'uploaded_file' | 'agent_document'>;

export type SessionComposerSubmit = {
  content: string;
  workspaceFileRefs?: string[];
  libraryFileRefs?: string[];
  platformSkillRefs?: PlatformSkillRef[];
};

export type ComposerAttachmentPreviewKind = 'image' | 'text' | 'file';

export type ComposerAttachmentFileLike = {
  name: string;
  size: number;
  type?: string;
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
    title: entry.path,
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
      title: formatProjectFileTitle(file),
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

export function buildSessionComposerSubmitFromText(input: {
  content: string;
  workspaceFileRefs?: string[];
  libraryFileRefs?: string[];
  uploadedFiles?: ProjectFile[];
  platformSkills?: PlatformSkill[];
}): SessionComposerSubmit | null {
  const platformSkillExtraction = extractPlatformSkillRefsFromText(input.content, input.platformSkills ?? []);
  const content = platformSkillExtraction.content.trim();
  const workspaceFileRefs = dedupeStrings(input.workspaceFileRefs ?? []);
  const libraryFileRefs = dedupeStrings([
    ...(input.libraryFileRefs ?? []),
    ...collectProjectFileIds(input.uploadedFiles ?? []),
  ]);
  if (
    !content &&
    workspaceFileRefs.length === 0 &&
    libraryFileRefs.length === 0 &&
    platformSkillExtraction.platformSkillRefs.length === 0
  ) return null;
  return {
    content,
    workspaceFileRefs,
    libraryFileRefs,
    ...(platformSkillExtraction.platformSkillRefs.length > 0
      ? { platformSkillRefs: platformSkillExtraction.platformSkillRefs }
      : {}),
  };
}

export function extractPlatformSkillRefsFromText(content: string, platformSkills: PlatformSkill[]): {
  content: string;
  platformSkillRefs: PlatformSkillRef[];
} {
  if (platformSkills.length === 0) {
    return { content: content.trim(), platformSkillRefs: [] };
  }

  const byName = new Map<string, PlatformSkill>();
  for (const skill of platformSkills) {
    if (!skill.valid) continue;
    byName.set(skill.name.toLowerCase(), skill);
  }
  if (byName.size === 0) {
    return { content: content.trim(), platformSkillRefs: [] };
  }

  const refs: PlatformSkillRef[] = [];
  const seen = new Set<string>();
  const cleaned = content.replace(/(^|[\s([{，。！？、])\$([A-Za-z0-9._:-]+)/gu, (match, prefix: string, rawName: string) => {
    const skill = byName.get(rawName.toLowerCase());
    if (!skill) return match;
    const key = `${skill.provider}:${skill.name.toLowerCase()}`;
    if (!seen.has(key)) {
      refs.push({ provider: skill.provider, name: skill.name });
      seen.add(key);
    }
    return prefix;
  });

  return {
    content: cleaned.trim(),
    platformSkillRefs: refs,
  };
}

export function collectProjectFileIds(files: ProjectFile[]): string[] {
  return dedupeStrings(files.map((file) => file.id));
}

export function buildAttachmentPreviewKind(file: Pick<ComposerAttachmentFileLike, 'name' | 'type'>): ComposerAttachmentPreviewKind {
  const type = (file.type ?? '').toLowerCase();
  const extension = getFileExtension(file.name);
  if (type.startsWith('image/')) return 'image';
  if (
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('yaml') ||
    ['csv', 'js', 'jsx', 'md', 'mdx', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml'].includes(extension)
  ) {
    return 'text';
  }
  return 'file';
}

export function formatComposerAttachmentMeta(file: ComposerAttachmentFileLike): string {
  return [
    getFileExtension(file.name).toUpperCase() || null,
    formatFileSize(file.size),
    file.type?.trim() || null,
  ].filter(Boolean).join(' · ');
}

export function getComposerAttachmentInteractionState(input: { isUploading: boolean }): {
  canPreview: boolean;
  canRemove: boolean;
} {
  return {
    canPreview: !input.isUploading,
    canRemove: !input.isUploading,
  };
}

function formatProjectFileDescription(file: ProjectFile): string {
  const size = file.size > 0 ? `${Math.ceil(file.size / 1024)}KB` : '0KB';
  return `${file.mime_type} · ${size}`;
}

function formatProjectFileTitle(file: ProjectFile): string {
  const path = file.storage_path?.trim() || file.url?.trim() || file.stored_name.trim() || file.original_name;
  return path.includes(file.original_name) ? path : `${path} · ${file.original_name}`;
}

function getFileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index === -1 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
