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
    agentId: 'planner',
    runId: 'run-1',
    seq: 1,
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
    agentId: 'planner',
    runId: 'run-1',
    seq: 1,
    chunk: 'after remove',
    channel: 'answer',
    done: false,
  });

  assert.equal(sessionSocket.sent.length, 0);
});

test('session stream broadcasts include agent and sequence envelope', () => {
  const sessionSocket = createSocket();
  wsHub.subscribeSession('session-envelope', sessionSocket.socket);

  wsHub.broadcastSession('session-envelope', {
    type: 'session_run:stream',
    sessionId: 'session-envelope',
    agentId: 'planner',
    runId: 'run-1',
    seq: 7,
    chunk: 'hello',
    channel: 'answer',
    done: false,
  });

  const event = JSON.parse(sessionSocket.sent[0]!);
  assert.equal(event.agentId, 'planner');
  assert.equal(event.seq, 7);

  wsHub.removeSocket(sessionSocket.socket);
});

test('active session subscribers receive upsert and remove broadcasts', () => {
  const activeSocket = createSocket();
  const sessionSocket = createSocket();

  wsHub.subscribeActiveSessions(activeSocket.socket);
  wsHub.subscribeSession('session-active', sessionSocket.socket);

  wsHub.broadcastActiveSessions({
    type: 'active_session:upsert',
    session: {
      id: 'session-active',
      project_id: 'project-1',
      project_name: 'Project 1',
      project_path: '/tmp/project-1',
      title: '活跃会话',
      status: 'active',
      phase: 'idle',
      provider: null,
      model: null,
      pinned_at: null,
      created_at: 1,
      last_viewed_at: null,
      updated_at: 1,
      unread_count: 0,
      active_run_count: 0,
      latest_event_summary: null,
    },
  });
  wsHub.broadcastActiveSessions({
    type: 'active_session:remove',
    sessionId: 'session-active',
  });

  assert.deepEqual(activeSocket.sent.map((payload) => JSON.parse(payload).type), [
    'active_session:upsert',
    'active_session:remove',
  ]);
  assert.equal(sessionSocket.sent.length, 0);

  wsHub.removeSocket(activeSocket.socket);
  wsHub.removeSocket(sessionSocket.socket);
});

test('project subscribers receive image generation job broadcasts', () => {
  const projectSocket = createSocket();
  const otherProjectSocket = createSocket();
  const roomSocket = createSocket();

  wsHub.subscribeProject('project-image-1', projectSocket.socket);
  wsHub.subscribeProject('project-image-other', otherProjectSocket.socket);
  wsHub.subscribe('room-image-1', roomSocket.socket);

  wsHub.broadcastProject('project-image-1', {
    type: 'image_job:updated',
    projectId: 'project-image-1',
    sessionId: null,
    roomId: 'room-image-1',
    job: {
      id: 'job-image-1',
      project_id: 'project-image-1',
      room_id: 'room-image-1',
      session_id: null,
      source_message_id: null,
      source_agent_id: null,
      source_task_id: null,
      provider_profile_id: 'profile-image-1',
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      status: 'running',
      message: null,
      error: null,
      created_at: 1,
      started_at: 2,
      completed_at: null,
      updated_at: 2,
    },
  });

  assert.equal(projectSocket.sent.length, 1);
  assert.equal(JSON.parse(projectSocket.sent[0]!).type, 'image_job:updated');
  assert.equal(otherProjectSocket.sent.length, 0);
  assert.equal(roomSocket.sent.length, 0);

  wsHub.removeSocket(projectSocket.socket);
  wsHub.removeSocket(otherProjectSocket.socket);
  wsHub.removeSocket(roomSocket.socket);
});

test('scoped broadcasts send image generation events once per socket', () => {
  const sharedSocket = createSocket();
  const projectOnlySocket = createSocket();
  const sessionOnlySocket = createSocket();
  const roomOnlySocket = createSocket();

  wsHub.subscribeProject('project-image-dedupe', sharedSocket.socket);
  wsHub.subscribeSession('session-image-dedupe', sharedSocket.socket);
  wsHub.subscribe('room-image-dedupe', sharedSocket.socket);
  wsHub.subscribeProject('project-image-dedupe', projectOnlySocket.socket);
  wsHub.subscribeSession('session-image-dedupe', sessionOnlySocket.socket);
  wsHub.subscribe('room-image-dedupe', roomOnlySocket.socket);

  wsHub.broadcastScoped({
    projectId: 'project-image-dedupe',
    sessionId: 'session-image-dedupe',
    roomId: 'room-image-dedupe',
    event: {
      type: 'image_job:output_added',
      projectId: 'project-image-dedupe',
      sessionId: 'session-image-dedupe',
      roomId: 'room-image-dedupe',
      jobId: 'job-image-dedupe',
      output: {
        id: 'output-image-dedupe',
        job_id: 'job-image-dedupe',
        file_id: 'file-image-dedupe',
        slot: 1,
        name: 'dedupe.png',
        url: '/api/files/file-image-dedupe/content',
        mime_type: 'image/png',
        size: 3,
        width: null,
        height: null,
        created_at: 1,
      },
    },
  });

  assert.equal(sharedSocket.sent.length, 1);
  assert.equal(projectOnlySocket.sent.length, 1);
  assert.equal(sessionOnlySocket.sent.length, 1);
  assert.equal(roomOnlySocket.sent.length, 1);

  wsHub.removeSocket(sharedSocket.socket);
  wsHub.removeSocket(projectOnlySocket.socket);
  wsHub.removeSocket(sessionOnlySocket.socket);
  wsHub.removeSocket(roomOnlySocket.socket);
});

test('broadcastAll sends once per socket and continues after send errors', () => {
  const sharedSocket = createSocket();
  const healthySocket = createSocket();
  let failingSendCalls = 0;
  const failingSocket = {
    OPEN: 1,
    readyState: 1,
    send: () => {
      failingSendCalls += 1;
      throw new Error('send failed');
    },
  } as unknown as WebSocket;

  wsHub.subscribeProject('project-broadcast-all', sharedSocket.socket);
  wsHub.subscribeSession('session-broadcast-all', sharedSocket.socket);
  wsHub.subscribeProject('project-broadcast-all', failingSocket);
  wsHub.subscribeSession('session-broadcast-all', healthySocket.socket);

  wsHub.broadcastAll({
    type: 'active_session:remove',
    sessionId: 'session-broadcast-all',
  });

  assert.equal(sharedSocket.sent.length, 1);
  assert.equal(failingSendCalls, 1);
  assert.equal(healthySocket.sent.length, 1);

  wsHub.removeSocket(sharedSocket.socket);
  wsHub.removeSocket(healthySocket.socket);
  wsHub.removeSocket(failingSocket);
});
