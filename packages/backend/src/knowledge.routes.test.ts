import assert from 'node:assert/strict';
import { constants, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-routes-')), 'test.db');
process.env.OPENCLAW_ACP_MESSAGE_INTENT_CLASSIFIER = '0';
process.env.OPENCLAW_ACP_TASK_ANALYZER = '0';

const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { fileRepo } = await import('./repos/files.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { rebuildKnowledgeEmbeddings } = await import('./knowledge-embedding-rebuild.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

class InMemorySocket extends Duplex {
  _read(): void {}

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function toResponseHeaders(headers: OutgoingHttpHeaders): Headers {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(name, item);
    } else {
      responseHeaders.set(name, String(value));
    }
  }
  return responseHeaders;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const serializedRequest = new Request(`http://127.0.0.1${path}`, init);
  const body = init.body === undefined || init.body === null
    ? null
    : Buffer.from(await serializedRequest.arrayBuffer());
  const socket = new InMemorySocket();
  const req = new IncomingMessage(socket as unknown as import('node:net').Socket);
  req.method = init.method ?? 'GET';
  req.url = path;
  req.headers = Object.fromEntries(serializedRequest.headers);
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  if (body) {
    req.headers['content-length'] = String(body.byteLength);
  }

  const res = new ServerResponse(req);
  res.assignSocket(socket as unknown as import('node:net').Socket);

  const chunks: Buffer[] = [];
  res.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
    }
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    res.emit('finish');
    res.emit('close');
    return res;
  }) as typeof res.end;

  const responsePromise = new Promise<Response>((resolve, reject) => {
    res.once('finish', () => {
      const responseBody = res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(chunks);
      resolve(new Response(responseBody, {
        status: res.statusCode,
        headers: toResponseHeaders(res.getHeaders()),
      }));
    });
    (app as unknown as { handle: (...args: unknown[]) => void }).handle(req, res, (error: unknown) => {
      if (error) reject(error);
    });
  });

  if (body) {
    req.push(body);
  }
  req.push(null);
  req.complete = true;

  return responsePromise;
}

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-knowledge-route-${name}-`)),
  });
}

function createTextFile(projectId: string, content = '部署 A12 浮标需要验收。') {
  const root = mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-route-file-'));
  const storagePath = join(root, 'notes.md');
  writeFileSync(storagePath, content);
  return fileRepo.create({
    project_id: projectId,
    original_name: 'notes.md',
    stored_name: 'notes.md',
    mime_type: 'text/markdown',
    size: Buffer.byteLength(content),
    url: `/uploads/files/${projectId}/notes.md`,
    storage_path: storagePath,
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
}

test('knowledge source detail exposes latest extraction and original file capability', async () => {
  const project = createProject('detail');
  const file = createTextFile(project.id, '# 验收计划\n部署 A12 浮标。');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: file.id,
    title: file.original_name,
    mime_type: file.mime_type,
    size: file.size,
    status: 'ready',
    summary: '部署 A12 浮标。',
    tags: ['验收'],
    metadata: { file_id: file.id },
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: '# 验收计划\n部署 A12 浮标。',
    markdown: '# 验收计划\n部署 A12 浮标。',
  });
  knowledgeRepo.replaceChunks(source.id, [{
    chunk_type: 'body',
    content: '部署 A12 浮标。',
    project_id: project.id,
  }]);

  const detailRes = await request(`/api/knowledge/sources/${source.id}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as {
    id: string;
    latest_extraction_id: string | null;
    capabilities: { preview: boolean; download: boolean; reprocess: boolean };
    original_file: { id: string; url: string } | null;
  };
  assert.equal(detail.id, source.id);
  assert.equal(detail.latest_extraction_id, extraction.id);
  assert.equal(detail.capabilities.preview, true);
  assert.equal(detail.capabilities.download, true);
  assert.equal(detail.capabilities.reprocess, true);
  assert.equal(detail.original_file?.id, file.id);

  const extractionRes = await request(`/api/knowledge/sources/${source.id}/extraction`);
  assert.equal(extractionRes.status, 200);
  const extractionBody = await extractionRes.json() as { plain_text: string; markdown: string | null; truncated: boolean };
  assert.match(extractionBody.plain_text, /A12/);
  assert.equal(extractionBody.markdown, '# 验收计划\n部署 A12 浮标。');
  assert.equal(extractionBody.truncated, false);
});

