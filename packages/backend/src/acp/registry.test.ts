import test from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultAcpAgentServers } from './registry.js';

test('getDefaultAcpAgentServers includes Claude Code OpenCode and Codex', () => {
  const servers = getDefaultAcpAgentServers();
  assert.deepEqual(servers.map((server) => server.provider).sort(), ['claudecode', 'codex', 'opencode']);
  assert.ok(servers.find((server) => server.provider === 'claudecode')?.command.includes('npx'));
  assert.ok(servers.find((server) => server.provider === 'codex')?.args.includes('@zed-industries/codex-acp'));
  assert.ok(servers.find((server) => server.provider === 'opencode')?.command.includes('opencode'));
});
