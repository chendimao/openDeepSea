import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageJobQueueView } from './ImageJobQueue';
import type { ImageGenerationJob } from '../lib/types';

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
