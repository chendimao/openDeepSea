import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-imports-')), 'test.db');

const { knowledgeRepo } = await import('./repos/knowledge.js');
const { projectRepo } = await import('./repos/projects.js');
const {
  createManualKnowledgeSource,
  createUrlKnowledgeSource,
  importWorkspaceDocuments,
} = await import('./knowledge-imports.js');

test('createManualKnowledgeSource stores searchable manual knowledge', () => {
  const project = createProject('manual');
  const result = createManualKnowledgeSource({
    projectId: project.id,
    title: '手动规范',
    content: 'A12 手动知识需要验收。',
    tags: ['规范'],
  });

  assert.equal(result.source.source_type, 'manual');
  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.metadata.import_type, 'manual');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'A12' }).length, 1);
  assert.equal(knowledgeRepo.listChunkEmbeddings({ projectId: project.id, sourceId: result.source.id }).length, 1);
});

test('createUrlKnowledgeSource validates URL and supports metadata-only stale source', () => {
  const project = createProject('url');

  assert.throws(
    () => createUrlKnowledgeSource({ projectId: project.id, url: 'file:///etc/passwd' }),
    /URL must use http or https/,
  );

  const result = createUrlKnowledgeSource({ projectId: project.id, url: 'https://example.com/spec' });
  assert.equal(result.source.source_type, 'url');
  assert.equal(result.source.status, 'stale');
  assert.equal(result.source.metadata.host, 'example.com');
  assert.equal(result.source.metadata.requires_fetch, true);
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'example' }).length, 0);
});

test('createUrlKnowledgeSource stores searchable provided URL content', () => {
  const project = createProject('url-content');
  const result = createUrlKnowledgeSource({
    projectId: project.id,
    url: 'https://example.com/a12',
    title: 'A12 URL',
    content: 'A12 URL content should be indexed.',
    tags: ['url'],
  });

  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.uri, 'https://example.com/a12');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'A12' }).length, 1);
});

test('importWorkspaceDocuments reuses workspace file safety and indexes text files', async () => {
  const project = createProjectWithFile('workspace', 'docs/spec.md', '# A12 Workspace Doc\n验收内容');
  const result = await importWorkspaceDocuments({
    projectId: project.id,
    paths: ['docs/spec.md'],
    tags: ['工作区'],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.created[0]?.source_type, 'workspace_doc');
  assert.equal(result.created[0]?.metadata.workspace_path, 'docs/spec.md');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'A12' }).length, 1);
});

test('importWorkspaceDocuments records per-path failures from workspace safety checks', async () => {
  const project = createProjectWithFile('workspace-failure', 'docs/spec.md', '# A12 Workspace Doc');
  const result = await importWorkspaceDocuments({
    projectId: project.id,
    paths: ['../outside.md', 'docs/spec.md'],
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.path, '../outside.md');
  assert.match(result.failed[0]?.error ?? '', /WORKSPACE_PATH_TRAVERSAL/);
});

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-knowledge-import-${name}-`)),
  });
}

function createProjectWithFile(name: string, relativePath: string, content: string) {
  const project = createProject(name);
  const absolutePath = join(project.path, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return project;
}
