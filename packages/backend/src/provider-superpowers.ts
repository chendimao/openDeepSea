import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const COMMAND_TIMEOUT_MS = 120_000;
const OPENCODE_SUPERPOWERS_SPEC = 'superpowers@git+https://github.com/obra/superpowers.git';

export type ProviderSuperpowersProvider = 'claude' | 'codex' | 'opencode';
export type ProviderSuperpowersInstallStatus =
  | 'not_started'
  | 'installed'
  | 'installed_by_startup'
  | 'installing'
  | 'failed'
  | 'unsupported'
  | 'cli_missing';

export interface ProviderSuperpowersCheck {
  provider: ProviderSuperpowersProvider;
  label: string;
  cli_installed: boolean;
  version: string | null;
  superpowers_installed: boolean;
  install_attempted: boolean;
  install_status: ProviderSuperpowersInstallStatus;
  message: string | null;
  checked_at: number;
}

export interface ProviderSuperpowersStatus {
  started_at: number | null;
  completed_at: number | null;
  running: boolean;
  providers: ProviderSuperpowersCheck[];
}

export interface ProviderSuperpowersCommandRunner {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const PROVIDERS: Array<{ provider: ProviderSuperpowersProvider; label: string; command: string }> = [
  { provider: 'claude', label: 'Claude Code', command: 'claude' },
  { provider: 'codex', label: 'Codex CLI', command: 'codex' },
  { provider: 'opencode', label: 'OpenCode', command: 'opencode' },
];

const defaultRunner: ProviderSuperpowersCommandRunner = {
  async run(command, args) {
    const result = await execFile(command, args, {
      encoding: 'utf-8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

let status: ProviderSuperpowersStatus = {
  started_at: null,
  completed_at: null,
  running: false,
  providers: PROVIDERS.map((provider) => ({
    provider: provider.provider,
    label: provider.label,
    cli_installed: false,
    version: null,
    superpowers_installed: false,
    install_attempted: false,
    install_status: 'not_started',
    message: null,
    checked_at: 0,
  })),
};

let activeRun: Promise<ProviderSuperpowersStatus> | null = null;

export function getProviderSuperpowersStatus(): ProviderSuperpowersStatus {
  return cloneStatus(status);
}

export function resetProviderSuperpowersStatusForTest(): void {
  activeRun = null;
  status = {
    started_at: null,
    completed_at: null,
    running: false,
    providers: PROVIDERS.map((provider) => ({
      provider: provider.provider,
      label: provider.label,
      cli_installed: false,
      version: null,
      superpowers_installed: false,
      install_attempted: false,
      install_status: 'not_started',
      message: null,
      checked_at: 0,
    })),
  };
}

export function startProviderSuperpowersStartupInstall(
  runner: ProviderSuperpowersCommandRunner = defaultRunner,
): Promise<ProviderSuperpowersStatus> {
  if (activeRun) return activeRun;
  const startedAt = Date.now();
  status = {
    started_at: startedAt,
    completed_at: null,
    running: true,
    providers: status.providers.map((provider) => ({
      ...provider,
      install_status: provider.install_status === 'not_started' ? 'installing' : provider.install_status,
    })),
  };

  activeRun = runStartupInstall(runner)
    .then((providers) => {
      status = {
        started_at: startedAt,
        completed_at: Date.now(),
        running: false,
        providers,
      };
      return cloneStatus(status);
    })
    .finally(() => {
      activeRun = null;
    });

  return activeRun;
}

async function runStartupInstall(runner: ProviderSuperpowersCommandRunner): Promise<ProviderSuperpowersCheck[]> {
  const results: ProviderSuperpowersCheck[] = [];
  for (const provider of PROVIDERS) {
    results.push(await checkAndInstallProvider(provider, runner));
  }
  return results;
}

async function checkAndInstallProvider(
  provider: { provider: ProviderSuperpowersProvider; label: string; command: string },
  runner: ProviderSuperpowersCommandRunner,
): Promise<ProviderSuperpowersCheck> {
  const checkedAt = Date.now();
  const version = await readVersion(provider.command, runner);
  if (!version) {
    return {
      provider: provider.provider,
      label: provider.label,
      cli_installed: false,
      version: null,
      superpowers_installed: false,
      install_attempted: false,
      install_status: 'cli_missing',
      message: `${provider.label} CLI 未安装，已跳过 Superpowers 自动安装。`,
      checked_at: checkedAt,
    };
  }

  const installed = await isSuperpowersInstalled(provider.provider, runner);
  if (installed) {
    return {
      provider: provider.provider,
      label: provider.label,
      cli_installed: true,
      version,
      superpowers_installed: true,
      install_attempted: false,
      install_status: 'installed',
      message: 'Superpowers 已安装。',
      checked_at: checkedAt,
    };
  }

  const installResult = await installSuperpowers(provider.provider, runner);
  const installedAfterAttempt = installResult.ok
    ? await isSuperpowersInstalled(provider.provider, runner)
    : false;

  return {
    provider: provider.provider,
    label: provider.label,
    cli_installed: true,
    version,
    superpowers_installed: installedAfterAttempt,
    install_attempted: true,
    install_status: installedAfterAttempt ? 'installed_by_startup' : installResult.status,
    message: installedAfterAttempt ? '启动时已自动安装 Superpowers。' : installResult.message,
    checked_at: checkedAt,
  };
}

async function readVersion(command: string, runner: ProviderSuperpowersCommandRunner): Promise<string | null> {
  const result = await runOptional(runner, command, ['--version']);
  if (!result.ok) return null;
  return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0]?.trim() || 'installed';
}

async function isSuperpowersInstalled(
  provider: ProviderSuperpowersProvider,
  runner: ProviderSuperpowersCommandRunner,
): Promise<boolean> {
  if (provider === 'claude') return isClaudeSuperpowersInstalled();
  if (provider === 'codex') return isCodexSuperpowersInstalled(runner);
  return isOpenCodeSuperpowersInstalled();
}

function isClaudeSuperpowersInstalled(): boolean {
  const home = homedir();
  const installedPlugins = readJsonFile(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = isRecord(installedPlugins?.plugins) ? installedPlugins.plugins : {};
  if (Object.keys(plugins).some((key) => /^superpowers@/.test(key))) return true;

  return [
    join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers'),
    join(home, '.claude', 'plugins', 'cache', 'superpowers-marketplace', 'superpowers'),
    join(home, '.claude', 'plugins', 'data', 'superpowers-claude-plugins-official'),
  ].some((path) => existsSync(path));
}

async function isCodexSuperpowersInstalled(runner: ProviderSuperpowersCommandRunner): Promise<boolean> {
  const result = await runOptional(runner, 'codex', ['plugin', 'list']);
  if (!result.ok) return false;
  return /^superpowers@\S+\s+installed\b/im.test(result.stdout);
}

function isOpenCodeSuperpowersInstalled(): boolean {
  const home = homedir();
  const candidates = [
    join(home, '.config', 'opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
  ];
  for (const candidate of candidates) {
    const parsed = readJsonFile(candidate);
    const plugins = Array.isArray(parsed?.plugin) ? parsed.plugin : [];
    if (plugins.some((item) => typeof item === 'string' && item.includes('superpowers'))) return true;
  }

  return [
    join(home, '.config', 'opencode', 'plugins', 'superpowers.js'),
    join(home, '.config', 'opencode', 'skills', 'superpowers'),
    join(home, '.config', 'opencode', 'node_modules', 'superpowers'),
  ].some((path) => existsSync(path));
}

async function installSuperpowers(
  provider: ProviderSuperpowersProvider,
  runner: ProviderSuperpowersCommandRunner,
): Promise<{ ok: boolean; status: 'failed' | 'unsupported'; message: string }> {
  if (provider === 'claude') {
    const result = await runOptional(runner, 'claude', [
      '-p',
      '/plugin install superpowers@claude-plugins-official',
      '--output-format',
      'json',
      '--max-budget-usd',
      '0.01',
    ]);
    return result.ok
      ? { ok: true, status: 'failed', message: '已请求 Claude Code 安装 Superpowers。' }
      : {
          ok: false,
          status: 'failed',
          message: `Claude Code Superpowers 自动安装失败：${result.message}`,
        };
  }

  if (provider === 'codex') {
    const result = await runOptional(runner, 'codex', ['plugin', 'add', 'superpowers@openai-curated']);
    return result.ok
      ? { ok: true, status: 'failed', message: '已请求 Codex 安装 Superpowers。' }
      : { ok: false, status: 'failed', message: `Codex Superpowers 自动安装失败：${result.message}` };
  }

  const result = await runOptional(runner, 'opencode', ['plugin', '-g', OPENCODE_SUPERPOWERS_SPEC]);
  return result.ok
    ? { ok: true, status: 'failed', message: '已请求 OpenCode 安装 Superpowers。' }
    : { ok: false, status: 'failed', message: `OpenCode Superpowers 自动安装失败：${result.message}` };
}

async function runOptional(
  runner: ProviderSuperpowersCommandRunner,
  command: string,
  args: string[],
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; message: string }> {
  try {
    const result = await runner.run(command, args);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(stripJsonComments(content)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stripJsonComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneStatus(value: ProviderSuperpowersStatus): ProviderSuperpowersStatus {
  return {
    ...value,
    providers: value.providers.map((provider) => ({ ...provider })),
  };
}
