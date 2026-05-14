import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'zh' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh';
const STORAGE_KEY = 'openclaw-room-locale';

const zhMessages = {
  'app.name': '深海指挥中心',
  'app.tagline': '管理本地项目、群聊与智能体协作上下文',
  'language.label': '界面语言',
  'language.zh': '中文',
  'language.en': 'EN',
  'shell.sidebar.aria': '项目工作区',
  'shell.subtitle': '本地智能体控制台',
  'shell.newProject': '新增项目',
  'shell.systemSettings': '系统设置',
  'shell.searchCommand': '搜索 / 快速命令',
  'shell.nav.development': '开发',
  'shell.nav.roadmap': '路线',
  'shell.nav.tasks': '任务',
  'shell.nav.workflow': '工作流',
  'shell.nav.files': '文件',
  'shell.currentProject': '当前项目',
  'shell.recentProjects': '最近项目',
  'shell.noProjects': '暂无项目',
  'shell.selectProject': '选择项目',
  'shell.selectProjectDescription': '打开项目后显示工作区摘要。',
  'shell.metric.rooms': '群聊',
  'shell.metric.tasks': '任务',
  'shell.metric.inProgress': '进行中',
  'shell.metric.done': '已完成',
  'theme.label': '主题样式',
  'theme.appleLight': '苹果亮色',
  'theme.appleDark': '苹果暗色',
  'theme.minimalLight': '极简亮色',
  'theme.minimalDark': '极简暗色',
  'theme.style.label': '主题风格',
  'theme.style.apple': '苹果风',
  'theme.style.minimal': '极简风',
  'theme.tone.label': '明暗模式',
  'theme.tone.light': '亮色',
  'theme.tone.dark': '暗色',
  'gateway.label': 'OpenClaw 网关',
  'gateway.dialogTitle': '本机 OpenClaw',
  'gateway.dialogDescription': '网关运行状态与本机可用 Agent 信息',
  'gateway.checking': '检查中',
  'gateway.online': '网关在线',
  'gateway.running': '网关运行中',
  'gateway.offline': '网关离线',
  'gateway.serviceStatus': '服务状态',
  'gateway.connected': '已连接',
  'gateway.disconnected': '未连接',
  'gateway.runningValue': '运行中',
  'gateway.openClawAgents': 'OpenClaw Agents',
  'gateway.readingAgents': '正在读取本机 OpenClaw agents 列表',
  'gateway.readAgentsFailed': '无法读取本机 OpenClaw agents。',
  'gateway.readAgentsFailedWithMessage': '无法读取本机 OpenClaw agents。错误: {message}',
  'gateway.noAgents': '当前本机 OpenClaw 配置中没有可用 Agent。',
  'gateway.refresh': '刷新 OpenClaw 信息',
  'common.cancel': '取消',
  'common.create': '创建',
  'common.save': '保存',
  'common.apply': '应用',
  'common.close': '关闭',
  'common.settings': '设置',
  'common.loading': '加载中…',
  'common.none': '暂无',
  'common.unassigned': '未指派',
  'common.delete': '删除',
  'common.retry': '重试',
  'common.refresh': '刷新',
  'common.error': '错误',
  'time.justNow': '刚刚',
  'time.minutesAgo': '{count}分钟前',
  'time.hoursAgo': '{count}小时前',
  'time.daysAgo': '{count}天前',
  'time.dateLocale': 'zh-CN',
} as const;

