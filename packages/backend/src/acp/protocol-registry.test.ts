import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { getAcpServerConfig, getDefaultCodexAcpInvocation, parseAcpMode, splitCommand } from './protocol-registry.js';

test('parseAcpMode defaults to auto for unset values', () => {
  assert.equal(parseAcpMode(undefined), 'auto');
});

test('parseAcpMode preserves supported modes', () => {
  assert.equal(parseAcpMode('auto'), 'auto');
  assert.equal(parseAcpMode('protocol'), 'protocol');
  assert.equal(parseAcpMode('legacy'), 'legacy');
});

test('parseAcpMode falls back to auto for invalid values', () => {
  assert.equal(parseAcpMode('invalid'), 'auto');
});

test('splitCommand separates quiet npx codex ACP command', () => {
  assert.deepEqual(splitCommand('npx --yes --loglevel=error @zed-industries/codex-acp'), {
    command: 'npx',
    args: ['--yes', '--loglevel=error', '@zed-industries/codex-acp'],
  });
});

test('splitCommand separates opencode ACP command', () => {
  assert.deepEqual(splitCommand('opencode acp'), {
    command: 'opencode',
    args: ['acp'],
  });
});

test('splitCommand preserves single-quoted executable paths', () => {
  assert.deepEqual(splitCommand("'/path with space/bin' acp"), {
    command: '/path with space/bin',
    args: ['acp'],
  });
});

test('splitCommand preserves double-quoted executable paths', () => {
  assert.deepEqual(splitCommand('"/path with space/bin" acp'), {
    command: '/path with space/bin',
    args: ['acp'],
  });
});

test('splitCommand supports escaped whitespace outside quotes', () => {
  assert.deepEqual(splitCommand('/path\\ with\\ space/bin acp'), {
    command: '/path with space/bin',
    args: ['acp'],
  });
});

test('splitCommand rejects empty quoted command', () => {
  assert.throws(() => splitCommand('"" --debug'), /ACP command is empty/);
});

test('splitCommand rejects unmatched quote', () => {
  assert.throws(() => splitCommand('"/path with space/bin acp'), /ACP command has unmatched quote/);
});

test('getAcpServerConfig returns default codex protocol server config', () => {
  const config = getAcpServerConfig('codex', {});

  assert.equal(config.backend, 'codex');
  assert.equal(config.mode, 'auto');
  assert.equal(config.command, process.execPath);
  assert.equal(config.args.length, 1);
  assert.equal(config.args[0]?.endsWith('/node_modules/@zed-industries/codex-acp/bin/codex-acp.js'), true);
  assert.equal(isAbsolute(config.args[0] ?? ''), true);
  assert.deepEqual(config.env, {});
  assert.equal(config.transport, 'stdio');
  assert.equal(config.enabled, true);
});

test('getAcpServerConfig appends Codex reasoning effort when configured', () => {
  const config = getAcpServerConfig('codex', {
    OPENCLAW_ACP_CODEX_REASONING_EFFORT: 'high',
  });

  assert.deepEqual(config.args.slice(1), ['-c', 'model_reasoning_effort=high']);
});

test('getAcpServerConfig does not duplicate Codex reasoning effort args', () => {
  assert.deepEqual(
    getAcpServerConfig('codex', {
      OPENCLAW_ACP_CODEX_COMMAND: 'npx @zed-industries/codex-acp -c model_reasoning_effort=medium',
      OPENCLAW_ACP_CODEX_REASONING_EFFORT: 'high',
    }).args,
    ['@zed-industries/codex-acp', '-c', 'model_reasoning_effort=medium'],
  );
});

test('getDefaultCodexAcpInvocation resolves installed Codex ACP binary', () => {
  const invocation = getDefaultCodexAcpInvocation();

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args.length, 1);
  assert.equal(invocation.args[0]?.endsWith('/node_modules/@zed-industries/codex-acp/bin/codex-acp.js'), true);
});

test('getAcpServerConfig applies opencode command override in protocol mode', () => {
  assert.deepEqual(
    getAcpServerConfig('opencode', {
      OPENCLAW_ACP_MODE: 'protocol',
      OPENCLAW_ACP_OPENCODE_COMMAND: '/usr/local/bin/opencode acp --debug',
    }),
    {
      backend: 'opencode',
      mode: 'protocol',
      command: '/usr/local/bin/opencode',
      args: ['acp', '--debug'],
      env: {},
      transport: 'stdio',
      enabled: true,
    },
  );
});

test('getAcpServerConfig includes project-owned superpowers disable env', () => {
  const config = getAcpServerConfig('opencode', {
    OPENCLAW_ACP_MODE: 'protocol',
    OPENCLAW_SUPERPOWERS_BOOTSTRAP_OWNER: 'project',
  });

  assert.equal(config.env?.OPENDEEPSEA_SUPERPOWERS_BOOTSTRAP_OWNER, 'project');
  assert.equal(config.env?.SUPERPOWERS_BOOTSTRAP_DISABLED, '1');
});

test('getAcpServerConfig disables protocol server config in legacy mode', () => {
  const config = getAcpServerConfig('claudecode', {
    OPENCLAW_ACP_MODE: 'legacy',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'legacy');
});
