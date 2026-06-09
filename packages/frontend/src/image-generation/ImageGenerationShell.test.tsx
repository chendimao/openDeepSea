import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ImageGenerationShell,
  buildWorkbenchImageJobPayload,
  canSubmitWorkbenchImageJob,
  collectResultOutputIds,
  detailsToResultGroups,
  type FormState,
} from './ImageGenerationShell';
import type {
  ImageGenerationJob,
  ImageGenerationOutput,
  ImageProviderProfile,
  ProjectFile,
} from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

test('image workbench shell renders the high density command center regions', () => {
  const html = renderImageGenerationShell('project-1');

  assert.match(html, /aria-labelledby="image-generation-config-heading"/);
  assert.match(html, /id="image-generation-config-heading"/);
  assert.match(html, /aria-labelledby="image-generation-jobs-heading"/);
  assert.match(html, /id="image-generation-jobs-heading"/);
  assert.match(html, /aria-labelledby="image-generation-gallery-heading"/);
  assert.match(html, /id="image-generation-gallery-heading"/);
  assert.match(html, /data-purpose="image-workbench-right-inspector"/);
  assert.match(html, /data-purpose="image-workbench-status-footer"/);
});

test('image workbench shell keeps the project context visible', () => {
  const html = renderImageGenerationShell('project-1');

  assert.match(html, /data-project-id="project-1"/);
  assert.match(html, /project:<span class="text-\[#64748b\]">project-1<\/span>/);
  assert.match(html, /模型配置/);
  assert.match(html, /立即配置模型/);
  assert.doesNotMatch(html, /保存配置/);
  assert.match(html, /文生图/);
  assert.match(html, /图生图/);
  assert.match(html, /任务队列/);
  assert.match(html, /生成结果/);
  assert.match(html, /历史记录/);
  assert.doesNotMatch(html, /点击或拖拽上传参考图/);
});

test('image workbench shell does not duplicate the Stitch private header', () => {
  const html = renderImageGenerationShell('project-1');

  assert.doesNotMatch(html, /API 余额充足/);
  assert.doesNotMatch(html, /32,680 \/ 50,000 tokens/);
});

test('image workbench shell omits the local icon navigation rail', () => {
  const html = renderImageGenerationShell('project-1');

  assert.doesNotMatch(html, /aria-label="图片工作台导航"/);
});

test('image workbench payload supports image-to-image source files and provider profile', () => {
  const form = createWorkbenchForm({
    workflow: 'image-to-image',
    prompt: '  生成海底指挥中心  ',
    style: 'cinematic',
    negativePrompt: '低清晰度',
    sourceFiles: [
      createProjectFile({ id: 'file:file-1', original_name: 'source-a.png', mime_type: 'image/png' }),
      createProjectFile({ id: 'file-2', original_name: 'source-b.webp', mime_type: 'image/webp' }),
    ],
  });

  assert.deepEqual(buildWorkbenchImageJobPayload(form, 'profile-1'), {
    provider_profile_id: 'profile-1',
    workflow: 'image-to-image',
    prompt: '生成海底指挥中心\n\n风格偏好: 电影感 Cinematic\n\n避免出现: 低清晰度',
    count: 2,
    quality: 'high',
    size: '1792x1024',
    source_file_ids: ['file-1', 'file-2'],
  });
  assert.equal(canSubmitWorkbenchImageJob(form), true);
});

test('image workbench requires source files before submitting image-to-image', () => {
  assert.equal(canSubmitWorkbenchImageJob(createWorkbenchForm({
    workflow: 'image-to-image',
    prompt: '生成变体',
    sourceFiles: [],
  })), false);
});

test('image workbench result groups preserve output ids and profile-specific model labels', () => {
  const groups = detailsToResultGroups([
    {
      job: createImageJob({ id: 'job-1', provider_profile_id: 'profile-other' }),
      outputs: [createImageOutput({ id: 'output-1', name: 'render.png' })],
      source_images: [],
    },
  ], [
    createProviderProfile({ id: 'profile-active', model: 'gpt-image-2' }),
    createProviderProfile({ id: 'profile-other', model: 'custom-image-model' }),
  ]);

  assert.equal(groups[0]?.model, 'custom-image-model');
  assert.deepEqual(collectResultOutputIds(groups), ['output-1']);
});

function renderImageGenerationShell(projectId: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ImageGenerationShell projectId={projectId} />
    </QueryClientProvider>,
  );
}

function createWorkbenchForm(overrides: Partial<FormState> = {}): FormState {
  return {
    workflow: 'generate',
    sourceFiles: [],
    count: 2,
    quality: 'high',
    size: '1792x1024',
    style: 'natural',
    prompt: '生成图片',
    negativePrompt: '',
    ...overrides,
  };
}

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

function createProviderProfile(overrides: Partial<ImageProviderProfile> = {}): ImageProviderProfile {
  return {
    id: 'profile-1',
    project_id: 'project-1',
    name: 'Images',
    base_url: 'https://api.example.test',
    model: 'gpt-image-2',
    compat_profile_id: 'openai',
    supports_count_parameter: 1,
    active: 0,
    has_api_key: 1,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides,
  };
}

function createImageJob(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
  return {
    id: 'job-1',
    project_id: 'project-1',
    room_id: null,
    session_id: null,
    source_message_id: null,
    source_agent_id: null,
    source_task_id: null,
    provider_profile_id: 'profile-1',
    workflow: 'generate',
    prompt: '生成图片',
    count: 1,
    quality: 'high',
    size: '1792x1024',
    status: 'completed',
    message: null,
    error: null,
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    updated_at: 2,
    ...overrides,
  };
}

function createImageOutput(overrides: Partial<ImageGenerationOutput> = {}): ImageGenerationOutput {
  return {
    id: 'output-1',
    job_id: 'job-1',
    file_id: 'file-1',
    slot: 0,
    name: 'render.png',
    url: '/uploads/render.png',
    mime_type: 'image/png',
    size: 1,
    width: 1792,
    height: 1024,
    created_at: 2,
    ...overrides,
  };
}
