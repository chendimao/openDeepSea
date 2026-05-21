import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuperpowersVerificationEvidence, VerificationResult } from './state.js';

const SHELL_META_PATTERN = /[;&|`$<>]/;
const DESTRUCTIVE_PATTERN = /\b(rm|mv|chmod|chown|dd|mkfs|shutdown|reboot)\b|\brm\s+-rf\b/i;

const ALLOWED_COMMANDS = new Set([
  'npm run test -w @openclaw-room/backend',
  'npm run build -w @openclaw-room/backend',
  'npm run build -w @openclaw-room/frontend',
  'npm run build',
]);

const EXECUTABLE_COMMAND_PATTERN = /^(?:\.{0,2}\/|npm\b|npx\b|pnpm\b|yarn\b|bun\b|node\b|tsx\b|vitest\b|jest\b|playwright\b|git\b|make\b|cargo\b|go\b|python\b|python3\b|pytest\b)/i;

type VerificationCommandRunnerForTests = (command: string, cwd: string) => Promise<VerificationResult>;
let verificationCommandRunnerForTests: VerificationCommandRunnerForTests | null = null;

export function setVerificationCommandRunnerForTests(runner: VerificationCommandRunnerForTests | null): void {
  verificationCommandRunnerForTests = runner;
}

export function isAllowedVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_META_PATTERN.test(trimmed)) return false;
  if (DESTRUCTIVE_PATTERN.test(trimmed)) return false;
  return ALLOWED_COMMANDS.has(trimmed);
}

export function isManualVerificationItem(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_META_PATTERN.test(trimmed)) return false;
  if (DESTRUCTIVE_PATTERN.test(trimmed)) return false;
  return !EXECUTABLE_COMMAND_PATTERN.test(trimmed);
}

export function getVerificationCwd(start = process.cwd()): string {
  let current = start;
  for (;;) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'packages', 'backend', 'package.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export async function runVerificationCommand(command: string, cwd: string): Promise<VerificationResult> {
  const trimmed = command.trim();
  if (verificationCommandRunnerForTests) {
    return verificationCommandRunnerForTests(trimmed, cwd);
  }
  const naturalLanguageResult = await runNaturalLanguageVerification(trimmed, cwd);
  if (naturalLanguageResult) return naturalLanguageResult;
  if (!isAllowedVerificationCommand(trimmed)) {
    if (isManualVerificationItem(trimmed)) {
      return {
        command: trimmed,
        status: 'skipped',
        exitCode: null,
        stdout: '',
        stderr: 'Manual verification item; not an executable command',
      };
    }
    return {
      command: trimmed,
      status: 'skipped',
      exitCode: null,
      stdout: '',
      stderr: 'Command is not allowlisted',
    };
  }

  const [bin, ...args] = trimmed.split(/\s+/);
  if (!bin) {
    return {
      command: trimmed,
      status: 'failed',
      exitCode: null,
      stdout: '',
      stderr: 'Invalid command',
    };
  }

  return await new Promise<VerificationResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error: Error) => {
      stderr += error.message;
    });
    child.on('close', (code: number | null) => {
      resolve({
        command: trimmed,
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

async function runNaturalLanguageVerification(command: string, cwd: string): Promise<VerificationResult | null> {
  const normalized = command.trim().replace(/[。.]$/, '');
  const targetPath = extractWorkspaceMarkdownPath(normalized, cwd);
  if (/^检查目标文件存在[:：]/.test(normalized) && targetPath) {
    const absolutePath = resolveWorkspacePath(cwd, targetPath);
    return {
      command,
      status: absolutePath && existsSync(absolutePath) ? 'passed' : 'failed',
      exitCode: absolutePath && existsSync(absolutePath) ? 0 : 1,
      stdout: absolutePath && existsSync(absolutePath) ? `${targetPath} exists` : '',
      stderr: absolutePath ? '' : 'Invalid workspace path',
    };
  }

  if (/^检查\s*Markdown\s*内容包含[:：]/i.test(normalized)) {
    const contentDescription = targetPath ? normalized.replace(targetPath, '') : normalized;
    const terms = contentDescription
      .replace(/^检查\s*Markdown\s*内容包含[:：]/i, '')
      .replace(/文件[:：]?/g, '')
      .replace(/[。.]$/g, '')
      .split(/[、,，]/)
      .map((item) => item.trim().replace(/[。.:：]+$/g, '').trim())
      .filter(Boolean);
    const markdownPath = targetPath ?? findRecentMarkdownPath(cwd);
    const absolutePath = markdownPath ? resolveWorkspacePath(cwd, markdownPath) : null;
    if (!absolutePath || !existsSync(absolutePath)) {
      return {
        command,
        status: 'failed',
        exitCode: 1,
        stdout: '',
        stderr: markdownPath ? `Markdown file not found: ${markdownPath}` : 'No markdown file found for content check',
      };
    }
    const content = readFileSync(absolutePath, 'utf-8');
    const missing = terms.filter((term) => !content.includes(term));
    return {
      command,
      status: missing.length === 0 ? 'passed' : 'failed',
      exitCode: missing.length === 0 ? 0 : 1,
      stdout: missing.length === 0 ? `${markdownPath} contains ${terms.join(', ')}` : '',
      stderr: missing.length > 0 ? `Missing terms: ${missing.join(', ')}` : '',
    };
  }

  if (/^执行\s+git\s+diff\s+或\s+git\s+status/.test(normalized)) {
    const markdownPath = targetPath ?? findRecentMarkdownPath(cwd);
    return runGitWorkspaceCleanVerification(command, cwd, markdownPath);
  }
  if (/^执行提交前暂存检查/.test(normalized) || /staged diff|暂存区/.test(normalized)) {
    const markdownPath = targetPath ?? findRecentMarkdownPath(cwd);
    return runGitStagedVerification(command, cwd, markdownPath);
  }
  if (/^执行\s+git\s+log\s+-1\s+--stat/.test(normalized)) {
    return runGitVerification(command, cwd, ['log', '-1', '--stat']);
  }

  return null;
}

async function runGitVerification(command: string, cwd: string, args: string[]): Promise<VerificationResult> {
  const result = await runSpawnedCommand('git', args, cwd);
  return {
    command,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runGitWorkspaceCleanVerification(
  command: string,
  cwd: string,
  targetPath: string | null,
): Promise<VerificationResult> {
  if (!targetPath) {
    return {
      command,
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: 'No target file found for workspace status check',
    };
  }
  const result = await runSpawnedCommand('git', ['status', '--short', '--untracked-files=all', '--', targetPath], cwd);
  if (result.exitCode !== 0) {
    return {
      command,
      status: 'failed',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const changedPaths = parseGitShortStatusPaths(result.stdout);
  const targetDirty = targetPath ? changedPaths.includes(targetPath) : false;
  return {
    command,
    status: !targetDirty ? 'passed' : 'failed',
    exitCode: !targetDirty ? 0 : 1,
    stdout: result.stdout,
    stderr: targetDirty ? `Target file still has uncommitted changes: ${targetPath}` : result.stderr,
  };
}

async function runGitStagedVerification(
  command: string,
  cwd: string,
  targetPath: string | null,
): Promise<VerificationResult> {
  const result = await runSpawnedCommand('git', ['diff', '--cached', '--name-only'], cwd);
  if (result.exitCode !== 0) {
    return {
      command,
      status: 'failed',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const stagedPaths = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const unexpected = targetPath
    ? stagedPaths.filter((path) => path !== targetPath)
    : stagedPaths;
  return {
    command,
    status: unexpected.length === 0 ? 'passed' : 'failed',
    exitCode: unexpected.length === 0 ? 0 : 1,
    stdout: result.stdout,
    stderr: unexpected.length > 0 ? `Unexpected staged files: ${unexpected.join(', ')}` : result.stderr,
  };
}

function parseGitShortStatusPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3);
      const renamePath = rawPath.split(' -> ').pop() ?? rawPath;
      return renamePath.trim();
    })
    .filter(Boolean);
}

function runSpawnedCommand(bin: string, args: string[], cwd: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult) => {
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error: Error) => {
      stderr += error.message;
    });
    child.on('close', (code: number | null) => {
      resolveResult({ exitCode: code, stdout, stderr });
    });
  });
}

function extractWorkspaceMarkdownPath(text: string, cwd: string): string | null {
  const match = text.match(/(?:^|[\s：:])((?:\.\/)?[a-z0-9_./@+-]+\.md)\b/i);
  if (!match?.[1]) return null;
  const normalized = match[1].replace(/^\.\//, '');
  return resolveWorkspacePath(cwd, normalized) ? normalized : null;
}

function findRecentMarkdownPath(cwd: string): string | null {
  const headFiles = readGitOutput(cwd, ['show', '--name-only', '--format=', 'HEAD'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'));
  const verificationDoc = headFiles.find((line) => line.startsWith('docs/superpowers/verification/'));
  if (verificationDoc && resolveWorkspacePath(cwd, verificationDoc)) return verificationDoc;
  const firstMarkdown = headFiles.find((line) => resolveWorkspacePath(cwd, line));
  return firstMarkdown ?? null;
}

function readGitOutput(cwd: string, args: string[]): string {
  try {
    const result = spawnSyncGit(cwd, args);
    return result.status === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}

function spawnSyncGit(cwd: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
  };
}

function resolveWorkspacePath(cwd: string, path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed.split(/[\\/]+/).includes('..')) return null;
  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  return absolutePath === cwd || absolutePath.startsWith(`${cwd}/`) ? absolutePath : null;
}

export function mapVerificationResultsToEvidence(
  results: VerificationResult[],
  commands: Array<{ command: string; required?: boolean }>,
  existingEvidence: SuperpowersVerificationEvidence[] = [],
): SuperpowersVerificationEvidence[] {
  if (commands.length === 0) {
    return existingEvidence;
  }

  const recordedAt = new Date().toISOString();
  return results.map((result, index) => ({
    command: result.command,
    status: result.status,
    required: commands[index]?.required !== false,
    fresh: true,
    recordedAt,
  }));
}
