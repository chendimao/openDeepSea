export type TaskProfileType =
  | 'frontend_feature'
  | 'backend_feature'
  | 'fullstack_feature'
  | 'presentation'
  | 'documentation'
  | 'data_analysis'
  | 'bugfix'
  | 'general';

export type TaskProfileDomain = 'frontend' | 'backend' | 'ui' | 'documentation' | 'presentation' | 'data';

export interface TaskProfileInput {
  title: string;
  description: string;
  scopeRead: string[];
  scopeWrite: string[];
  acceptance?: string[];
}

export interface TaskProfile {
  taskType: TaskProfileType;
  domains: TaskProfileDomain[];
  artifactTypes: string[];
  workflowTemplate: TaskProfileType;
  requiredCapabilities: string[];
  recommendedTemplateId: string | null;
  confidence: number;
  reasons: string[];
}

export function inferTaskProfile(input: TaskProfileInput): TaskProfile {
  const text = [
    input.title,
    input.description,
    ...input.scopeRead,
    ...input.scopeWrite,
    ...(input.acceptance ?? []),
  ].join('\n').toLowerCase();
  const frontend = countSignals(text, FRONTEND_SIGNALS);
  const backend = countSignals(text, BACKEND_SIGNALS);
  const ui = countSignals(text, UI_SIGNALS);
  const presentation = countSignals(text, PRESENTATION_SIGNALS);
  const documentation = countSignals(text, DOCUMENTATION_SIGNALS);
  const data = countSignals(text, DATA_SIGNALS);
  const bugfix = countSignals(text, BUGFIX_SIGNALS);
  const reasons: string[] = [];
  const domains: TaskProfileDomain[] = [];
  let taskType: TaskProfileType = 'general';
  let recommendedTemplateId: string | null = null;

  if (presentation > 0) {
    taskType = 'presentation';
    domains.push('presentation');
    recommendedTemplateId = 'technical-writer';
    reasons.push('presentation signals matched');
  } else if (data > 0 && frontend === 0 && backend === 0) {
    taskType = 'data_analysis';
    domains.push('data');
    recommendedTemplateId = 'data-analyst';
    reasons.push('data analysis signals matched');
  } else if (documentation > 0 && frontend === 0 && backend === 0) {
    taskType = 'documentation';
    domains.push('documentation');
    recommendedTemplateId = 'technical-writer';
    reasons.push('documentation signals matched');
  } else if (frontend > 0 && backend > 0) {
    taskType = bugfix > 0 ? 'bugfix' : 'fullstack_feature';
    domains.push('frontend', 'backend');
    if (ui > 0) domains.push('ui');
    recommendedTemplateId = 'frontend-executor';
    reasons.push('frontend and backend signals matched');
  } else if (frontend > 0 || ui > 0) {
    taskType = 'frontend_feature';
    domains.push('frontend');
    if (ui > 0) domains.push('ui');
    recommendedTemplateId = 'frontend-executor';
    reasons.push('frontend or UI signals matched');
  } else if (backend > 0) {
    taskType = 'backend_feature';
    domains.push('backend');
    recommendedTemplateId = 'backend-executor';
    reasons.push('backend signals matched');
  }

  return {
    taskType,
    domains: Array.from(new Set(domains)),
    artifactTypes: artifactTypesForTask(taskType),
    workflowTemplate: taskType,
    requiredCapabilities: requiredCapabilitiesForTask(taskType, domains),
    recommendedTemplateId,
    confidence: confidenceForScores({ frontend, backend, ui, presentation, documentation, data, bugfix }),
    reasons,
  };
}

function artifactTypesForTask(taskType: TaskProfileType): string[] {
  switch (taskType) {
    case 'presentation':
      return ['presentation'];
    case 'documentation':
      return ['document'];
    case 'data_analysis':
      return ['analysis'];
    case 'frontend_feature':
    case 'backend_feature':
    case 'fullstack_feature':
    case 'bugfix':
      return ['code', 'tests'];
    case 'general':
      return [];
  }
}

function requiredCapabilitiesForTask(taskType: TaskProfileType, domains: TaskProfileDomain[]): string[] {
  const capabilities = new Set<string>();
  for (const domain of domains) {
    if (domain === 'ui') capabilities.add('frontend');
    else capabilities.add(domain);
  }
  if (taskType === 'presentation') {
    capabilities.add('document');
    capabilities.add('writing');
  }
  if (taskType === 'documentation') {
    capabilities.add('document');
    capabilities.add('writing');
  }
  if (taskType === 'bugfix') capabilities.add('testing');
  return [...capabilities];
}

function confidenceForScores(scores: Record<string, number>): number {
  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0.35;
  return Math.min(0.95, 0.55 + total * 0.08);
}

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal.toLowerCase()) ? 1 : 0), 0);
}

const FRONTEND_SIGNALS = [
  'frontend',
  'front-end',
  'react',
  'tsx',
  'jsx',
  'vite',
  'tailwind',
  'packages/frontend',
  'src/pages',
  'src/components',
  '前端',
  '侧边栏',
  '页面',
  '组件',
  '跳转',
];

const UI_SIGNALS = [
  'ui',
  'ux',
  '界面',
  '交互',
  '空态',
  '高亮',
  'i18n',
  '文案',
  '侧边栏',
];

const BACKEND_SIGNALS = [
  'backend',
  'back-end',
  'api',
  'sqlite',
  'database',
  'route',
  'routes',
  'repo',
  'repos',
  'packages/backend',
  '后端',
  '接口',
  '数据库',
  '仓储',
];

const PRESENTATION_SIGNALS = [
  'ppt',
  'powerpoint',
  'slides',
  'slide deck',
  '幻灯片',
  '演示文稿',
  '汇报',
];

const DOCUMENTATION_SIGNALS = [
  'documentation',
  'document',
  'markdown',
  'readme',
  'docs/',
  '.md',
  '文档',
  '说明',
];

const DATA_SIGNALS = [
  'data analysis',
  'csv',
  'xlsx',
  '报表',
  '指标',
  '数据分析',
  '可视化',
];

const BUGFIX_SIGNALS = [
  'bug',
  'fix',
  '修复',
  '报错',
  '回归',
];
