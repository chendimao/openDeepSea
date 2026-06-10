import { inferTaskProfile, type TaskProfile, type TaskProfileInput } from './task-profile.js';

export type TaskKind =
  | 'chat_answer'
  | 'brainstorming'
  | 'code_review'
  | 'bug_fix'
  | 'frontend_change'
  | 'backend_change'
  | 'fullstack_change'
  | 'test_only'
  | 'docs_only'
  | 'ops_or_config'
  | 'unknown';

export type TaskRiskLevel = 'low' | 'medium' | 'high';

export type WorkflowExecutionMode = 'serial' | 'parallel' | 'hybrid';

export interface TaskRiskAssessmentInput extends TaskProfileInput {
  agents?: string[];
  executionMode?: WorkflowExecutionMode;
  verification?: string[];
}

export interface TaskRiskAssessment {
  taskKind: TaskKind;
  riskLevel: TaskRiskLevel;
  requiresApproval: boolean;
  approvalReason?: string;
  reasons: string[];
  profile: TaskProfile;
}

export interface ApprovalCard extends TaskRiskAssessment {
  agents: string[];
  executionMode: WorkflowExecutionMode;
  verification: string[];
}

export function assessTaskRisk(input: TaskRiskAssessmentInput): TaskRiskAssessment {
  const profile = inferTaskProfile(input);
  const writePaths = input.scopeWrite ?? [];
  const allPaths = [...(input.scopeRead ?? []), ...writePaths];
  const text = normalizeText([
    input.title,
    input.description,
    ...allPaths,
    ...(input.acceptance ?? []),
  ]);
  const writeIntentText = normalizeText([
    input.title,
    input.description,
    ...writePaths,
    ...(input.acceptance ?? []),
  ]);
  const reasons = [...profile.reasons];
  let taskKind = inferTaskKind(profile, writePaths, text);
  let riskLevel: TaskRiskLevel = 'low';
  let requiresApproval = false;
  let approvalReason: string | undefined;

  const highRiskReason = getHighRiskReason(writePaths, writeIntentText);
  if (highRiskReason) {
    riskLevel = 'high';
    requiresApproval = true;
    approvalReason = highRiskReason;
    reasons.push(highRiskReason);
    if (isOpsOrConfigChange(writePaths, writeIntentText)) taskKind = 'ops_or_config';
  } else if (isSmallDocumentationOnlyTask(profile, writePaths)) {
    taskKind = 'docs_only';
    reasons.push('small documentation-only scope');
  } else {
    const mediumRiskReason = getMediumRiskReason(profile, allPaths, text);
    if (mediumRiskReason) {
      riskLevel = 'medium';
      requiresApproval = true;
      approvalReason = mediumRiskReason;
      reasons.push(mediumRiskReason);
    }
  }

  if (profile.confidence < 0.45) {
    requiresApproval = true;
    if (riskLevel === 'low') riskLevel = 'medium';
    approvalReason ??= 'low-confidence task profile requires approval';
    reasons.push('low-confidence task profile');
  }

  return {
    taskKind,
    riskLevel,
    requiresApproval,
    approvalReason,
    reasons,
    profile,
  };
}

export function buildApprovalCard(input: TaskRiskAssessmentInput): ApprovalCard {
  const assessment = assessTaskRisk(input);

  return {
    ...assessment,
    agents: input.agents ?? [],
    executionMode: input.executionMode ?? 'serial',
    verification: input.verification ?? [],
  };
}

function inferTaskKind(profile: TaskProfile, writePaths: string[], text: string): TaskKind {
  if (isChatAnswer(writePaths, text)) return 'chat_answer';
  if (containsAny(text, BRAINSTORMING_SIGNALS)) return 'brainstorming';
  if (containsAny(text, CODE_REVIEW_SIGNALS)) return 'code_review';
  if (isTestOnlyChange(writePaths)) return 'test_only';
  if (profile.taskType === 'bugfix') return 'bug_fix';
  if (profile.taskType === 'documentation' || profile.taskType === 'presentation') return 'docs_only';
  if (profile.domains.includes('frontend') && profile.domains.includes('backend')) return 'fullstack_change';
  if (profile.domains.includes('frontend') || profile.domains.includes('ui')) return 'frontend_change';
  if (profile.domains.includes('backend')) return 'backend_change';
  return 'unknown';
}

function getHighRiskReason(writePaths: string[], text: string): string | undefined {
  if (writePaths.some(isDependencyPath) || containsAny(text, DEPENDENCY_SIGNALS)) {
    return 'dependency/root config changes require approval';
  }
  if (writePaths.some(isRootConfigPath) || containsAny(text, ROOT_CONFIG_SIGNALS)) {
    return 'root config changes require approval';
  }
  if (writePaths.some(isDatabasePath) || containsAny(text, DATABASE_SIGNALS)) {
    return 'database migration or schema changes require approval';
  }
  if (containsAny(text, SECURITY_SIGNALS)) {
    return 'security/permissions/deletion/credential/sandbox changes require approval';
  }
  return undefined;
}

