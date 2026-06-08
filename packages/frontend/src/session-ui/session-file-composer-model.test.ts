import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAttachmentPreviewKind,
  buildSessionComposerSubmitFromText,
  buildSessionComposerSubmit,
  buildSessionFileSuggestions,
  collectProjectFileIds,
  collectSessionFileRefsFromSegments,
  formatComposerAttachmentMeta,
  getComposerAttachmentInteractionState,
  type SessionFileReferenceChip,
} from './session-file-composer-model';
import type { PlatformSkill, ProjectFile, WorkspaceSearchResult } from '../lib/types';
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
  assert.equal(suggestions[0]?.title, 'packages/frontend/src/session-ui/SessionShellView.tsx');
  assert.equal(suggestions[1]?.groupLabel, 'Library');
  assert.equal(suggestions[1]?.value, 'library:asset:doc-1');
  assert.equal(suggestions[1]?.title, '/files/session-design.md');
});

test('buildSessionFileSuggestions exposes uploaded file path and original name as tooltip title', () => {
  const suggestions = buildSessionFileSuggestions({
    workspace: [],
    library: [
      createProjectFile({
        id: 'file:upload-1',
        original_name: 'brief.pdf',
        stored_name: 'stored.pdf',
        source_type: 'uploaded_file',
        storage_path: '/tmp/opendeepsea/project-1/stored.pdf',
      }),
    ],
  });

  assert.equal(suggestions[0]?.title, '/tmp/opendeepsea/project-1/stored.pdf · brief.pdf');
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

test('buildSessionComposerSubmitFromText serializes text and uploaded project file refs', () => {
  assert.deepEqual(buildSessionComposerSubmitFromText({
    content: '  分析附件  ',
    uploadedFiles: [
      createProjectFile({ id: 'file:upload-1', original_name: 'notes.md', source_type: 'uploaded_file' }),
      createProjectFile({ id: 'file:upload-1', original_name: 'notes.md', source_type: 'uploaded_file' }),
      createProjectFile({ id: 'asset:doc-1', original_name: 'handoff.md', source_type: 'agent_document' }),
    ],
  }), {
    content: '分析附件',
    workspaceFileRefs: [],
    libraryFileRefs: ['file:upload-1', 'asset:doc-1'],
  });
});

test('buildSessionComposerSubmitFromText extracts planner platform skill refs from dollar tokens', () => {
  assert.deepEqual(buildSessionComposerSubmitFromText({
    content: '  $frontend-design 优化 SessionFileComposer，并再次使用 $FRONTEND-DESIGN  ',
    platformSkills: [
      createPlatformSkill({ provider: 'codex', name: 'frontend-design', description: 'Frontend workflow.' }),
      createPlatformSkill({ provider: 'opencode', name: 'backend', description: 'Wrong backend.' }),
    ],
  }), {
    content: '优化 SessionFileComposer，并再次使用',
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [{ provider: 'codex', name: 'frontend-design' }],
  });
});

test('buildSessionComposerSubmitFromText preserves user formatting while removing dollar skill tokens', () => {
  assert.deepEqual(buildSessionComposerSubmitFromText({
    content: '$frontend-design\n请保留代码缩进：\n  const value  = 1;',
    platformSkills: [
      createPlatformSkill({ provider: 'codex', name: 'frontend-design', description: 'Frontend workflow.' }),
    ],
  }), {
    content: '请保留代码缩进：\n  const value  = 1;',
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [{ provider: 'codex', name: 'frontend-design' }],
  });
});

test('buildSessionComposerSubmitFromText serializes selected platform skill chips', () => {
  assert.deepEqual(buildSessionComposerSubmitFromText({
    content: '   ',
    selectedPlatformSkillRefs: [
      { provider: 'codex', name: 'frontend-design' },
      { provider: 'codex', name: 'FRONTEND-DESIGN' },
      { provider: 'codex', name: 'playwright-cli' },
    ],
  }), {
    content: '',
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [
      { provider: 'codex', name: 'frontend-design' },
      { provider: 'codex', name: 'playwright-cli' },
    ],
  });
});

test('buildSessionComposerSubmitFromText merges selected platform skill chips with typed dollar tokens', () => {
  assert.deepEqual(buildSessionComposerSubmitFromText({
    content: '$frontend-design 调整输入框',
    platformSkills: [
      createPlatformSkill({ provider: 'codex', name: 'frontend-design', description: 'Frontend workflow.' }),
      createPlatformSkill({ provider: 'codex', name: 'playwright-cli', description: 'Browser workflow.' }),
    ],
    selectedPlatformSkillRefs: [{ provider: 'codex', name: 'playwright-cli' }],
  }), {
    content: '调整输入框',
    workspaceFileRefs: [],
    libraryFileRefs: [],
    platformSkillRefs: [
      { provider: 'codex', name: 'playwright-cli' },
      { provider: 'codex', name: 'frontend-design' },
    ],
  });
});

test('buildSessionComposerSubmitFromText allows attachment-only messages', () => {
  assert.deepEqual(buildSessionComposerSubmitFromText({
    content: '   ',
    uploadedFiles: [
      createProjectFile({ id: 'file:image-1', original_name: 'screen.png', source_type: 'uploaded_file', mime_type: 'image/png' }),
    ],
  }), {
    content: '',
    workspaceFileRefs: [],
    libraryFileRefs: ['file:image-1'],
  });

  assert.equal(buildSessionComposerSubmitFromText({ content: '   ', uploadedFiles: [] }), null);
});

test('attachment helpers identify preview kind and project file ids', () => {
  assert.equal(buildAttachmentPreviewKind({ name: 'screen.png', type: 'image/png' }), 'image');
  assert.equal(buildAttachmentPreviewKind({ name: 'notes.md', type: 'text/markdown' }), 'text');
  assert.equal(buildAttachmentPreviewKind({ name: 'data.json', type: 'application/json' }), 'text');
  assert.equal(buildAttachmentPreviewKind({ name: 'archive.zip', type: 'application/zip' }), 'file');
  assert.equal(formatComposerAttachmentMeta({ name: 'notes.md', size: 1536, type: 'text/markdown' }), 'MD · 1.5 KB · text/markdown');
  assert.deepEqual(collectProjectFileIds([
    createProjectFile({ id: 'file:upload-1', original_name: 'notes.md', source_type: 'uploaded_file' }),
    createProjectFile({ id: 'file:upload-1', original_name: 'notes.md', source_type: 'uploaded_file' }),
    createProjectFile({ id: 'asset:doc-1', original_name: 'handoff.md', source_type: 'agent_document' }),
  ]), ['file:upload-1', 'asset:doc-1']);
});

test('composer attachment controls are locked while uploading', () => {
  assert.deepEqual(getComposerAttachmentInteractionState({ isUploading: false }), {
    canPreview: true,
    canRemove: true,
  });
  assert.deepEqual(getComposerAttachmentInteractionState({ isUploading: true }), {
    canPreview: false,
    canRemove: false,
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

function createPlatformSkill(input: Pick<PlatformSkill, 'provider' | 'name' | 'description'>): PlatformSkill {
  return {
    provider: input.provider,
    name: input.name,
    description: input.description,
    path: `/skills/${input.name}`,
    manifestPath: `/skills/${input.name}/SKILL.md`,
    installMode: 'copy',
    sourceLabel: null,
    version: null,
    lastModifiedAt: 1,
    valid: true,
    issues: [],
  };
}
