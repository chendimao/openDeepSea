import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  resetProviderSuperpowersStatusForTest,
  startProviderSuperpowersStartupInstall,
  type ProviderSuperpowersCommandRunner,
} from './provider-superpowers.js';

const originalHome = process.env.HOME;

test.afterEach(() => {
  resetProviderSuperpowersStatusForTest();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

test('startup install adds Codex Superpowers when plugin is missing', async () => {
  let codexListCalls = 0;
  const commands: string[] = [];
  const runner: ProviderSuperpowersCommandRunner = {
    async run(command, args) {
      commands.push([command, ...args].join(' '));
      if (command === 'claude' || command === 'opencode') {
        throw new Error(`${command} missing`);
      }
      if (command === 'codex' && args.join(' ') === '--version') {
        return { stdout: 'codex-cli 0.134.0\n', stderr: '' };
      }
      if (command === 'codex' && args.join(' ') === 'plugin list') {
        codexListCalls += 1;
        return {
          stdout: codexListCalls === 1
            ? 'superpowers@openai-curated not installed /tmp/superpowers\n'
            : 'superpowers@openai-curated installed 5.1.0 /tmp/superpowers\n',
          stderr: '',
        };
      }
      if (command === 'codex' && args.join(' ') === 'plugin add superpowers@openai-curated') {
        return { stdout: 'installed\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  const status = await startProviderSuperpowersStartupInstall(runner);
  const codex = status.providers.find((provider) => provider.provider === 'codex');

  assert.equal(codex?.cli_installed, true);
  assert.equal(codex?.superpowers_installed, true);
  assert.equal(codex?.install_attempted, true);
  assert.equal(codex?.install_status, 'installed_by_startup');
  assert.ok(commands.includes('codex plugin add superpowers@openai-curated'));
});

test('startup install does not prompt Claude Code to install Superpowers', async () => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'openclaw-room-provider-superpowers-home-'));
  const commands: string[] = [];
  const runner: ProviderSuperpowersCommandRunner = {
    async run(command, args) {
      commands.push([command, ...args].join(' '));
      if (command === 'claude' && args.join(' ') === '--version') {
        return { stdout: '1.0.0 (Claude Code)\n', stderr: '' };
      }
      if (command === 'codex' || command === 'opencode') {
        throw new Error(`${command} missing`);
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
  };

  const status = await startProviderSuperpowersStartupInstall(runner);
  const claude = status.providers.find((provider) => provider.provider === 'claude');

  assert.equal(claude?.cli_installed, true);
  assert.equal(claude?.superpowers_installed, false);
  assert.equal(claude?.install_attempted, false);
  assert.equal(claude?.install_status, 'unsupported');
  assert.ok(claude?.message?.includes('暂无受支持的非交互全局安装方式'));
  assert.ok(!commands.some((command) => command.startsWith('claude -p ')));
});

test('startup install reports missing provider CLIs without attempting install', async () => {
  const runner: ProviderSuperpowersCommandRunner = {
    async run(command) {
      throw new Error(`${command} missing`);
    },
  };

  const status = await startProviderSuperpowersStartupInstall(runner);

  assert.equal(status.running, false);
  assert.equal(status.providers.length, 3);
  assert.ok(status.providers.every((provider) => provider.install_status === 'cli_missing'));
  assert.ok(status.providers.every((provider) => provider.install_attempted === false));
});
