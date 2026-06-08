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

test('sessionSocket subscribes and unsubscribes project image events', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;

  try {
    const { sessionSocket } = await import(`./ws.ts?image-ws-test-${Date.now()}`);
    sessionSocket.subscribeProject('project-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)), [
      { type: 'project:subscribe', projectId: 'project-1' },
    ]);

    sessionSocket.unsubscribeProject('project-1');
    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)).at(-1), {
      type: 'project:unsubscribe',
      projectId: 'project-1',
    });
    sessionSocket.destroy();
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.WebSocket = originalWebSocket;
  }
});

test('sessionSocket restores project subscriptions after reconnect', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;
  globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    const { sessionSocket } = await import(`./ws.ts?image-ws-reconnect-test-${Date.now()}`);
    sessionSocket.subscribeProject('project-1');
    await new Promise((resolve) => originalSetTimeout(resolve, 5));
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.emit('open');
    firstSocket.emit('close');

    await new Promise((resolve) => originalSetTimeout(resolve, 5));
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.readyState = FakeWebSocket.OPEN;
    secondSocket.emit('open');

    assert.equal(FakeWebSocket.instances.length, 2);
    assert.deepEqual(secondSocket.sent.map((payload) => JSON.parse(payload)), [
      { type: 'project:subscribe', projectId: 'project-1' },
    ]);
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

test('sessionSocket destroy clears project subscriptions before close events reconnect', async () => {
  FakeWebSocket.instances = [];
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost:5173' } },
  });
  globalThis.WebSocket = FakeWebSocket as never;
  globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    const { sessionSocket } = await import(`./ws.ts?image-ws-destroy-test-${Date.now()}`);
    sessionSocket.subscribeProject('project-1');
    await new Promise((resolve) => originalSetTimeout(resolve, 5));
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    sessionSocket.destroy();
    socket.emit('close');
    await new Promise((resolve) => originalSetTimeout(resolve, 5));

    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
  }
});
