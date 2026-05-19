import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
    allowed_paths: [project.path],
    network_enabled: skill.permissions.network,
    status: 'running',
  });

  let sandbox: { command: string; args: string[]; cleanup: () => Promise<void> } | null = null;
  try {
    const projectPath = await realpath(validateProjectSandboxPath(project.path, project.path));
    const installPath = await realpath(skill.install_path);
    const entrypointCandidate = validateProjectSandboxPath(installPath, resolve(installPath, skill.entrypoint));
    const entrypoint = validateProjectSandboxPath(installPath, await realpath(entrypointCandidate));
    await access(entrypoint);

    skillRunRepo.updateRun(run.id, { allowed_paths: [projectPath] });

    const command = runtimeCommand(skill.runtime_type);
    const args = runtimeArgs(skill.runtime_type, entrypoint, {
      projectPath,
      installPath,
      networkEnabled: skill.permissions.network,
    });
    const inputText = JSON.stringify(input.input ?? null);
    sandbox = await createProjectSandbox({
      runtime: skill.runtime_type,
      command,
      args,
      projectPath,
      installPath,
      networkEnabled: skill.permissions.network,
    });

    const result = await runProcess(sandbox.command, sandbox.args, {
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
  } finally {
    await sandbox?.cleanup();
  }
}

function runtimeCommand(runtime: 'node' | 'python' | 'shell'): string {
  if (runtime === 'node') return process.execPath;
  if (runtime === 'python') return '/usr/bin/python3';
  return '/bin/bash';
}

function runtimeArgs(runtime: 'node' | 'python' | 'shell', entrypoint: string, options: {
  projectPath: string;
  installPath: string;
  networkEnabled: boolean;
}): string[] {
  if (runtime === 'node') {
    const args = [
      '--permission',
      `--allow-fs-read=${options.projectPath}`,
      `--allow-fs-read=${options.installPath}`,
      `--allow-fs-write=${options.projectPath}`,
    ];
    if (options.networkEnabled) args.push('--allow-net');
    return [...args, entrypoint];
  }
  if (runtime === 'python') {
    return [
      '-c',
      pythonSandboxBootstrap(options.projectPath, options.installPath),
      entrypoint,
    ];
  }
  if (runtime === 'shell') return [entrypoint];
  return [entrypoint];
}

async function createProjectSandbox(options: {
  runtime: 'node' | 'python' | 'shell';
  command: string;
  args: string[];
  projectPath: string;
  installPath: string;
  networkEnabled: boolean;
}): Promise<{ command: string; args: string[]; cleanup: () => Promise<void> }> {
  if (process.platform !== 'darwin') {
    throw new Error('project sandbox execution requires macOS sandbox-exec');
  }

  await access('/usr/bin/sandbox-exec');
  const dir = await mkdtemp(join(tmpdir(), 'opendeepsea-skill-sandbox-'));
  const profilePath = join(dir, 'profile.sb');
  await writeFile(profilePath, buildMacSandboxProfile(options), 'utf-8');

  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, options.command, ...options.args],
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function buildMacSandboxProfile(options: {
  runtime: 'node' | 'python' | 'shell';
  command: string;
  projectPath: string;
  installPath: string;
  networkEnabled: boolean;
}): string {
  const networkRule = options.networkEnabled ? '(allow network*)' : '(deny network*)';
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow sysctl-read)',
    networkRule,
    '(allow file-read-metadata)',
    '(allow file-map-executable)',
    `(allow file-read* (subpath ${sandboxString(options.projectPath)}))`,
    `(allow file-read* (subpath ${sandboxString(options.installPath)}))`,
    `(allow file-write* (subpath ${sandboxString(options.projectPath)}))`,
    `(allow file-write* (literal ${sandboxString(options.projectPath)}))`,
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write* (subpath "/dev"))',
    ...runtimeReadRules(options.runtime, options.command),
  ].join('\n');
}

function sandboxString(value: string): string {
  return JSON.stringify(value);
}

function runtimeReadRules(runtime: 'node' | 'python' | 'shell', command: string): string[] {
  if (runtime === 'node') {
    return [
      `(allow file-read* (literal ${sandboxString(command)}))`,
      `(allow file-read* (subpath ${sandboxString(dirname(dirname(command)))}))`,
      '(allow file-read* (subpath "/usr/local/Cellar"))',
      '(allow file-read* (subpath "/usr/local/opt"))',
      '(allow file-read* (subpath "/usr/local/etc/openssl@3"))',
    ];
  }
  if (runtime === 'python') {
    return [
      '(allow file-read* (literal "/usr/bin/python3"))',
      '(allow file-read* (subpath "/Library/Developer/CommandLineTools"))',
      '(allow file-map-executable (subpath "/System"))',
      '(allow file-map-executable (subpath "/usr"))',
    ];
  }
  return [];
}

function pythonSandboxBootstrap(projectPath: string, installPath: string): string {
  const projectJson = JSON.stringify(projectPath);
  const installJson = JSON.stringify(installPath);
  return `
import os
import runpy
import sys

allowed_roots = [os.path.realpath(${projectJson}), os.path.realpath(${installJson})]
runtime_roots = [
    os.path.realpath("/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework"),
    os.path.realpath("/Library/Developer/CommandLineTools/usr/lib"),
]
blocked_events = {
    "ctypes.dlopen",
    "os.fork",
    "os.forkpty",
    "os.posix_spawn",
    "os.posix_spawnp",
    "os.system",
    "subprocess.Popen",
}

def is_allowed_path(value):
    if not isinstance(value, (str, bytes, os.PathLike)):
        return True
    try:
        candidate = os.path.realpath(os.fspath(value))
    except Exception:
        return True
    return any(candidate == root or candidate.startswith(root + os.sep) for root in allowed_roots)

def is_runtime_import_path(value):
    if not isinstance(value, (str, bytes, os.PathLike)):
        return False
    try:
        candidate = os.path.realpath(os.fspath(value))
    except Exception:
        return False
    return any(candidate == root or candidate.startswith(root + os.sep) for root in runtime_roots)

def is_import_loader_access():
    frame = sys._getframe()
    while frame is not None:
        filename = frame.f_code.co_filename
        if filename.startswith("<frozen importlib") or "/importlib/" in filename:
            return True
        frame = frame.f_back
    return False

def audit_hook(event, args):
    if event in blocked_events:
        raise PermissionError(f"skill sandbox denied event: {event}")
    if event == "open" and args and not is_allowed_path(args[0]) and not (is_runtime_import_path(args[0]) and is_import_loader_access()):
        raise PermissionError(f"skill sandbox denied path: {args[0]}")
    if event.startswith("os.") and args and isinstance(args[0], (str, bytes, os.PathLike)) and not is_allowed_path(args[0]) and not (is_runtime_import_path(args[0]) and is_import_loader_access()):
        raise PermissionError(f"skill sandbox denied path: {args[0]}")

sys.addaudithook(audit_hook)
entrypoint = sys.argv[1]
sys.argv = [entrypoint] + sys.argv[2:]
runpy.run_path(entrypoint, run_name="__main__")
`;
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