test('knowledge chunks and search routes expose citations', async () => {
  const project = createProject('search');
  const room = roomRepo.create({ project_id: project.id, name: 'Search Room' });
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: room.id,
    source_type: 'uploaded_file',
    source_id: 'file-search-1',
    title: 'search-notes.md',
    status: 'ready',
  });
  const chunks = knowledgeRepo.replaceChunks(source.id, [
    { chunk_type: 'body', content: 'A12 验收需要截图。', project_id: project.id, room_id: room.id, enabled: 1 },
    { chunk_type: 'body', content: 'A12 隐藏内容。', project_id: project.id, room_id: room.id, enabled: 0 },
  ]);

  const chunksRes = await request(`/api/knowledge/sources/${source.id}/chunks?enabled=1`);
  assert.equal(chunksRes.status, 200);
  const chunkBody = await chunksRes.json() as Array<{ id: string; enabled: 0 | 1; content: string }>;
  assert.deepEqual(chunkBody.map((chunk) => [chunk.id, chunk.enabled]), [[chunks[0]!.id, 1]]);

  const searchRes = await request(`/api/knowledge/search?projectId=${project.id}&q=A12&roomId=${room.id}`);
  assert.equal(searchRes.status, 200);
  const results = await searchRes.json() as Array<{
    chunk_id: string;
    citation: { source_id: string; chunk_id: string; room_id: string | null };
  }>;
  assert.equal(results.length, 1);
  assert.equal(results[0]?.chunk_id, chunks[0]?.id);
  assert.equal(results[0]?.citation.source_id, source.id);
  assert.equal(results[0]?.citation.room_id, room.id);

  const hybridRes = await request(`/api/knowledge/search?projectId=${project.id}&q=A12&roomId=${room.id}&mode=hybrid`);
  assert.equal(hybridRes.status, 200);
  const hybridResults = await hybridRes.json() as Array<{
    chunk_id: string;
    retrieval_mode: string;
    ranking: { finalScore: number };
  }>;
  assert.equal(hybridResults[0]?.chunk_id, chunks[0]?.id);
  assert.equal(hybridResults[0]?.retrieval_mode, 'hybrid');
  assert.ok(hybridResults[0]!.ranking.finalScore > 0);
});

test('knowledge search route uses async embedding metadata for hybrid results', async () => {
  const project = createProject('async-search-route');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'manual-async-search-route',
    title: 'A12 Async Route',
    status: 'ready',
  });
  knowledgeRepo.replaceChunks(source.id, [
    { chunk_type: 'body', content: 'A12 async route content.', project_id: project.id, enabled: 1 },
  ]);
  await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: source.id });

  const searchRes = await request(`/api/knowledge/search?projectId=${project.id}&q=${encodeURIComponent('A12 async')}&mode=hybrid`);

  assert.equal(searchRes.status, 200);
  const results = await searchRes.json() as Array<{
    source_id: string;
    retrieval_mode: string;
    ranking: { embeddingProvider?: string; embeddingModel?: string };
  }>;
  assert.equal(results[0]?.source_id, source.id);
  assert.equal(results[0]?.retrieval_mode, 'hybrid');
  assert.equal(results[0]?.ranking.embeddingProvider, 'local-hash');
  assert.equal(results[0]?.ranking.embeddingModel, 'local-hash-v1');
});

test('knowledge embedding routes expose status, test, and rebuild without secrets', async () => {
  const project = createProject('embedding-routes');

  const statusRes = await request(`/api/knowledge/embedding/status?projectId=${encodeURIComponent(project.id)}`);
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json() as {
    runtime: { provider: string; model: string; api_key_set: boolean };
    total_enabled_chunks: number;
  };
  assert.equal(statusBody.runtime.provider, 'local-hash');
  assert.equal(statusBody.runtime.model, 'local-hash-v1');
  assert.equal('api_key' in statusBody.runtime, false);

  const testRes = await request('/api/knowledge/embedding/test', { method: 'POST', body: '{}' });
  assert.equal(testRes.status, 200);
  const testBody = await testRes.json() as { ok: boolean; dimensions: number | null };
  assert.equal(testBody.ok, true);
  assert.equal(typeof testBody.dimensions, 'number');

  const rebuildRes = await request('/api/knowledge/embedding/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id }),
  });
  assert.equal(rebuildRes.status, 200);
  const rebuildBody = await rebuildRes.json() as { project_id: string; scanned_chunks: number };
  assert.equal(rebuildBody.project_id, project.id);
});

