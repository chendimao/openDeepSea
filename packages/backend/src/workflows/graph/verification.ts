import { spawn } from 'node:child_process';
import type { VerificationResult } from './state.js';

const SHELL_META_PATTERN = /[;&|`$<>]/;
const DESTRUCTIVE_PATTERN = /\b(rm|mv|chmod|chown|dd|mkfs|shutdown|reboot)\b|\brm\s+-rf\b/i;

const ALLOWED_COMMANDS = new Set([
  'npm run test -w @openclaw-room/backend',
  'npm run build -w @openclaw-room/backend',
  'npm run build -w @openclaw-room/frontend',
  'npm run build',
]);

export function isAllowedVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_META_PATTERN.test(trimmed)) return false;
  if (DESTRUCTIVE_PATTERN.test(trimmed)) return false;
  return ALLOWED_COMMANDS.has(trimmed);
}

export async function runVerificationCommand(command: string, cwd: string): Promise<VerificationResult> {
  const trimmed = command.trim();
  if (!isAllowedVerificationCommand(trimmed)) {
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
