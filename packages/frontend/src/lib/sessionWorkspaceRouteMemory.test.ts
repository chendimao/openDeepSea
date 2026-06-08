import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLastSessionWorkspaceHref,
  rememberLastSessionWorkspaceRoute,
  subscribeLastSessionWorkspaceHref,
} from './sessionWorkspaceRouteMemory';

let storedHref: string | null = null;

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => key === 'opendeepsea.lastSessionWorkspaceHref.v1' ? storedHref : null,
    setItem: (key: string, value: string) => {
      if (key === 'opendeepsea.lastSessionWorkspaceHref.v1') storedHref = value;
    },
    removeItem: (key: string) => {
      if (key === 'opendeepsea.lastSessionWorkspaceHref.v1') storedHref = null;
    },
  },
  configurable: true,
});

test('rememberLastSessionWorkspaceRoute stores concrete session routes', () => {
  storedHref = null;

  rememberLastSessionWorkspaceRoute({ active: true, projectId: 'project-1', sessionId: 'session-1' });

  assert.equal(getLastSessionWorkspaceHref(), '/projects/project-1/sessions/session-1');
});

test('rememberLastSessionWorkspaceRoute ignores routes without a session id', () => {
  storedHref = '/projects/project-1/sessions/session-1';

  rememberLastSessionWorkspaceRoute({ active: true, projectId: 'project-2', sessionId: undefined });

  assert.equal(getLastSessionWorkspaceHref(), '/projects/project-1/sessions/session-1');
});

test('getLastSessionWorkspaceHref falls back to root for missing or invalid memory', () => {
  storedHref = null;
  assert.equal(getLastSessionWorkspaceHref(), '/');

  storedHref = '/files';
  assert.equal(getLastSessionWorkspaceHref(), '/');
});

test('subscribeLastSessionWorkspaceHref notifies when memory changes', () => {
  storedHref = null;
  const hrefs: string[] = [];
  const unsubscribe = subscribeLastSessionWorkspaceHref((href) => hrefs.push(href));

  rememberLastSessionWorkspaceRoute({ active: true, projectId: 'project-1', sessionId: 'session-1' });
  unsubscribe();
  rememberLastSessionWorkspaceRoute({ active: true, projectId: 'project-1', sessionId: 'session-2' });

  assert.deepEqual(hrefs, ['/projects/project-1/sessions/session-1']);
});
