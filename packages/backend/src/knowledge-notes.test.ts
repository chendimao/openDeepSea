import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-knowledge-notes-')), 'test.db');
process.env.OPENCLAW_ACP_MESSAGE_INTENT_CLASSIFIER = '0';
process.env.OPENCLAW_ACP_TASK_ANALYZER = '0';

const { projectRepo } = await import('./repos/projects.js');
const { sessionRepo, sessionMessageRepo } = await import('./repos/sessions.js');
const { knowledgeRepo } = await import('./repos/knowledge.js');
const { createSessionKnowledgeNote } = await import('./knowledge-notes.js');
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
  if (body) req.headers['content-length'] = String(body.byteLength);

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
      else if (!res.headersSent) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });

  if (body) req.push(body);
  req.push(null);
  req.complete = true;

  return responsePromise;
}

function createProject(name: string) {
  return projectRepo.create({
    name,
    path: mkdtempSync(join(tmpdir(), `opendeepsea-note-${name}-`)),
  });
}

function createSession(projectId: string, title = 'Knowledge Session') {
  return sessionRepo.create({
    project_id: projectId,
    title,
    provider: 'codex',
    workspace_path: mkdtempSync(join(tmpdir(), 'opendeepsea-note-session-')),
  });
}

function noteContent(): string {
  return [
    '# Phase 3 知识沉淀结论',
    '',
    '- 决策：采用 session_note 写入知识库，避免把短笔记伪装成文件。',
    '- 约束：不做 embedding，也不自动保存所有会话消息。',
    '- 风险：完全相同 hash 去重无法发现语义重复。',
    '- 经验：保存时同步生成 citation 可检索 chunk，后续 Agent RAG 可复用。',
  ].join('\n');
}

test('createSessionKnowledgeNote saves a session message as searchable session_note', () => {
  const project = createProject('save-message');
  const session = createSession(project.id);
  const message = sessionMessageRepo.create({
    session_id: session.id,
    role: 'assistant',
    sender_id: 'planner',
    sender_name: 'Planner',
    content: noteContent(),
  });

  const result = createSessionKnowledgeNote({
    sessionId: session.id,
    messageId: message.id,
  });

  assert.equal(result.deduplicated, false);
  assert.equal(result.source.project_id, project.id);
  assert.equal(result.source.source_type, 'session_note');
  assert.equal(result.source.status, 'ready');
  assert.match(result.source.source_id, new RegExp(`^session_note:${session.id}:`));
  assert.equal(result.source.metadata.session_id, session.id);
  assert.equal(result.source.metadata.source_message_id, message.id);
  assert.equal(result.source.metadata.source_agent_id, 'planner');

  const extraction = knowledgeRepo.getLatestExtraction(result.source.id);
  assert.match(extraction?.plain_text ?? '', /Phase 3 知识沉淀结论/);
  assert.ok(knowledgeRepo.listChunks(result.source.id).length > 0);
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'Phase' }).length, 1);
  assert.equal(knowledgeRepo.search({ projectId: project.id, query: 'Agent RAG' }).length, 1);
});

test('createSessionKnowledgeNote deduplicates identical content within the same session', () => {
  const project = createProject('dedupe');
  const session = createSession(project.id);
  const message = sessionMessageRepo.create({
    session_id: session.id,
    role: 'assistant',
    sender_id: 'planner',
    content: noteContent(),
  });

  const first = createSessionKnowledgeNote({ sessionId: session.id, messageId: message.id });
  const second = createSessionKnowledgeNote({ sessionId: session.id, messageId: message.id });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.source.id, first.source.id);
  assert.equal(knowledgeRepo.listSources({
    projectId: project.id,
    sourceTypes: ['session_note'],
  }).length, 1);
});

test('createSessionKnowledgeNote rejects a message outside the target session', () => {
  const project = createProject('foreign-message');
  const session = createSession(project.id, 'Target');
  const otherSession = createSession(project.id, 'Other');
  const foreignMessage = sessionMessageRepo.create({
    session_id: otherSession.id,
    role: 'assistant',
    sender_id: 'planner',
    content: noteContent(),
  });

  assert.throws(
    () => createSessionKnowledgeNote({ sessionId: session.id, messageId: foreignMessage.id }),
    /message does not belong to session/,
  );
});

test('createSessionKnowledgeNote extracts decisions constraints risks and learnings', () => {
  const project = createProject('metadata');
  const session = createSession(project.id);

  const result = createSessionKnowledgeNote({
    sessionId: session.id,
    title: '知识沉淀复盘',
    content: [
      '结论：保留项目级 scope，不做跨项目共享。',
      '必须保留 citation key，禁止读取本机绝对路径。',
      '注意：重复检测只处理完全相同正文。',
      '正确做法：把经验沉淀为 session_note metadata，便于检索。',
    ].join('\n'),
  });

  assert.match(result.metadata.decisions.join('\n'), /项目级 scope/);
  assert.match(result.metadata.constraints.join('\n'), /citation key/);
  assert.match(result.metadata.risks.join('\n'), /重复检测/);
  assert.match(result.metadata.learnings.join('\n'), /session_note metadata/);
  assert.deepEqual(result.source.metadata.decisions, result.metadata.decisions);
  assert.deepEqual(result.source.metadata.constraints, result.metadata.constraints);
  assert.deepEqual(result.source.metadata.risks, result.metadata.risks);
  assert.deepEqual(result.source.metadata.learnings, result.metadata.learnings);
});

test('POST /api/sessions/:sessionId/knowledge-notes saves message notes and deduplicates repeats', async () => {
  const project = createProject('api-save');
  const session = createSession(project.id);
  const message = sessionMessageRepo.create({
    session_id: session.id,
    role: 'assistant',
    sender_id: 'planner',
    content: noteContent(),
  });

  const firstRes = await request(`/api/sessions/${session.id}/knowledge-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: message.id }),
  });
  assert.equal(firstRes.status, 201);
  const first = await firstRes.json() as {
    source: { id: string; source_type: string; status: string };
    deduplicated: boolean;
  };
  assert.equal(first.source.source_type, 'session_note');
  assert.equal(first.source.status, 'ready');
  assert.equal(first.deduplicated, false);

  const secondRes = await request(`/api/sessions/${session.id}/knowledge-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: message.id }),
  });
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json() as {
    source: { id: string };
    deduplicated: boolean;
  };
  assert.equal(second.source.id, first.source.id);
  assert.equal(second.deduplicated, true);
});

test('POST /api/sessions/:sessionId/knowledge-notes validates session and message scope', async () => {
  const project = createProject('api-scope');
  const session = createSession(project.id);
  const otherSession = createSession(project.id);
  const foreignMessage = sessionMessageRepo.create({
    session_id: otherSession.id,
    role: 'assistant',
    sender_id: 'planner',
    content: noteContent(),
  });

  const missingSessionRes = await request('/api/sessions/missing-session/knowledge-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '结论：保存为知识。' }),
  });
  assert.equal(missingSessionRes.status, 404);

  const foreignMessageRes = await request(`/api/sessions/${session.id}/knowledge-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: foreignMessage.id }),
  });
  assert.equal(foreignMessageRes.status, 400);
  assert.match(await foreignMessageRes.text(), /message does not belong to session/);
});