function getMediumRiskReason(profile: TaskProfile, paths: string[], text: string): string | undefined {
  if (profile.domains.includes('frontend') && profile.domains.includes('backend')) {
    return 'front/back workflow changes require approval';
  }
  if (isMultiFileSharedWorkflowChange(paths, text)) {
    return 'workflow/shared contract or schema changes require approval';
  }
  return undefined;
}

function isSmallDocumentationOnlyTask(profile: TaskProfile, writePaths: string[]): boolean {
  if (writePaths.length > 2) return false;
  if (profile.taskType === 'documentation' || profile.taskType === 'presentation') {
    return writePaths.length === 0 || writePaths.every(isDocumentationPath);
  }
  return writePaths.length > 0 && writePaths.every(isDocumentationPath);
}

function isMultiFileSharedWorkflowChange(paths: string[], text: string): boolean {
  if (paths.length < 2) return false;
  return paths.some((path) => containsAny(normalizePath(path), SHARED_WORKFLOW_PATH_SIGNALS)) ||
    containsAny(text, SHARED_WORKFLOW_TEXT_SIGNALS);
}

function isChatAnswer(writePaths: string[], text: string): boolean {
  return writePaths.length === 0 && containsAny(text, CHAT_ANSWER_SIGNALS);
}

function isTestOnlyChange(writePaths: string[]): boolean {
  return writePaths.length > 0 && writePaths.every((path) => /\.test\.[cm]?[jt]sx?$|\/__tests__\//i.test(path));
}

function isOpsOrConfigChange(writePaths: string[], text: string): boolean {
  return writePaths.some((path) => isDependencyPath(path) || isRootConfigPath(path)) ||
    containsAny(text, [...DEPENDENCY_SIGNALS, ...ROOT_CONFIG_SIGNALS]);
}

function isDependencyPath(path: string): boolean {
  const normalized = normalizePath(path);
  return /(^|\/)package\.json$/.test(normalized) ||
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/.test(normalized);
}

function isRootConfigPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (/(^|\/)tsconfig(\..*)?\.json$/.test(normalized)) return true;
  if (normalized.includes('/')) return false;
  return /^(vite|webpack|rollup|eslint|prettier|tailwind|postcss|vitest|jest|playwright|turbo)\.config\.[cm]?[jt]s$/.test(normalized);
}

function isDatabasePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.includes('/migrations/') ||
    /\.sql$/.test(normalized) ||
    /(^|\/)(db|database|schema|migration)s?\.[cm]?[jt]s$/.test(normalized);
}

function isDocumentationPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '' ||
    normalized === 'readme' ||
    /\.(md|mdx|txt|rst)$/.test(normalized) ||
    normalized.startsWith('docs/') ||
    normalized.includes('/docs/') ||
    /\.(ppt|pptx|key)$/.test(normalized);
}

function normalizeText(parts: string[]): string {
  return parts.join('\n').toLowerCase();
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').toLowerCase();
}

function containsAny(text: string, signals: string[]): boolean {
  return signals.some((signal) => text.includes(signal));
}

const CHAT_ANSWER_SIGNALS = [
  'answer',
  'explain',
  'question',
  '回答',
  '解释',
  '说明一下',
];

const BRAINSTORMING_SIGNALS = [
  'brainstorm',
  'ideate',
  '方案',
  '头脑风暴',
  '讨论',
];

const CODE_REVIEW_SIGNALS = [
  'code review',
  'review',
  '审查',
  '评审',
];

const DEPENDENCY_SIGNALS = [
  'dependency',
  'dependencies',
  'package.json',
  'package-lock',
  'lockfile',
  '依赖',
  '锁文件',
];

const ROOT_CONFIG_SIGNALS = [
  'tsconfig',
  'root config',
  'build config',
  '根配置',
  '构建配置',
];

const DATABASE_SIGNALS = [
  'migration',
  'database migration',
  'schema migration',
  'sqlite migration',
  'sql',
  'db migration',
  '数据库迁移',
  '数据迁移',
];

const SECURITY_SIGNALS = [
  'security',
  'permission',
  'permissions',
  'credential',
  'credentials',
  'secret',
  'sandbox',
  'delete',
  'remove files',
  '安全',
  '权限',
  '凭证',
  '密钥',
  '沙箱',
  '删除',
];

const SHARED_WORKFLOW_PATH_SIGNALS = [
  '/workflows/',
  '/shared/',
  '/contracts/',
  '/schemas/',
  '/types/',
  'workflow',
  'shared',
  'contract',
  'schema',
  'types',
];

const SHARED_WORKFLOW_TEXT_SIGNALS = [
  'workflow',
  'shared',
  'contract',
  'schema',
  'types',
  '工作流',
  '共享',
  '契约',
  '类型',
];
