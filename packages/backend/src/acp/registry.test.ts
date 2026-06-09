import test from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultAcpAgentServers } from './registry.js';

test('getDefaultAcpAgentServers includes Claude Code OpenCode and Codex', () => {
  const servers = getDefaultAcpAgentServers();
  assert.deepEqual(servers.map((server) => server.provider).sort(), ['claudecode', 'codex', 'opencode']);
  assert.ok(servers.find((server) => server.provider === 'claudecode')?.command.includes('npx'));
  assert.equal(servers.find((server) => server.provider === 'codex')?.command, process.execPath);
  assert.equal(
    servers.find((server) => server.provider === 'codex')?.args[0]?.endsWith('/node_modules/@zed-industries/codex-acp/bin/codex-acp.js'),
    true,
  );
  assert.ok(servers.find((server) => server.provider === 'opencode')?.command.includes('opencode'));
});
