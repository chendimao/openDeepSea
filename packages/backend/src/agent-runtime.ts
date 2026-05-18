import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  AgentDefaultRuntime,
  AgentMemoryScope,
  AgentRuntimeBackend,
  AgentToolCapability,
  AgentToolPolicy,
  AgentWorkspacePolicy,
  ResolvedAgentRuntimeProfile,
  RoomAgent,
} from './types.js';

export const DEFAULT_AGENT_TOOL_POLICY: AgentToolPolicy = { allowed: [] };
export const DEFAULT_AGENT_WORKSPACE_POLICY: AgentWorkspacePolicy = { read: [], write: [] };
export const DEFAULT_AGENT_MEMORY_SCOPE: AgentMemoryScope = 'agent';

const TOOL_CAPABILITIES = new Set<AgentToolCapability>([
  'read_files',
  'write_files',
  'run_shell',
  'browser',
  'search',
  'image_input',
  'commit',
]);

export function normalizeAgentToolPolicy(value: Partial<AgentToolPolicy> | null | undefined): AgentToolPolicy {
  return {
    allowed: normalizeStringArray(value?.allowed).filter((item): item is AgentToolCapability =>
      TOOL_CAPABILITIES.has(item as AgentToolCapability),
    ),
  };
}

export function normalizeAgentWorkspacePolicy(
  value: Partial<AgentWorkspacePolicy> | null | undefined,
): AgentWorkspacePolicy {
  return {
    read: normalizeStringArray(value?.read),
    write: normalizeStringArray(value?.write),
  };
}

export function resolveAgentRuntimeProfile(input: {
  agent: RoomAgent;
  projectPath: string;
  imagePaths?: string[];
}): ResolvedAgentRuntimeProfile {
  const projectPath = resolve(input.projectPath);
  const warnings: string[] = [];
  const workspacePolicy = normalizeAgentWorkspacePolicy(input.agent.workspace_policy ?? DEFAULT_AGENT_WORKSPACE_POLICY);
  const readableDirs = uniquePaths([
    ...resolveWorkspacePaths(workspacePolicy.read.length > 0 ? workspacePolicy.read : ['.'], projectPath, 'read', warnings),
    ...resolveImageReadableDirs(input.imagePaths ?? [], projectPath, warnings),
  ]);
  const writableDirs = uniquePaths(resolveWorkspacePaths(workspacePolicy.write, projectPath, 'write', warnings));
  const runtimeBackend = resolveRuntimeBackend(input.agent.runtime_backend, input.agent.default_runtime);
  const acpBackend = input.agent.acp_enabled && input.agent.acp_backend ? input.agent.acp_backend : null;
  const effectiveRuntimeBackend = runtimeBackend === 'acp' && !acpBackend ? 'none' : runtimeBackend;

  return {
    runtimeBackend: effectiveRuntimeBackend,
    acpBackend,
    acpPermissionMode: effectiveRuntimeBackend === 'acp' && acpBackend && writableDirs.length > 0
      ? input.agent.acp_permission_mode
      : 'read-only',
    readableDirs,
    writableDirs,
    toolPolicy: normalizeAgentToolPolicy(input.agent.tool_policy ?? DEFAULT_AGENT_TOOL_POLICY),
    memoryScope: input.agent.memory_scope ?? DEFAULT_AGENT_MEMORY_SCOPE,
    contextBudget: input.agent.memory_max_context_chars,
    warnings,
  };
}

export function buildAgentRuntimeContextPrompt(profile: ResolvedAgentRuntimeProfile): string {
  return [
    '智能体运行边界：',
    `- 运行后端：${profile.runtimeBackend}`,
    `- ACP 后端：${profile.acpBackend ?? '无'}`,
    `- 权限模式：${profile.acpPermissionMode}`,
    `- 可读目录：${formatList(profile.readableDirs)}`,
    `- 可写目录：${formatList(profile.writableDirs)}`,
    `- 工具能力：${formatList(profile.toolPolicy.allowed)}`,
    `- 记忆范围：${profile.memoryScope}`,
    `- 上下文预算：${profile.contextBudget ?? '默认'}`,
    profile.warnings.length > 0 ? `- 边界警告：${profile.warnings.join('；')}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function resolveRuntimeBackend(
  runtimeBackend: AgentRuntimeBackend | null,
  defaultRuntime: AgentDefaultRuntime,
): AgentRuntimeBackend {
  if (runtimeBackend) return runtimeBackend;
  if (defaultRuntime === 'acp') return 'acp';
  return 'none';
}

function resolveWorkspacePaths(
  paths: string[],
  projectPath: string,
  label: 'read' | 'write',
  warnings: string[],
): string[] {
  return paths.flatMap((item) => {
    const resolved = resolveProjectPath(projectPath, item);
    if (!resolved) {
      warnings.push(`忽略越界${label === 'read' ? '读取' : '写入'}路径：${item}`);
      return [];
    }
    return [resolved];
  });
}

function resolveImageReadableDirs(imagePaths: string[], projectPath: string, warnings: string[]): string[] {
  return imagePaths.flatMap((imagePath) => {
    const resolved = resolveProjectPath(projectPath, dirname(imagePath));
    if (!resolved) {
      warnings.push(`忽略越界图片路径：${imagePath}`);
      return [];
    }
    return [resolved];
  });
}

function resolveProjectPath(projectPath: string, path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (trimmed.split(/[\\/]+/).includes('..')) return null;
  const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectPath, trimmed);
  if (resolved === projectPath || resolved.startsWith(`${projectPath}/`)) return resolved;
  return null;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '无';
}
