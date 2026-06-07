import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageJobQueueView } from './ImageJobQueue';
import type { ImageGenerationJob, ImageJobDetailResponse, ProjectFile } from '../lib/types';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

test('image job queue renders retry for failed job and cancel for running job', () => {
  const html = renderToStaticMarkup(
    <ImageJobQueueView
      jobs={[
        fakeJob({ id: 'job-failed', status: 'failed', prompt: 'failed prompt' }),
        fakeJob({ id: 'job-running', status: 'running', prompt: 'running prompt' }),
      ]}
      busyJobId={null}
      onRetry={() => undefined}
      onCancel={() => undefined}
    />,
  );

  assert.match(html, /failed prompt/);
  assert.match(html, /running prompt/);
  assert.match(html, /重试失败任务/);
  assert.match(html, /取消运行任务/);
});

test('image lineage panel renders parent source thumbnail to child output thumbnail', async () => {
  const { ImageLineagePanel } = await import('./ImageLineagePanel');
  const html = renderToStaticMarkup(
    <ImageLineagePanel
      details={[
        fakeDetail({
          job: fakeJob({ id: 'job-parent', prompt: 'parent prompt', status: 'completed' }),
          outputs: [fakeOutput({ id: 'output-parent', job_id: 'job-parent', file_id: 'file-parent', name: 'parent.png', url: '/uploads/parent.png' })],
        }),
        fakeDetail({
          job: fakeJob({ id: 'job-child', workflow: 'image-to-image', prompt: 'child prompt', status: 'completed' }),
          source_images: [fakeSourceImage({
            id: 'source-child',
            job_id: 'job-child',
            file_id: 'file-parent',
            url: '/uploads/parent.png',
            origin_job_id: 'job-parent',
            origin_output_id: 'output-parent',
          })],
          outputs: [fakeOutput({ id: 'output-child', job_id: 'job-child', file_id: 'file-child', name: 'child.png', url: '/uploads/child.png' })],
        }),
      ]}
    />,
  );

  assert.match(html, /图生图链路/);
  assert.match(html, /parent prompt/);
  assert.match(html, /child prompt/);
  assert.match(html, /src="\/uploads\/parent\.png"/);
  assert.match(html, /src="\/uploads\/child\.png"/);
});

test('gallery excludes uploaded resources that wrap generated output file ids', async () => {
  const { buildGalleryItems } = await import('./ImageGalleryPanel');
  const items = buildGalleryItems(
    'project-1',
    [fakeDetail({
      outputs: [fakeOutput({ id: 'output-1', file_id: 'file-1', name: 'generated.png' })],
    })],
    [fakeProjectFile({ id: 'file:file-1', original_name: 'generated.png', mime_type: 'image/png' })],
  );

  assert.deepEqual(items.map((item) => item.id), ['output:output-1']);
});

function fakeJob(overrides: Partial<ImageGenerationJob> = {}): ImageGenerationJob {
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
    prompt: 'prompt',
    count: 1,
    quality: 'auto',
    size: 'auto',
    status: 'queued',
    message: null,
    error: null,
    created_at: 1,
    started_at: null,
    completed_at: null,
    updated_at: 1,
    ...overrides,
  };
}

function fakeDetail(overrides: Partial<ImageJobDetailResponse> = {}): ImageJobDetailResponse {
  const job = overrides.job ?? fakeJob();
  return {
    job,
    outputs: [],
    source_images: [],
    ...overrides,
  };
}

function fakeOutput(
  overrides: Partial<ImageJobDetailResponse['outputs'][number]> = {},
): ImageJobDetailResponse['outputs'][number] {
  return {
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
    ...overrides,
  };
}

function fakeSourceImage(
  overrides: Partial<ImageJobDetailResponse['source_images'][number]> = {},
): ImageJobDetailResponse['source_images'][number] {
  return {
    id: 'source-1',
    job_id: 'job-1',
    file_id: 'file-source',
    slot: 1,
    url: '/uploads/source.png',
    origin_job_id: null,
    origin_output_id: null,
    created_at: 2,
    ...overrides,
  };
}

function fakeProjectFile(input: {
  id: string;
  original_name: string;
  mime_type: string;
}): ProjectFile {
  return {
    id: input.id,
    project_id: 'project-1',
    source_type: 'uploaded_file',
    original_name: input.original_name,
    stored_name: input.original_name,
    mime_type: input.mime_type,
    size: 42,
    url: '/uploads/generated.png',
    storage_path: '',
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
  };
}
