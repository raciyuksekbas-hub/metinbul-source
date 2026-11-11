export type AppTheme = 'dark' | 'light';

export const DEFAULT_THEME: AppTheme = 'dark';
export const THEME_STORAGE_KEY = 'metinbul:theme';

export function isValidTheme(theme: unknown): theme is AppTheme {
  return theme === 'dark' || theme === 'light';
}

export function getNextTheme(current: AppTheme): AppTheme {
  return current === 'dark' ? 'light' : 'dark';
}

// Native window background, matching --bg-body in style.css, so a window
// never flashes a different tone before its page has painted.
export function getThemeBackgroundColor(theme: AppTheme): string {
  return theme === 'dark' ? '#1c1b1a' : '#f5f4f1';
}

// The Quick Search panel sits one tone above the page background
// (--bg-panel); its native colour has to match for the same reason, and
// because the window is resized as results arrive.
export function getPanelBackgroundColor(theme: AppTheme): string {
  return theme === 'dark' ? '#242322' : '#fbfaf8';
}
