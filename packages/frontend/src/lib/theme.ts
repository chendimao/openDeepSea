export type ThemeMode = 'light' | 'dark' | 'console' | 'minimal';

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'console' || value === 'minimal';
}
