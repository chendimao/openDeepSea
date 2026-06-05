import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { wsHub } from './ws-hub.js';

function createSocket() {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;
  return { socket, sent };
}

test('session subscriptions receive session broadcasts without room broadcasts', () => {
  const sessionSocket = createSocket();
  const roomSocket = createSocket();

  wsHub.subscribeSession('session-1', sessionSocket.socket);
  wsHub.subscribe('room-1', roomSocket.socket);

  wsHub.broadcastSession('session-1', {
    type: 'session_run:stream',
    sessionId: 'session-1',
    runId: 'run-1',
    chunk: 'hello',
    channel: 'answer',
    done: false,
  });

  assert.equal(sessionSocket.sent.length, 1);
  assert.equal(JSON.parse(sessionSocket.sent[0]!).type, 'session_run:stream');
  assert.equal(roomSocket.sent.length, 0);

  wsHub.removeSocket(sessionSocket.socket);
  wsHub.removeSocket(roomSocket.socket);
});

test('removeSocket clears session subscriptions', () => {
  const sessionSocket = createSocket();
  wsHub.subscribeSession('session-remove', sessionSocket.socket);
  wsHub.removeSocket(sessionSocket.socket);

  wsHub.broadcastSession('session-remove', {
    type: 'session_run:stream',
    sessionId: 'session-remove',
    runId: 'run-1',
    chunk: 'after remove',
    channel: 'answer',
    done: false,
  });

  assert.equal(sessionSocket.sent.length, 0);
});
