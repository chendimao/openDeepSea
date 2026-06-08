import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebSocket } from 'ws';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-terminal-socket-db-')), 'test.db');
process.env.OPENDEEPSEA_TERMINAL_CWD = mkdtempSync(join(tmpdir(), 'opendeepsea-terminal-socket-cwd-'));

const { handleTerminalSocketEvent, removeTerminalSocket } = await import('./socket-controller.js');
const { terminalService } = await import('./service.js');

function createSocket() {
  const sent: string[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(payload),
  } as unknown as WebSocket;
  return { socket, sent };
}

test('terminal socket controller subscribes and receives restricted prompt output', () => {
  const session = terminalService.create({ profile: 'skills_install', cols: 80, rows: 24 });
  const { socket, sent } = createSocket();

  const handled = handleTerminalSocketEvent(socket, { type: 'terminal:subscribe', sessionId: session.id });
  assert.equal(handled, true);
  assert.equal(JSON.parse(sent[0]!).type, 'terminal:ready');
  assert.equal(sent.some((payload) => JSON.parse(payload).type === 'terminal:output'), true);

  removeTerminalSocket(socket);
  terminalService.kill(session.id);
});

test('terminal socket controller forwards restricted local commands', () => {
  const session = terminalService.create({ profile: 'skills_install', cols: 80, rows: 24 });
  const { socket, sent } = createSocket();
  handleTerminalSocketEvent(socket, { type: 'terminal:subscribe', sessionId: session.id });

  handleTerminalSocketEvent(socket, { type: 'terminal:input', sessionId: session.id, data: 'pwd\r' });

  const output = sent.map((payload) => JSON.parse(payload))
    .filter((event) => event.type === 'terminal:output')
    .map((event) => event.data)
    .join('');
  assert.match(output, new RegExp(process.env.OPENDEEPSEA_TERMINAL_CWD!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  removeTerminalSocket(socket);
  terminalService.kill(session.id);
});
