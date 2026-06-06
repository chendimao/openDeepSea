import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionComposerSubmit,
  buildSessionFileSuggestions,
  collectSessionFileRefsFromSegments,
  type SessionFileReferenceChip,
} from './session-file-composer-model';
import type { ProjectFile, WorkspaceSearchResult } from '../lib/types';
import type { Segment } from '../components/prompt-area/types';

test('buildSessionFileSuggestions groups source and library results', () => {
  const workspace: WorkspaceSearchResult[] = [
    { path: 'packages/frontend/src/session-ui/SessionShellView.tsx', name: 'SessionShellView.tsx', type: 'file' },
  ];
  const library: ProjectFile[] = [
    createProjectFile({ id: 'asset:doc-1', original_name: 'session-design.md', source_type: 'agent_document' }),
  ];

  const suggestions = buildSessionFileSuggestions({ workspace, library });

  assert.equal(suggestions[0]?.groupLabel, 'Source');
  assert.equal(suggestions[0]?.value, 'workspace:packages/frontend/src/session-ui/SessionShellView.tsx');
  assert.equal(suggestions[1]?.groupLabel, 'Library');
  assert.equal(suggestions[1]?.value, 'library:asset:doc-1');
});

test('collectSessionFileRefsFromSegments extracts only valid session file chips', () => {
  const workspaceChip: SessionFileReferenceChip = {
    kind: 'workspace',
    path: 'packages/frontend/src/session-ui/SessionShellView.tsx',
    name: 'SessionShellView.tsx',
    entryType: 'file',
  };
  const libraryChip: SessionFileReferenceChip = {
    kind: 'library',
    fileId: 'asset:doc-1',
    name: 'session-design.md',
    sourceType: 'agent_document',
    mimeType: 'text/markdown',
    size: 120,
  };
  const segments: Segment[] = [
    { type: 'text', text: '请结合 ' },
    {
      type: 'chip',
      trigger: '@',
      value: 'workspace:packages/frontend/src/session-ui/SessionShellView.tsx',
      displayText: 'SessionShellView.tsx',
      data: workspaceChip,
    },
    { type: 'text', text: ' 和 ' },
    { type: 'chip', trigger: '@', value: 'library:asset:doc-1', displayText: 'session-design.md', data: libraryChip },
    { type: 'chip', trigger: '@', value: 'plain', displayText: 'plain', data: { kind: 'unknown' } },
  ];

  assert.deepEqual(collectSessionFileRefsFromSegments(segments), {
    workspaceFileRefs: ['packages/frontend/src/session-ui/SessionShellView.tsx'],
    libraryFileRefs: ['asset:doc-1'],
  });
});

test('buildSessionComposerSubmit serializes text and selected file refs', () => {
  const segments: Segment[] = [
    { type: 'text', text: '请分析 ' },
    {
      type: 'chip',
      trigger: '@',
      value: 'workspace:src/app.ts',
      displayText: 'app.ts',
      data: {
        kind: 'workspace',
        path: 'src/app.ts',
        name: 'app.ts',
        entryType: 'file',
      } satisfies SessionFileReferenceChip,
    },
    { type: 'text', text: ' 的实现' },
  ];

  assert.deepEqual(buildSessionComposerSubmit(segments), {
    content: '请分析 @app.ts 的实现',
    workspaceFileRefs: ['src/app.ts'],
    libraryFileRefs: [],
  });
});

function createProjectFile(input: Partial<ProjectFile> & Pick<ProjectFile, 'id' | 'original_name' | 'source_type'>): ProjectFile {
  return {
    id: input.id,
    project_id: input.project_id ?? 'project-1',
    source_type: input.source_type,
    original_name: input.original_name,
    stored_name: input.stored_name ?? input.original_name,
    mime_type: input.mime_type ?? (input.source_type === 'agent_document' ? 'text/markdown' : 'text/plain'),
    size: input.size ?? 100,
    url: input.url ?? '/files/session-design.md',
    storage_path: input.storage_path ?? '',
    uploaded_by_id: input.uploaded_by_id ?? null,
    uploaded_by_name: input.uploaded_by_name ?? null,
    source_message_id: input.source_message_id ?? null,
    source_room_id: input.source_room_id ?? null,
    source_agent_id: input.source_agent_id ?? null,
    source_task_id: input.source_task_id ?? null,
    content: input.content ?? null,
    created_at: input.created_at ?? 1,
    deleted_at: input.deleted_at ?? null,
    reference_count: input.reference_count ?? 0,
    last_referenced_at: input.last_referenced_at ?? null,
    last_referenced_message_id: input.last_referenced_message_id ?? null,
    last_referenced_room_id: input.last_referenced_room_id ?? null,
    last_referenced_room_name: input.last_referenced_room_name ?? null,
  };
}
