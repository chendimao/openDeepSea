import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resetProviderSuperpowersStatusForTest,
  startProviderSuperpowersStartupInstall,
  type ProviderSuperpowersCommandRunner,
} from './provider-superpowers.js';

test.afterEach(() => {
  resetProviderSuperpowersStatusForTest();
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
