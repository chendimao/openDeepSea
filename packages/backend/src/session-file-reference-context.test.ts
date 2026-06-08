import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-session-file-context-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { fileRepo } = await import('./repos/files.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { buildSessionFileReferenceContext } = await import('./session-file-reference-context.js');

test('buildSessionFileReferenceContext injects bounded source and agent document content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-file-context-project-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = true;\n');
  const project = projectRepo.create({ name: 'context project', path: root });
  const doc = fileRepo.createAgentDocument({
    project_id: project.id,
    title: 'session-design.md',
    content: '# Session Design\n引用设计内容',
  });

  const context = await buildSessionFileReferenceContext({
    project,
    workspacePath: project.path,
    workspaceFileRefs: ['src/app.ts'],
    libraryFileRefs: [doc.id],
  });

  assert.match(context.promptAddition, /Referenced Files/);
  assert.match(context.promptAddition, /Source: src\/app\.ts/);
  assert.match(context.promptAddition, /export const app = true/);
  assert.match(context.promptAddition, /Library: session-design\.md/);
  assert.match(context.promptAddition, /引用设计内容/);
});

test('buildSessionFileReferenceContext injects uploaded text file content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-file-context-upload-'));
  writeFileSync(join(root, 'stored.txt'), 'stored text body must not appear in prompt');
  const project = projectRepo.create({ name: 'upload metadata project', path: root });
  const upload = fileRepo.create({
    project_id: project.id,
    original_name: 'handoff-notes.txt',
    stored_name: 'stored.txt',
    mime_type: 'text/plain',
    size: 2048,
    url: '/uploads/files/project/stored.txt',
    storage_path: join(root, 'stored.txt'),
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });

  const context = await buildSessionFileReferenceContext({
    project,
    workspacePath: project.path,
    workspaceFileRefs: [],
    libraryFileRefs: [upload.id],
  });

  assert.match(context.promptAddition, /Library: handoff-notes\.txt/);
  assert.match(context.promptAddition, /stored text body must not appear in prompt/);
});

test('buildSessionFileReferenceContext prefers knowledge chunks for library file refs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-file-context-knowledge-'));
  const project = projectRepo.create({ name: 'Knowledge Context', path: root });
  const file = fileRepo.create({
    project_id: project.id,
    original_name: 'context.md',
    stored_name: 'context.md',
    mime_type: 'text/markdown',
    size: 32,
    url: '',
    storage_path: '',
    uploaded_by_id: 'user',
    uploaded_by_name: 'You',
  });
  const source = knowledgeRepo.ensureSource({
    project_id: project.id,
    source_type: 'uploaded_file',
    source_id: file.id,
    title: file.original_name,
    status: 'ready',
  });
  knowledgeRepo.saveExtraction({ source_id: source.id, plain_text: 'fallback extraction' });
  knowledgeRepo.replaceChunks(source.id, [{
    chunk_type: 'body',
    content: 'A12 chunk from knowledge source.',
    project_id: project.id,
  }]);

  const context = await buildSessionFileReferenceContext({
    project,
    workspacePath: project.path,
    workspaceFileRefs: [],
    libraryFileRefs: [file.id],
  });

  assert.match(context.promptAddition, /Knowledge: context\.md/);
  assert.match(context.promptAddition, /A12 chunk from knowledge source/);
  assert.match(context.promptAddition, /source_id:/);
  assert.match(context.promptAddition, /chunk_id:/);
});
