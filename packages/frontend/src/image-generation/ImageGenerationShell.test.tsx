import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImageGenerationShell } from './ImageGenerationShell';

const globalWithReact = globalThis as typeof globalThis & { React: typeof React };
globalWithReact.React = React;

test('image workbench shell renders three working regions', () => {
  const html = renderImageGenerationShell('project-1');

  assert.match(html, /aria-labelledby="image-generation-config-heading"/);
  assert.match(html, /id="image-generation-config-heading"/);
  assert.match(html, /aria-labelledby="image-generation-jobs-heading"/);
  assert.match(html, /id="image-generation-jobs-heading"/);
  assert.match(html, /aria-labelledby="image-generation-gallery-heading"/);
  assert.match(html, /id="image-generation-gallery-heading"/);
});

test('image workbench shell keeps the project context visible', () => {
  const html = renderImageGenerationShell('project-1');

  assert.match(html, /data-project-id="project-1"/);
  assert.match(html, /图片工作台/);
  assert.match(html, /生成设置/);
  assert.match(html, /任务队列/);
  assert.match(html, /项目图库/);
});

function renderImageGenerationShell(projectId: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ImageGenerationShell projectId={projectId} />
    </QueryClientProvider>,
  );
}