test('knowledge embedding status counts missing and embedded chunks', async () => {
  const project = createProject('embedding-status-counts');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'manual-embedding-status-counts',
    title: 'Embedding Status Counts',
    status: 'ready',
  });
  knowledgeRepo.replaceChunks(source.id, [
    { chunk_type: 'body', content: 'embedded chunk', project_id: project.id, enabled: 1 },
    { chunk_type: 'body', content: 'missing chunk', project_id: project.id, enabled: 1 },
  ]);

  const beforeRes = await request(`/api/knowledge/embedding/status?projectId=${project.id}`);
  assert.equal(beforeRes.status, 200);
  const before = await beforeRes.json() as {
    total_enabled_chunks: number;
    embedded_chunks: number;
    missing_chunks: number;
    stale_chunks: number;
  };
  assert.equal(before.total_enabled_chunks, 2);
  assert.equal(before.embedded_chunks, 0);
  assert.equal(before.missing_chunks, 2);
  assert.equal(before.stale_chunks, 0);

  await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: source.id, limit: 1 });
  const afterRes = await request(`/api/knowledge/embedding/status?projectId=${project.id}`);
  assert.equal(afterRes.status, 200);
  const after = await afterRes.json() as {
    total_enabled_chunks: number;
    embedded_chunks: number;
    missing_chunks: number;
    stale_chunks: number;
  };
  assert.equal(after.total_enabled_chunks, 2);
  assert.equal(after.embedded_chunks, 1);
  assert.equal(after.missing_chunks, 1);
  assert.equal(after.stale_chunks, 0);
});

test('knowledge embedding status treats imported local embeddings as fresh', async () => {
  const project = createProject('embedding-status-import');
  const importRes = await request(`/api/projects/${project.id}/knowledge/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Embedding Import Freshness',
      content: 'Imported local embedding should not become stale immediately.',
    }),
  });
  assert.equal(importRes.status, 201);

  const statusRes = await request(`/api/knowledge/embedding/status?projectId=${project.id}`);
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json() as {
    total_enabled_chunks: number;
    embedded_chunks: number;
    missing_chunks: number;
    stale_chunks: number;
  };

  assert.equal(status.total_enabled_chunks, 1);
  assert.equal(status.embedded_chunks, 1);
  assert.equal(status.missing_chunks, 0);
  assert.equal(status.stale_chunks, 0);
});

test('knowledge embedding routes reject empty project status and invalid source rebuild scope', async () => {
  const project = createProject('embedding-route-validation');
  const otherProject = createProject('embedding-route-validation-other');
  const otherSource = knowledgeRepo.ensureSource({
    project_id: otherProject.id,
    source_type: 'manual',
    source_id: 'manual-other-source',
    title: 'Other Source',
    status: 'ready',
  });

  const emptyProjectRes = await request('/api/knowledge/embedding/status?projectId=');
  assert.equal(emptyProjectRes.status, 400);

  const missingSourceRes = await request('/api/knowledge/embedding/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, sourceId: 'missing-source' }),
  });
  assert.equal(missingSourceRes.status, 404);

  const crossProjectSourceRes = await request('/api/knowledge/embedding/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, sourceId: otherSource.id }),
  });
  assert.equal(crossProjectSourceRes.status, 404);
});

test('knowledge list query matches source summary and tags', async () => {
  const project = createProject('list-query');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'manual-list-query-1',
    title: '治理记录',
    status: 'ready',
    summary: 'Phase 1 知识库验收说明。',
    tags: ['验收', '资料管理'],
  });

  const summaryRes = await request(`/api/knowledge?projectId=${project.id}&q=${encodeURIComponent('知识库验收')}`);
  assert.equal(summaryRes.status, 200);
  const summaryMatches = await summaryRes.json() as Array<{ id: string }>;
  assert.deepEqual(summaryMatches.map((item) => item.id), [source.id]);

  const tagRes = await request(`/api/knowledge?projectId=${project.id}&q=${encodeURIComponent('资料管理')}`);
  assert.equal(tagRes.status, 200);
  const tagMatches = await tagRes.json() as Array<{ id: string }>;
  assert.deepEqual(tagMatches.map((item) => item.id), [source.id]);
});

test('knowledge import routes create manual, url, and workspace document sources', async () => {
  const project = createProject('imports');
  const workspacePath = join(project.path, 'docs/a12.md');
  mkdirSync(dirname(workspacePath), { recursive: true });
  writeFileSync(workspacePath, '# A12 workspace route\n验收内容');

  const manualRes = await request(`/api/projects/${project.id}/knowledge/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Manual A12', content: 'A12 manual content', tags: ['manual'] }),
  });
  assert.equal(manualRes.status, 201);
  const manual = await manualRes.json() as { source: { source_type: string; status: string } };
  assert.equal(manual.source.source_type, 'manual');
  assert.equal(manual.source.status, 'ready');

  const urlRes = await request(`/api/projects/${project.id}/knowledge/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/a12', content: 'A12 URL content' }),
  });
  assert.equal(urlRes.status, 201);
  const url = await urlRes.json() as { source: { source_type: string; status: string; uri: string } };
  assert.equal(url.source.source_type, 'url');
  assert.equal(url.source.status, 'ready');
  assert.equal(url.source.uri, 'https://example.com/a12');

  const workspaceRes = await request(`/api/projects/${project.id}/knowledge/workspace-docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: ['docs/a12.md'] }),
  });
  assert.equal(workspaceRes.status, 201);
  const workspace = await workspaceRes.json() as { created: Array<{ source_type: string; status: string }>; failed: unknown[] };
  assert.equal(workspace.created.length, 1);
  assert.equal(workspace.created[0]?.source_type, 'workspace_doc');
  assert.equal(workspace.created[0]?.status, 'ready');
  assert.equal(workspace.failed.length, 0);

  assert.ok(knowledgeRepo.search({ projectId: project.id, query: 'A12' }).length >= 3);
});

