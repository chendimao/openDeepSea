import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ImageJobFormView,
  buildImageJobPayload,
  createEmptyImageJobFormState,
} from './ImageJobForm';
import { filterImageSourceFiles } from './SourceImagePicker';
import type { ProjectFile } from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

test('image job form disables submit for image-to-image without source files', () => {
  const state = {
    ...createEmptyImageJobFormState(),
    workflow: 'image-to-image' as const,
    prompt: '基于源图生成变体',
  };

  const html = renderWithQueryClient(
    <ImageJobFormView
      projectId="project-1"
      state={state}
      busy={false}
      error={null}
      onStateChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );

  assert.match(html, /生成图片/);
  assert.match(html, /disabled=""/);
});

test('image job payload trims prompt and includes selected source file ids only for image-to-image', () => {
  const payload = buildImageJobPayload({
    workflow: 'image-to-image',
    prompt: '  生成赛博风格海报  ',
    sourceFiles: [
      createProjectFile({ id: 'file-1', original_name: 'source.png', mime_type: 'image/png' }),
      createProjectFile({ id: 'file-2', original_name: 'source.jpg', mime_type: 'image/jpeg' }),
    ],
    count: 2,
    quality: 'high',
    size: '1024x1024',
  });

  assert.deepEqual(payload, {
    workflow: 'image-to-image',
    prompt: '生成赛博风格海报',
    count: 2,
    quality: 'high',
    size: '1024x1024',
    source_file_ids: ['file-1', 'file-2'],
  });
});

test('source image picker filters uploaded image files', () => {
  const files = [
    createProjectFile({ id: 'image-1', original_name: 'image.png', mime_type: 'image/png' }),
    createProjectFile({ id: 'doc-1', original_name: 'notes.txt', mime_type: 'text/plain' }),
  ];

  assert.deepEqual(filterImageSourceFiles(files).map((file) => file.id), ['image-1']);
});

function createProjectFile(input: Partial<ProjectFile> & Pick<ProjectFile, 'id' | 'original_name' | 'mime_type'>): ProjectFile {
  return {
    project_id: 'project-1',
    source_type: 'uploaded_file',
    stored_name: input.original_name,
    size: 1,
    url: `/uploads/${input.id}`,
    uploaded_by_id: null,
    uploaded_by_name: null,
    source_message_id: null,
    source_room_id: null,
    source_agent_id: null,
    source_task_id: null,
    content: null,
    created_at: 1,
    deleted_at: null,
    reference_count: 0,
    last_referenced_at: null,
    last_referenced_message_id: null,
    last_referenced_room_id: null,
    last_referenced_room_name: null,
    ...input,
  };
}

function renderWithQueryClient(node: React.ReactElement): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      {node}
    </QueryClientProvider>,
  );
}
