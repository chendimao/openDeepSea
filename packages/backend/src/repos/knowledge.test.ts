import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { KnowledgeSourceType, KnowledgeStatus } from '../knowledge-types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-repo-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');
const { knowledgeRepo } = await import('./knowledge.js');
const { db } = await import('../db.js');

type ExtendedSourceListFilters = Parameters<typeof knowledgeRepo.listSources>[0] & {
  roomId?: string;
  statuses?: KnowledgeStatus[];
  sourceTypes?: KnowledgeSourceType[];
};

function listSourcesWithExtendedFilters(filters: ExtendedSourceListFilters) {
  return knowledgeRepo.listSources(filters);
}

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-knowledge-${name}-`)),
  });
}

test('knowledgeRepo stores sources, extractions, chunks, status, and search snippets', () => {
  const project = createProject('main');

  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'resource_asset',
    source_id: 'asset-001',
    title: 'A12 Deployment Notes',
    mime_type: 'text/markdown',
    uri: 'resource://asset-001',
    tags: ['release', 'runbook'],
    metadata: { owner: 'planner' },
  });

  assert.equal(source.project_id, project.id);
  assert.equal(source.source_type, 'resource_asset');
  assert.equal(source.source_id, 'asset-001');
  assert.equal(source.title, 'A12 Deployment Notes');
  assert.deepEqual(source.tags, ['release', 'runbook']);
  assert.equal(source.status, 'pending');
  assert.deepEqual(source.metadata, { owner: 'planner' });

  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: 'A12 deployment requires database backup before rollout.',
    markdown: '# A12 Deployment\n\nBackup the database before rollout.',
    metadata: { extractor: 'phase-1' },
  });

  assert.equal(extraction.source_id, source.id);
  assert.equal(extraction.plain_text, 'A12 deployment requires database backup before rollout.');
  assert.equal(extraction.markdown, '# A12 Deployment\n\nBackup the database before rollout.');
  assert.deepEqual(extraction.metadata, { extractor: 'phase-1' });
  assert.equal(knowledgeRepo.getLatestExtraction(source.id)?.id, extraction.id);

  const chunks = knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: [
      {
        chunk_index: 0,
        chunk_type: 'markdown',
        heading: 'A12 Deployment',
        content: 'A12 deployment requires database backup before rollout.',
        token_estimate: 9,
        metadata: { section: 'deployment' },
      },
      {
        chunk_index: 1,
        chunk_type: 'plain_text',
        heading: 'Rollback',
        content: 'Rollback can use the previous release package.',
        token_estimate: 8,
      },
    ],
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.source_id, source.id);
  assert.equal(chunks[0]?.extraction_id, extraction.id);
  assert.equal(chunks[0]?.chunk_index, 0);
  assert.equal(chunks[0]?.heading, 'A12 Deployment');
  assert.deepEqual(chunks[0]?.metadata, { section: 'deployment' });
  assert.deepEqual(
    knowledgeRepo.listChunks(source.id).map((chunk) => [chunk.chunk_index, chunk.content]),
    [
      [0, 'A12 deployment requires database backup before rollout.'],
      [1, 'Rollback can use the previous release package.'],
    ],
  );

  knowledgeRepo.updateSourceStatus(source.id, {
    status: 'ready',
    error: null,
    tags: ['release', 'runbook', 'verified'],
  });

  const listed = knowledgeRepo.listSources({ projectId: project.id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, source.id);
  assert.equal(listed[0]?.status, 'ready');
  assert.deepEqual(listed[0]?.tags, ['release', 'runbook', 'verified']);
  assert.equal(listed[0]?.chunk_count, 2);

  const results = knowledgeRepo.search({ projectId: project.id, query: 'A12' });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.source_id, source.id);
  assert.equal(results[0]?.chunk_id, chunks[0]?.id);
  assert.equal(results[0]?.heading, 'A12 Deployment');
  assert.match(results[0]?.snippet ?? '', /A12/);
});

test('knowledgeRepo ensureSource upserts by project_id, source_type, and source_id', () => {
  const project = createProject('upsert');

  const first = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'resource_asset',
    source_id: 'asset-upsert',
    title: 'Original title',
    tags: ['draft'],
  });

  const second = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'resource_asset',
    source_id: 'asset-upsert',
    title: 'Updated title',
    mime_type: 'text/plain',
    tags: ['final'],
  });

  assert.equal(second.id, first.id);
  assert.equal(second.title, 'Updated title');
  assert.equal(second.mime_type, 'text/plain');
  assert.deepEqual(second.tags, ['final']);
  assert.equal(knowledgeRepo.listSources({ projectId: project.id }).length, 1);
});

test('knowledgeRepo gets a source by project_id, source_type, and source_id', () => {
  const project = createProject('external-source');
  const otherProject = createProject('external-source-other');

  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'session_note',
    source_id: 'session_note:session-1:hash',
    title: 'Session note',
  });
  knowledgeRepo.ensureSource({
    project_id: otherProject.id,
    source_type: 'session_note',
    source_id: 'session_note:session-1:hash',
    title: 'Other project note',
  });

  assert.equal(
    knowledgeRepo.getSourceByExternalId({
      projectId: project.id,
      sourceType: 'session_note',
      sourceId: 'session_note:session-1:hash',
    })?.id,
    source.id,
  );
  assert.equal(knowledgeRepo.getSourceByExternalId({
    projectId: project.id,
    sourceType: 'session_note',
    sourceId: 'missing',
  }), undefined);
});

test('knowledgeRepo search defaults to ready enabled chunks and supports filters', () => {
  const project = createProject('search-filters');
  const otherProject = createProject('search-filters-other');

  const roomReady = roomRepo.create({ project_id: project.id, name: 'Ready Room' }).id;
  const roomOther = roomRepo.create({ project_id: project.id, name: 'Other Room' }).id;
  const otherProjectRoom = roomRepo.create({ project_id: otherProject.id, name: 'Other Project Room' }).id;
  const readyUpload = createIndexedSource({
    project_id: project.id,
    room_id: roomReady,
    source_type: 'uploaded_file',
    source_id: 'ready-upload',
    title: 'Ready upload',
    status: 'ready',
    chunks: [
      { content: 'A12 ready enabled upload chunk.', enabled: 1 },
      { content: 'A12 disabled chunk should stay hidden.', enabled: 0 },
    ],
  });
  createIndexedSource({
    project_id: project.id,
    room_id: roomOther,
    source_type: 'agent_document',
    source_id: 'ready-agent',
    title: 'Ready agent',
    status: 'ready',
    chunks: [{ content: 'A12 ready agent chunk.', enabled: 1 }],
  });
  createIndexedSource({
    project_id: project.id,
    room_id: roomReady,
    source_type: 'uploaded_file',
    source_id: 'failed-upload',
    title: 'Failed upload',
    status: 'failed',
    chunks: [{ content: 'A12 failed source chunk.', enabled: 1 }],
  });
  createIndexedSource({
    project_id: project.id,
    room_id: roomReady,
    source_type: 'uploaded_file',
    source_id: 'disabled-upload',
    title: 'Disabled upload',
    status: 'disabled',
    chunks: [{ content: 'A12 disabled source chunk.', enabled: 1 }],
  });
  createIndexedSource({
    project_id: otherProject.id,
    room_id: otherProjectRoom,
    source_type: 'uploaded_file',
    source_id: 'other-project',
    title: 'Other project',
    status: 'ready',
    chunks: [{ content: 'A12 other project chunk.', enabled: 1 }],
  });

  assert.deepEqual(
    knowledgeRepo.search({ projectId: project.id, query: 'A12' }).map((result) => result.external_source_id).sort(),
    ['ready-agent', 'ready-upload'],
  );
  assert.deepEqual(
    knowledgeRepo.search({ projectId: project.id, query: 'A12', roomId: roomReady }).map((result) => result.external_source_id),
    ['ready-upload'],
  );
  assert.deepEqual(
    knowledgeRepo.search({
      projectId: project.id,
      query: 'A12',
      statuses: ['failed', 'disabled'],
    }).map((result) => result.external_source_id).sort(),
    ['disabled-upload', 'failed-upload'],
  );
  assert.deepEqual(
    knowledgeRepo.search({
      projectId: project.id,
      query: 'A12',
      sourceTypes: ['agent_document'],
    }).map((result) => result.external_source_id),
    ['ready-agent'],
  );
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'A12', limit: 1 }).length, 1);
  assert.equal(knowledgeRepo.listChunks(readyUpload.id).filter((chunk) => chunk.enabled === 0).length, 1);
});

test('knowledgeRepo listSources supports roomId, statuses, sourceTypes, and single status filters', () => {
  const project = createProject('list-filters');
  const otherProject = createProject('list-filters-other');
  const roomPrimary = roomRepo.create({ project_id: project.id, name: 'Primary Room' }).id;
  const roomSecondary = roomRepo.create({ project_id: project.id, name: 'Secondary Room' }).id;
  const otherProjectRoom = roomRepo.create({ project_id: otherProject.id, name: 'Other Project Room' }).id;

  knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: roomPrimary,
    source_type: 'uploaded_file',
    source_id: 'ready-upload',
    title: 'Ready upload',
    status: 'ready',
  });
  knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: roomPrimary,
    source_type: 'task',
    source_id: 'failed-task',
    title: 'Failed task',
    status: 'failed',
  });
  knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: roomSecondary,
    source_type: 'agent_document',
    source_id: 'stale-agent',
    title: 'Stale agent',
    status: 'stale',
  });
  knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: roomPrimary,
    source_type: 'manual',
    source_id: 'disabled-manual',
    title: 'Disabled manual',
    status: 'disabled',
  });
  knowledgeRepo.ensureSource({
    project_id: otherProject.id,
    room_id: otherProjectRoom,
    source_type: 'uploaded_file',
    source_id: 'other-project',
    title: 'Other project',
    status: 'ready',
  });

  const sourceIds = (filters: Omit<ExtendedSourceListFilters, 'projectId'>) => listSourcesWithExtendedFilters({
    projectId: project.id,
    ...filters,
  }).map((source) => source.source_id).sort();

  assert.deepEqual(sourceIds({ roomId: roomPrimary }), ['disabled-manual', 'failed-task', 'ready-upload']);
  assert.deepEqual(sourceIds({ statuses: ['ready', 'stale'] }), ['ready-upload', 'stale-agent']);
  assert.deepEqual(sourceIds({ sourceTypes: ['uploaded_file', 'task'] }), ['failed-task', 'ready-upload']);
  assert.deepEqual(
    sourceIds({
      roomId: roomPrimary,
      statuses: ['failed', 'disabled'],
      sourceTypes: ['task', 'manual'],
    }),
    ['disabled-manual', 'failed-task'],
  );
  assert.deepEqual(sourceIds({ status: 'ready' }), ['ready-upload']);
});

test('knowledgeRepo replaceChunks two-argument overload attaches chunks to latest extraction', () => {
  const project = createProject('replace-latest-extraction');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: 'latest-source',
    title: 'Latest source',
    status: 'ready',
  });
  knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: 'Old extraction text.',
  });
  const latestExtraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: 'Latest extraction text.',
  });

  const chunks = knowledgeRepo.replaceChunks(source.id, [
    {
      chunk_type: 'plain_text',
      content: 'Latest extraction chunk.',
    },
  ]);

  assert.equal(chunks[0]?.extraction_id, latestExtraction.id);
});

test('knowledgeRepo replaceChunks two-argument overload leaves extraction null when source has no extraction', () => {
  const project = createProject('replace-no-extraction');
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'manual',
    source_id: 'no-extraction-source',
    title: 'No extraction source',
    status: 'ready',
  });

  const chunks = knowledgeRepo.replaceChunks(source.id, [
    {
      chunk_type: 'plain_text',
      content: 'Chunk without extraction.',
    },
  ]);

  assert.equal(chunks[0]?.extraction_id, null);
});

test('knowledgeRepo ensureSource partial upsert preserves existing optional fields', () => {
  const project = createProject('partial-upsert');
  const room = roomRepo.create({ project_id: project.id, name: 'Preserve Room' });

  const first = knowledgeRepo.ensureSource({
    project_id: project.id,
    room_id: room.id,
    source_type: 'uploaded_file',
    source_id: 'preserve-source',
    title: 'Original title',
    mime_type: 'text/markdown',
    size: 512,
    uri: 'file://original.md',
    content_hash: 'hash-1',
    parser: 'builtin-text',
    parser_version: '1',
    summary: 'Keep this summary',
    tags: ['keep'],
    metadata: { keep: true },
    status: 'processing',
  });

  const second = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: 'preserve-source',
    title: 'Updated title',
    status: 'ready',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.title, 'Updated title');
  assert.equal(second.room_id, room.id);
  assert.equal(second.mime_type, 'text/markdown');
  assert.equal(second.size, 512);
  assert.equal(second.uri, 'file://original.md');
  assert.equal(second.content_hash, 'hash-1');
  assert.equal(second.parser, 'builtin-text');
  assert.equal(second.parser_version, '1');
  assert.equal(second.summary, 'Keep this summary');
  assert.deepEqual(second.tags, ['keep']);
  assert.deepEqual(second.metadata, { keep: true });
  assert.equal(second.status, 'ready');
});

test('knowledgeRepo search results include citation with snippet and tags', () => {
  const project = createProject('citation');
  const room = roomRepo.create({ project_id: project.id, name: 'Citation Room' });
  const source = createIndexedSource({
    project_id: project.id,
    room_id: room.id,
    source_type: 'agent_document',
    source_id: 'citation-source',
    title: 'Citation Source',
    status: 'ready',
    tags: ['citation', 'A12'],
    chunks: [{ content: 'Citation body mentions A12.', heading: 'Citation Heading', enabled: 1 }],
  });

  const [result] = knowledgeRepo.search({ projectId: project.id, query: 'A12' });

  assert.equal(result?.source_id, source.id);
  assert.match(result?.snippet ?? '', /A12/);
  assert.deepEqual(result?.tags, ['citation', 'A12']);
  assert.deepEqual(result?.citation, {
    source_id: source.id,
    source_type: 'agent_document',
    source_title: 'Citation Source',
    external_source_id: 'citation-source',
    chunk_id: result?.chunk_id,
    chunk_index: 0,
    heading: 'Citation Heading',
    room_id: room.id,
  });
});

test('knowledgeRepo cleans FTS rows when source is deleted directly', () => {
  const project = createProject('fts-cleanup');
  const source = createIndexedSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: 'delete-source',
    title: 'Delete Source',
    status: 'ready',
    chunks: [{ content: 'A12 cleanup target.', enabled: 1 }],
  });
  const before = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunk_fts WHERE source_id = ?')
    .get(source.id) as { count: number };
  assert.equal(before.count, 1);

  db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(source.id);

  const after = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunk_fts WHERE source_id = ?')
    .get(source.id) as { count: number };
  assert.equal(after.count, 0);
});

test('knowledgeRepo cleans FTS rows when chunk is deleted directly', () => {
  const project = createProject('chunk-fts-cleanup');
  const source = createIndexedSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: 'delete-chunk-source',
    title: 'Delete Chunk Source',
    status: 'ready',
    chunks: [{ content: 'A12 chunk cleanup target.', enabled: 1 }],
  });
  const [chunk] = knowledgeRepo.listChunks(source.id);
  assert.ok(chunk);

  const before = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunk_fts WHERE chunk_id = ?')
    .get(chunk.id) as { count: number };
  assert.equal(before.count, 1);

  db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunk.id);

  const after = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunk_fts WHERE chunk_id = ?')
    .get(chunk.id) as { count: number };
  assert.equal(after.count, 0);
});

function createIndexedSource(input: {
  project_id: string;
  room_id?: string | null;
  source_type: 'uploaded_file' | 'agent_document' | 'resource_asset';
  source_id: string;
  title: string;
  status: 'ready' | 'failed' | 'disabled' | 'processing' | 'pending' | 'stale';
  tags?: string[];
  chunks: Array<{
    content: string;
    heading?: string | null;
    enabled?: 0 | 1;
  }>;
}) {
  const source = knowledgeRepo.ensureSource({
    project_id: input.project_id,
    room_id: input.room_id ?? null,
    source_type: input.source_type,
    source_id: input.source_id,
    title: input.title,
    status: input.status,
    tags: input.tags,
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: input.chunks.map((chunk) => chunk.content).join('\n'),
  });
  knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: input.chunks.map((chunk, index) => ({
      chunk_index: index,
      chunk_type: 'plain_text',
      heading: chunk.heading ?? null,
      content: chunk.content,
      enabled: chunk.enabled ?? 1,
    })),
  });
  return source;
}
