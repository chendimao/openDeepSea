export type ThemeStyle = 'apple' | 'minimal';
export type ThemeTone = 'light' | 'dark';
export type ThemeMode = `${ThemeStyle}-${ThemeTone}`;
export type LegacyThemeMode = 'light' | 'dark' | 'console' | 'minimal';

export const THEME_STYLES: Array<{ value: ThemeStyle; label: string }> = [
  { value: 'apple', label: '苹果风' },
  { value: 'minimal', label: '极简风' },
];

export const THEME_TONES: Array<{ value: ThemeTone; label: string }> = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];

const THEME_MODES = new Set<ThemeMode>([
  'apple-light',
  'apple-dark',
  'minimal-light',
  'minimal-dark',
]);

export function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && THEME_MODES.has(value as ThemeMode);
}

export function parseThemeMode(value: string | null): ThemeMode {
  if (isThemeMode(value)) return value;
  if (value === 'light') return 'apple-light';
  if (value === 'dark') return 'apple-dark';
  if (value === 'minimal' || value === 'console') return 'minimal-light';
  return 'apple-light';
}

export function getThemeStyle(theme: ThemeMode): ThemeStyle {
  return theme.startsWith('minimal-') ? 'minimal' : 'apple';
}

export function getThemeTone(theme: ThemeMode): ThemeTone {
  return theme.endsWith('-dark') ? 'dark' : 'light';
}

export function createThemeMode(style: ThemeStyle, tone: ThemeTone): ThemeMode {
  return `${style}-${tone}`;
}
