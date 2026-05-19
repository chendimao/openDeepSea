import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { nanoid } from 'nanoid';
import { projectRepo } from '../repos/projects.js';
import { skillRepo } from './repo.js';
import { skillRunRepo } from './run-repo.js';
import type { SkillRun, SkillRunInvoker } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 64_000;

export interface RunSkillInput {
  skillId: string;
  projectId: string;
  roomId?: string | null;
  agentId?: string | null;
  invokedBy: SkillRunInvoker;
  input?: unknown;
  timeoutMs?: number;
}

export function validateProjectSandboxPath(projectRoot: string, targetPath: string): string {
  const root = resolve(projectRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))) return target;
  throw new Error('path is outside the project sandbox');
}

export async function runSkillInProjectSandbox(input: RunSkillInput): Promise<SkillRun> {
  const skill = skillRepo.getSkill(input.skillId);
  if (!skill) throw new Error('skill not found');
  if (!skill.runtime_type || !skill.entrypoint) {
    throw new Error('skill does not declare an executable runtime');
  }
  if (!skill.permissions || skill.permissions.filesystem !== 'project') {
    throw new Error('skill must declare project filesystem permission');
  }
  const project = projectRepo.get(input.projectId);
  if (!project) throw new Error('project not found');
  const projectPath = validateProjectSandboxPath(project.path, project.path);
  const entrypoint = validateProjectSandboxPath(skill.install_path, resolve(skill.install_path, skill.entrypoint));
  await access(entrypoint);

  const run = skillRunRepo.createRun({
    id: nanoid(),
    skill_id: skill.id,
    project_id: project.id,
    room_id: input.roomId ?? null,
    agent_id: input.agentId ?? null,
    invoked_by: input.invokedBy,
    runtime: skill.runtime_type,
    entrypoint: skill.entrypoint,
    input: input.input ?? null,
    allowed_paths: [projectPath],
    network_enabled: skill.permissions.network,
    status: 'running',
  });

  const command = runtimeCommand(skill.runtime_type);
  const args = runtimeArgs(skill.runtime_type, entrypoint);
  const inputText = JSON.stringify(input.input ?? null);

  try {
    const result = await runProcess(command, args, {
      cwd: projectPath,
      input: inputText,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const status = result.exitCode === 0 ? 'completed' : 'failed';
    return skillRunRepo.updateRun(run.id, {
      status,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      result: parseJsonResult(result.stdout),
      error: status === 'failed' ? `skill exited with exit code ${result.exitCode}` : null,
    })!;
  } catch (err) {
    return skillRunRepo.updateRun(run.id, {
      status: 'failed',
      exit_code: null,
      stdout: null,
      stderr: null,
      result: null,
      error: (err as Error).message,
    })!;
  }
}

function runtimeCommand(runtime: 'node' | 'python' | 'shell'): string {
  if (runtime === 'node') return process.execPath;
  if (runtime === 'python') return 'python3';
  return 'bash';
}

function runtimeArgs(runtime: 'node' | 'python' | 'shell', entrypoint: string): string[] {
  if (runtime === 'shell') return [entrypoint];
  return [entrypoint];
}

function runProcess(command: string, args: string[], options: {
  cwd: string;
  input: string;
  timeoutMs: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: minimalEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('skill execution timed out'));
    }, options.timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout = truncateOutput(stdout + String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncateOutput(stderr + String(chunk));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function truncateOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(-MAX_OUTPUT_CHARS) : value;
}

function parseJsonResult(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
