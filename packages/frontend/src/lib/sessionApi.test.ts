import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';

test('getSessionWorkspace requests project session workspace endpoint', async () => {
  const fetchLog = installFetchStub({ activeSession: { session: { id: 'session-1' } } });
  try {
    await api.getSessionWorkspace('project-1');
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/projects/project-1/session-workspace');
  assert.equal(fetchLog.calls[0]?.method, 'GET');
});

test('sendSessionMessage posts content and mode to session message endpoint', async () => {
  const fetchLog = installFetchStub({ message: { id: 'message-1' } });
  try {
    await api.sendSessionMessage('session-1', { content: '继续执行', mode: 'code' });
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/sessions/session-1/messages');
  assert.equal(fetchLog.calls[0]?.method, 'POST');
  assert.deepEqual(JSON.parse(fetchLog.calls[0]?.body ?? '{}'), { content: '继续执行', mode: 'code' });
});

test('applyCompact includes compaction id in request body', async () => {
  const fetchLog = installFetchStub({ id: 'compact-1', status: 'applied' });
  try {
    await api.applyCompact('session-1', 'compact-1', {
      applied_summary: '保留关键决策',
      user_edited: true,
    });
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/sessions/session-1/compact/apply');
  assert.deepEqual(JSON.parse(fetchLog.calls[0]?.body ?? '{}'), {
    compaction_id: 'compact-1',
    applied_summary: '保留关键决策',
    user_edited: true,
  });
});

test('forkHistoryRecord posts provider overrides to history fork endpoint', async () => {
  const fetchLog = installFetchStub({ activeSession: { session: { id: 'fork-1' } } });
  try {
    await api.forkHistoryRecord('history-1', { provider: 'codex', model: 'gpt-test' });
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/history-records/history-1/fork');
  assert.deepEqual(JSON.parse(fetchLog.calls[0]?.body ?? '{}'), {
    provider: 'codex',
    model: 'gpt-test',
  });
});

function installFetchStub(responseBody: unknown) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
