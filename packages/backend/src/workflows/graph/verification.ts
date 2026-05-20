import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
