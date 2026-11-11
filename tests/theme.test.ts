import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isValidTheme,
  getNextTheme,
  getThemeBackgroundColor,
  getPanelBackgroundColor
} from '../src/shared/theme.js';

const css = fs.readFileSync(path.join(__dirname, '../src/renderer/style.css'), 'utf-8');

function tokenIn(block: 'dark' | 'light', name: string): string | undefined {
  const selector = block === 'dark' ? ':root {' : '[data-theme="light"] {';
  const start = css.indexOf(selector);
  const body = css.slice(start, css.indexOf('}', start));
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
  return match?.[1].toLowerCase();
}

describe('Theme System (Dark / Light)', () => {
  it('should default to dark theme', () => {
    expect(DEFAULT_THEME).toBe('dark');
  });

  it('should validate only dark and light themes (no system mode)', () => {
    expect(isValidTheme('dark')).toBe(true);
    expect(isValidTheme('light')).toBe(true);
    expect(isValidTheme('system')).toBe(false);
    expect(isValidTheme('')).toBe(false);
    expect(isValidTheme(null)).toBe(false);
    expect(isValidTheme(undefined)).toBe(false);
  });

  it('should alternate between dark and light themes', () => {
    expect(getNextTheme('dark')).toBe('light');
    expect(getNextTheme('light')).toBe('dark');
  });

  // The native window colour is what shows before the page paints and, for
  // the panel, while the window resizes; it must be the page's own colour.
  it('matches the native window background to the page background in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(getThemeBackgroundColor(theme)).toBe(tokenIn(theme, 'bg-body'));
    }
  });

  it('matches the Quick Search panel background to its own surface token', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(getPanelBackgroundColor(theme)).toBe(tokenIn(theme, 'bg-panel'));
    }
  });

  it('never uses pure black or pure white as a page surface (spec §21, §22)', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(getThemeBackgroundColor(theme)).not.toMatch(/^#(000000|ffffff)$/i);
      expect(getPanelBackgroundColor(theme)).not.toMatch(/^#(000000|ffffff)$/i);
    }
  });

  it('should have consistent theme storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('metinbul:theme');
  });
});
