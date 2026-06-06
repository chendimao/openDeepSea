import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = () => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.CONNECTING;
  closed = false;
  sent: string[] = [];
  listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static instances: FakeWebSocket[] = [];

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

test('sessionSocket cancels pending connects when unsubscribed before socket creation', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;

  try {
    const { sessionSocket } = await import(`./ws.ts?ws-test-${Date.now()}`);

    sessionSocket.subscribeSession('session-1');
    sessionSocket.unsubscribeSession('session-1');
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(FakeWebSocket.instances.length, 0);
    sessionSocket.destroy();
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.WebSocket = originalWebSocket;
  }
});

test('sessionSocket closes idle connecting sockets after open without reconnecting', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledReconnects = 0;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if ((timeout ?? 0) >= 1000) scheduledReconnects += 1;
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  try {
    const { sessionSocket } = await import(`./ws.ts?ws-test-${Date.now()}`);

    sessionSocket.subscribeSession('session-1');
    await new Promise((resolve) => originalSetTimeout(resolve, 5));
    assert.equal(FakeWebSocket.instances.length, 1);

    const socket = FakeWebSocket.instances[0];
    sessionSocket.unsubscribeSession('session-1');

    assert.equal(socket.closed, false);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    await new Promise((resolve) => originalSetTimeout(resolve, 5));
    assert.equal(socket.closed, true);
    socket.emit('close');

    assert.equal(scheduledReconnects, 0);
    sessionSocket.destroy();
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('sessionSocket queues session messages until websocket opens', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;

  try {
    const { sessionSocket } = await import(`./ws.ts?ws-send-test-${Date.now()}`);
    sessionSocket.subscribeSession('session-1');
    sessionSocket.sendSessionMessage({ sessionId: 'session-1', content: '继续', agentId: 'planner' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)), [
      { type: 'session:subscribe', sessionId: 'session-1' },
      { type: 'session.message.send', sessionId: 'session-1', content: '继续', agentId: 'planner' },
    ]);
    sessionSocket.destroy();
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.WebSocket = originalWebSocket;
  }
});

test('sessionSocket opens for workspace requests before any subscription exists', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;

  try {
    const { sessionSocket } = await import(`./ws.ts?ws-workspace-test-${Date.now()}`);
    sessionSocket.requestSessionWorkspace({ projectId: 'project-1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)), [
      { type: 'session.workspace.request', projectId: 'project-1' },
    ]);
    sessionSocket.destroy();
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.WebSocket = originalWebSocket;
  }
});
