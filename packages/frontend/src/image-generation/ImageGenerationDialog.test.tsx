import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ImageGenerationDialogView,
  buildSessionImageJobPayload,
  createSessionImageDialogState,
} from './ImageGenerationDialog';
import {
  ImageJobStatusCardView,
  parseImageGenerationJobIdFromMetadata,
} from './ImageJobStatusCard';
import { SessionFileComposer } from '../session-ui/SessionFileComposer';
import { I18nProvider } from '../lib/i18n';
import type { ImageJobDetailResponse, ProjectFile } from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
  configurable: true,
});

test('session image generation payload includes the active session id', () => {
  const source = createProjectFile({ id: 'source-file-1', original_name: 'source.png', mime_type: 'image/png' });
  const payload = buildSessionImageJobPayload({
    ...createSessionImageDialogState(),
    workflow: 'image-to-image',
    prompt: '  生成一张产品海报  ',
    sourceFiles: [source],
    count: 2,
    quality: 'high',
    size: '1024x1024',
  }, 'session-1');

  assert.deepEqual(payload, {
    session_id: 'session-1',
    workflow: 'image-to-image',
    prompt: '生成一张产品海报',
    count: 2,
    quality: 'high',
    size: '1024x1024',
    source_file_ids: ['source-file-1'],
  });
});

test('session image generation dialog view renders compact generation controls', () => {
  const html = renderWithQueryClient(
    <ImageGenerationDialogView
      projectId="project-1"
      state={createSessionImageDialogState()}
      busy={false}
      error={null}
      onStateChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );

  assert.match(html, /aria-label="会话图片生成表单"/);
  assert.match(html, /文生图/);
  assert.match(html, /图生图/);
  assert.match(html, /生成图片/);
});

test('session image generation dialog exposes the backend-supported count maximum', () => {
  const html = renderWithQueryClient(
    <ImageGenerationDialogView
      projectId="project-1"
      state={createSessionImageDialogState()}
      busy={false}
      error={null}
      onStateChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );

  assert.match(html, /max="6"/);
});

test('session composer exposes an image generation icon button', () => {
  const html = renderWithQueryClient(
    <SessionFileComposer
      projectId="project-1"
      sessionId="session-1"
      onSendMessage={() => undefined}
    />,
  );

  assert.match(html, /aria-label="生成图片"/);
});

test('image job metadata parser extracts only valid image job ids', () => {
  assert.equal(
    parseImageGenerationJobIdFromMetadata(JSON.stringify({ image_generation_job_id: 'job-1' })),
    'job-1',
  );
  assert.equal(parseImageGenerationJobIdFromMetadata('{}'), null);
  assert.equal(parseImageGenerationJobIdFromMetadata('not-json'), null);
});

test('image job status card view renders status actions and generated thumbnails', () => {
  const html = renderToStaticMarkup(
    <ImageJobStatusCardView
      projectId="project-1"
      detail={createImageJobDetail({ status: 'failed', error: 'provider failed' })}
      busy={false}
      onCancel={() => undefined}
      onRetry={() => undefined}
    />,
  );

  assert.match(html, /会话图片任务/);
  assert.match(html, /失败/);
  assert.match(html, /provider failed/);
  assert.match(html, /重试/);
  assert.match(html, /href="\/projects\/project-1\/images"/);
  assert.match(html, /src="\/uploads\/generated\.png"/);
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

function createImageJobDetail(overrides: Partial<ImageJobDetailResponse['job']> = {}): ImageJobDetailResponse {
  return {
    job: {
      id: 'job-1',
      project_id: 'project-1',
      room_id: null,
      session_id: 'session-1',
      source_message_id: null,
      source_agent_id: null,
      source_task_id: null,
      provider_profile_id: 'profile-1',
      workflow: 'generate',
      prompt: '生成一张会话配图',
      count: 1,
      quality: 'auto',
      size: 'auto',
      status: 'completed',
      message: null,
      error: null,
      created_at: 1,
      started_at: 2,
      completed_at: 3,
      updated_at: 3,
      ...overrides,
    },
    outputs: [{
      id: 'output-1',
      job_id: 'job-1',
      file_id: 'file-1',
      slot: 1,
      name: 'generated.png',
      url: '/uploads/generated.png',
      mime_type: 'image/png',
      size: 42,
      width: 1024,
      height: 1024,
      created_at: 3,
    }],
    source_images: [],
  };
}

function renderWithQueryClient(node: React.ReactElement): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>
    </I18nProvider>,
  );
}
