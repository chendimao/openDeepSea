export type ThemeStyle = 'apple' | 'minimal';
export type ThemeTone = 'light' | 'dark';
export type ThemeMode = `${ThemeStyle}-${ThemeTone}`;
export type LegacyThemeMode = 'light' | 'dark' | 'console' | 'minimal';

export const THEME_STYLES: ThemeStyle[] = ['apple', 'minimal'];

export const THEME_TONES: ThemeTone[] = ['light', 'dark'];

export const DEFAULT_THEME_MODE: ThemeMode = 'apple-light';

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
  if (value === 'light') return DEFAULT_THEME_MODE;
  if (value === 'dark') return 'apple-dark';
  if (value === 'minimal' || value === 'console') return 'minimal-light';
  return DEFAULT_THEME_MODE;
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
