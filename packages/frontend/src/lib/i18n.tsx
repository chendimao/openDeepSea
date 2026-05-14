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