test('knowledge governance routes expose insights and metadata patch', async () => {
  const project = createProject('governance');
  const first = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'governance-a',
    title: 'Governance A',
    status: 'ready',
    content_hash: 'same-governance',
    metadata: { parser_status: 'complete' },
  });
  const second = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'governance-b',
    title: 'Governance B',
    status: 'ready',
    content_hash: 'same-governance',
    metadata: { parser_status: 'requires_sidecar' },
  });
  knowledgeRepo.replaceChunks(first.id, [{ chunk_type: 'body', content: 'A12 governance', project_id: project.id }]);

  const insightsRes = await request(`/api/knowledge/insights?projectId=${project.id}`);
  assert.equal(insightsRes.status, 200);
  const insights = await insightsRes.json() as {
    duplicates: { count: number };
    parser_incomplete: { count: number };
    empty_index: { count: number };
  };
  assert.equal(insights.duplicates.count, 2);
  assert.equal(insights.parser_incomplete.count, 1);
  assert.equal(insights.empty_index.count, 1);

  const patchRes = await request(`/api/knowledge/sources/${first.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metadataPatch: {
        decisions: ['采用 hybrid'],
        risks: ['OCR 未配置'],
      },
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json() as { metadata: { decisions: string[]; risks: string[] } };
  assert.deepEqual(patched.metadata.decisions, ['采用 hybrid']);
  assert.deepEqual(patched.metadata.risks, ['OCR 未配置']);

  const invalidPatchRes = await request(`/api/knowledge/sources/${first.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadataPatch: { storage_path: ['/tmp/leak'] } }),
  });
  assert.equal(invalidPatchRes.status, 400);
});

test('knowledge action routes reprocess, disable, restore, and delete source records', async () => {
  const project = createProject('actions');
  const file = createTextFile(project.id, '重处理前内容。');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: file.id,
    title: file.original_name,
    status: 'failed',
    error: 'previous failure',
    metadata: { file_id: file.id },
  });

  const reprocessRes = await request(`/api/knowledge/sources/${source.id}/reprocess`, { method: 'POST' });
  assert.equal(reprocessRes.status, 200);
  const ready = await reprocessRes.json() as { id: string; status: string; error: string | null };
  assert.equal(ready.id, source.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.error, null);

  const disableRes = await request(`/api/knowledge/sources/${source.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert.equal(disableRes.status, 200);
  assert.equal((await disableRes.json() as { status: string }).status, 'disabled');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: '重处理前内容' }).length, 0);

  const restoreRes = await request(`/api/knowledge/sources/${source.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ready' }),
  });
  assert.equal(restoreRes.status, 200);
  assert.equal((await restoreRes.json() as { status: string }).status, 'ready');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: '重处理前内容' }).length, 1);

  const disableChunksRes = await request(`/api/knowledge/sources/${source.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 0 }),
  });
  assert.equal(disableChunksRes.status, 200);
  assert.equal((await disableChunksRes.json() as { status: string }).status, 'disabled');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: '重处理前内容' }).length, 0);

  const restoreChunksRes = await request(`/api/knowledge/sources/${source.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 1 }),
  });
  assert.equal(restoreChunksRes.status, 200);
  assert.equal((await restoreChunksRes.json() as { status: string }).status, 'ready');
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: '重处理前内容' }).length, 1);

  const deleteRes = await request(`/api/knowledge/sources/${source.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
  assert.equal(knowledgeRepo.getSource(source.id), undefined);
  await access(file.storage_path, constants.F_OK);
});
