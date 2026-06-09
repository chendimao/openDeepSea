import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-cli-')), 'test.db');

const { db } = await import('./db.js');
const { projectRepo } = await import('./repos/projects.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { rebuildKnowledgeEmbeddings } = await import('./knowledge-embedding-rebuild.js');
const { runKnowledgeCli } = await import('./knowledge-cli.js');

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-knowledge-cli-${name}-`)),
  });
}

function createReadySource(projectId: string) {
  const source = knowledgeRepo.ensureSource({
    project_id: projectId,
    source_type: 'uploaded_file',
    source_id: `cli-source-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'CLI A12 Runbook',
    status: 'ready',
    summary: 'CLI 检索摘要',
    tags: ['CLI'],
  });
  const extraction = knowledgeRepo.saveExtraction({
    source_id: source.id,
    plain_text: 'A12 CLI search content.',
    markdown: 'A12 CLI search content.',
  });
  const [chunk] = knowledgeRepo.replaceChunks({
    source_id: source.id,
    extraction_id: extraction.id,
    chunks: [{
      chunk_index: 0,
      chunk_type: 'body',
      content: 'A12 CLI search content.',
    }],
  });
  return { source, chunk: chunk! };
}

test('runKnowledgeCli searches knowledge and records usage from env', async () => {
  const project = createProject('search');
  const { source } = createReadySource(project.id);
  await rebuildKnowledgeEmbeddings({ projectId: project.id, sourceId: source.id });

  const result = await runKnowledgeCli(
    ['search', '--project', project.id, '--query', 'A12 CLI', '--limit', '3'],
    {
      OPENDEEPSEA_AGENT_RUN_ID: 'agent-run-cli-1',
      OPENDEEPSEA_ROOM_ID: 'room-env-1',
    },
  ) as { source: string; embedding_provider: string | null; embedding_model: string | null; results: Array<{ citation_key: string }> };

  assert.equal(result.source, 'openclaw.knowledge.search');
  assert.equal(result.embedding_provider, 'local-hash');
  assert.equal(result.embedding_model, 'local-hash-v1');
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]?.citation_key ?? '', new RegExp(`knowledge:${source.id}`));

  const row = db.prepare('SELECT ref_type, ref_id, metadata_json FROM knowledge_usage_refs WHERE source_id = ?')
    .get(source.id) as { ref_type: string; ref_id: string; metadata_json: string } | undefined;
  assert.equal(row?.ref_type, 'agent_run');
  assert.equal(row?.ref_id, 'agent-run-cli-1');
  assert.match(row?.metadata_json ?? '', /room-env-1/);
});

test('runKnowledgeCli supports search mode from flag and env default', async () => {
  const project = createProject('search-mode');
  createReadySource(project.id);

  const explicit = await runKnowledgeCli(
    ['search', '--project', project.id, '--query', 'A12 CLI', '--mode', 'hybrid'],
    { OPENDEEPSEA_AGENT_RUN_ID: 'agent-run-mode-1' },
  ) as { retrieval_mode: string };
  assert.equal(explicit.retrieval_mode, 'hybrid');

  const fromEnv = await runKnowledgeCli(
    ['search', '--project', project.id, '--query', 'A12 CLI'],
    { OPENDEEPSEA_KNOWLEDGE_SEARCH_MODE: 'vector_preview' },
  ) as { retrieval_mode: string };
  assert.equal(fromEnv.retrieval_mode, 'vector_preview');

  assert.throws(
    () => runKnowledgeCli(['search', '--project', project.id, '--query', 'A12 CLI', '--mode', 'semantic'], {}),
    /--mode must be keyword, vector_preview, or hybrid/,
  );
});

test('runKnowledgeCli reads chunk and source summary', () => {
  const project = createProject('read');
  const { source, chunk } = createReadySource(project.id);

  const chunkResult = runKnowledgeCli(
    ['read-chunk', '--project', project.id, '--chunk', chunk.id],
    { OPENDEEPSEA_SESSION_RUN_ID: 'session-run-cli-1', OPENDEEPSEA_SESSION_ID: 'session-1' },
  ) as { results: { chunk_id: string; content: string } };
  assert.equal(chunkResult.results.chunk_id, chunk.id);
  assert.match(chunkResult.results.content, /A12 CLI/);

  const summaryResult = runKnowledgeCli(
    ['source-summary', '--project', project.id, '--source', source.id, '--mode', 'auto'],
    {},
  ) as { retrieval_mode: string; results: { id: string; content?: string } };
  assert.equal(summaryResult.results.id, source.id);
  assert.equal(summaryResult.retrieval_mode, 'full_context');
  assert.match(summaryResult.results.content ?? '', /A12 CLI/);
});

test('runKnowledgeCli lists sources and exposes help', () => {
  const project = createProject('list');
  createReadySource(project.id);

  const listResult = runKnowledgeCli(['list-sources', '--project', project.id, '--limit', '5'], {}) as {
    results: Array<{ title: string }>;
  };
  assert.deepEqual(listResult.results.map((item) => item.title), ['CLI A12 Runbook']);

  const help = runKnowledgeCli(['help'], {}) as { commands: string[] };
  assert.ok(help.commands.some((command) => command.startsWith('search')));
});

test('runKnowledgeCli rejects unknown commands and missing required arguments', () => {
  assert.throws(() => runKnowledgeCli(['unknown'], {}), /unknown command/);
  assert.throws(() => runKnowledgeCli(['search', '--project', 'project-1'], {}), /--query is required/);
});
