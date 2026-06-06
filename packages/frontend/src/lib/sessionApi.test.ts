import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from './api';

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

test('updateSessionContract patches session contract endpoint', async () => {
  const fetchLog = installFetchStub({ sessionId: 'session-1' });
  try {
    await api.updateSessionContract('session-1', {
      scope: '只改接入',
      risks: ['风险'],
      acceptanceCriteria: ['验收'],
    });
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/sessions/session-1/contract');
  assert.equal(fetchLog.calls[0]?.method, 'PATCH');
});

test('discardCompact posts compaction id to discard endpoint', async () => {
  const fetchLog = installFetchStub({ id: 'compact-1', status: 'discarded' });
  try {
    await api.discardCompact('session-1', 'compact-1');
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/sessions/session-1/compact/discard');
  assert.deepEqual(JSON.parse(fetchLog.calls[0]?.body ?? '{}'), { compaction_id: 'compact-1' });
});

test('listHistoryRecords sends q status and mode query params', async () => {
  const fetchLog = installFetchStub([]);
  try {
    await api.listHistoryRecords('project-1', { q: '工具', status: 'archived', mode: 'code' });
  } finally {
    fetchLog.restore();
  }

  assert.equal(fetchLog.calls[0]?.url, '/api/projects/project-1/history-records?q=%E5%B7%A5%E5%85%B7&status=archived&mode=code');
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
