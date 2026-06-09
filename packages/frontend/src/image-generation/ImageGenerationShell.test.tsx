import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImageGenerationShell } from './ImageGenerationShell';

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
  assert.match(html, /任务队列/);
  assert.match(html, /生成结果/);
  assert.match(html, /历史记录/);
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

function renderImageGenerationShell(projectId: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ImageGenerationShell projectId={projectId} />
    </QueryClientProvider>,
  );
}