const enMessages: Record<keyof typeof zhMessages, string> = {
  'app.name': 'Deep Sea Command',
  'app.tagline': 'Manage local projects, rooms, and agent collaboration context',
  'language.label': 'Language',
  'language.zh': '中文',
  'language.en': 'EN',
  'shell.sidebar.aria': 'Project workspace',
  'shell.subtitle': 'Local agent console',
  'shell.newProject': 'New project',
  'shell.systemSettings': 'System settings',
  'shell.searchCommand': 'Search / quick command',
  'shell.nav.development': 'Development',
  'shell.nav.roadmap': 'Roadmap',
  'shell.nav.tasks': 'Tasks',
  'shell.nav.workflow': 'Workflow',
  'shell.nav.files': 'Files',
  'shell.currentProject': 'Current project',
  'shell.recentProjects': 'Recent projects',
  'shell.noProjects': 'No projects',
  'shell.selectProject': 'Select project',
  'shell.selectProjectDescription': 'Open a project to show the workspace summary.',
  'shell.metric.rooms': 'Rooms',
  'shell.metric.tasks': 'Tasks',
  'shell.metric.inProgress': 'In progress',
  'shell.metric.done': 'Done',
  'theme.label': 'Theme',
  'theme.appleLight': 'Apple light',
  'theme.appleDark': 'Apple dark',
  'theme.minimalLight': 'Minimal light',
  'theme.minimalDark': 'Minimal dark',
  'theme.style.label': 'Theme style',
  'theme.style.apple': 'Apple',
  'theme.style.minimal': 'Minimal',
  'theme.tone.label': 'Tone',
  'theme.tone.light': 'Light',
  'theme.tone.dark': 'Dark',
  'gateway.label': 'OpenClaw Gateway',
  'gateway.dialogTitle': 'Local OpenClaw',
  'gateway.dialogDescription': 'Gateway status and locally available Agent information',
  'gateway.checking': 'Checking',
  'gateway.online': 'Gateway online',
  'gateway.running': 'Gateway running',
  'gateway.offline': 'Gateway offline',
  'gateway.serviceStatus': 'Service status',
  'gateway.connected': 'Connected',
  'gateway.disconnected': 'Disconnected',
  'gateway.runningValue': 'Running',
  'gateway.openClawAgents': 'OpenClaw Agents',
  'gateway.readingAgents': 'Reading local OpenClaw agents',
  'gateway.readAgentsFailed': 'Unable to read local OpenClaw agents.',
  'gateway.readAgentsFailedWithMessage': 'Unable to read local OpenClaw agents. Error: {message}',
  'gateway.noAgents': 'No available Agents in the local OpenClaw configuration.',
  'gateway.refresh': 'Refresh OpenClaw information',
  'common.cancel': 'Cancel',
  'common.create': 'Create',
  'common.save': 'Save',
  'common.apply': 'Apply',
  'common.close': 'Close',
  'common.settings': 'Settings',
  'common.loading': 'Loading...',
  'common.none': 'None',
  'common.unassigned': 'Unassigned',
  'common.delete': 'Delete',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.error': 'Error',
  'time.justNow': 'just now',
  'time.minutesAgo': '{count} min ago',
  'time.hoursAgo': '{count} hr ago',
  'time.daysAgo': '{count} days ago',
  'time.dateLocale': 'en-US',
};

const dictionaries = {
  zh: zhMessages,
  en: enMessages,
};

export type MessageKey = keyof typeof zhMessages;
type Params = Record<string, string | number>;

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Params) => string;
  formatRelativeTime: (timestamp: number) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export function getInitialLocale(): Locale {
  const storedLocale = localStorage.getItem(STORAGE_KEY);
  return isLocale(storedLocale) ? storedLocale : DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => {
    const translate = (key: MessageKey, params?: Params) => {
      const template = dictionaries[locale][key] ?? dictionaries.zh[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    };

    return {
      locale,
      setLocale,
      t: translate,
      formatRelativeTime: (timestamp: number) => formatRelativeTimeForLocale(timestamp, locale, translate),
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}

function formatRelativeTimeForLocale(
  timestamp: number,
  locale: Locale,
  t: (key: MessageKey, params?: Params) => string,
): string {
  const diff = Date.now() - timestamp;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('time.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('time.daysAgo', { count: day });
  return new Date(timestamp).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US');
}
