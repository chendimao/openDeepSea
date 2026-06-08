import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourceUrl = new URL('./TerminalPanel.tsx', import.meta.url);

test('TerminalPanel wires xterm, session creation, input, resize, kill, and cleanup', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /@xterm\/xterm/);
  assert.match(source, /@xterm\/addon-fit/);
  assert.match(source, /createTerminalSession/);
  assert.match(source, /subscribeTerminal/);
  assert.match(source, /sendTerminalInput/);
  assert.match(source, /resizeTerminal/);
  assert.match(source, /killTerminal/);
  assert.match(source, /killTerminalSession/);
  assert.match(source, /unsubscribeTerminal/);
  assert.match(source, /\.dispose\(\)/);
});

test('TerminalPanel handles terminal websocket events and refresh requests', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /terminal:output/);
  assert.match(source, /terminal:status/);
  assert.match(source, /terminal:exit/);
  assert.match(source, /platform_skills:refresh_requested/);
  assert.match(source, /onRefreshRequested/);
});

test('TerminalPanel can prefill an initial command without appending enter', () => {
  const source = readFileSync(sourceUrl, 'utf8');

  assert.match(source, /initialInput\?: string/);
  assert.match(source, /initialInputSentRef/);
  assert.match(source, /initialInput\?\.trim\(\)/);
  assert.match(source, /sendTerminalInput\(nextSessionId, command\)/);
  assert.doesNotMatch(source, /sendTerminalInput\(nextSessionId, `\$\{command\}\\r`/);
  assert.doesNotMatch(source, /sendTerminalInput\(nextSessionId, `\$\{command\}\\n`/);
});
