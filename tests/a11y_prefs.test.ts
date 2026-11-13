import { describe, it, expect } from 'vitest';
import {
  DEFAULT_A11Y_PREFS,
  normalizeA11yPrefs,
  resolveA11yPrefs,
  isValidTextScale,
  isValidTriState,
  A11Y_PREFS_STORAGE_KEY,
  type A11yPrefs
} from '../src/renderer/a11y-prefs.js';
import {
  conflictsWithScreenReader,
  isScreenReaderReservedKey,
  isValidAccelerator,
  getDefaultAccelerator,
  SCREEN_READER_CONFLICT_MESSAGE
} from '../src/main/quick-search-shortcut.js';

describe('Accessibility preferences (spec §24)', () => {
  it('follows the system by default', () => {
    expect(DEFAULT_A11Y_PREFS.useSystemSettings).toBe(true);
    expect(DEFAULT_A11Y_PREFS.highContrast).toBe('system');
    expect(DEFAULT_A11Y_PREFS.reduceMotion).toBe('system');
    expect(DEFAULT_A11Y_PREFS.textScale).toBe(100);
    expect(DEFAULT_A11Y_PREFS.linearResults).toBe(false);
  });

  it('offers exactly the text scales the spec lists', () => {
    for (const scale of [100, 125, 150, 175, 200]) {
      expect(isValidTextScale(scale)).toBe(true);
    }
    expect(isValidTextScale(110)).toBe(false);
    expect(isValidTextScale('150')).toBe(false);
  });

  it('accepts only the three-state values', () => {
    expect(isValidTriState('system')).toBe(true);
    expect(isValidTriState('on')).toBe(true);
    expect(isValidTriState('off')).toBe(true);
    expect(isValidTriState('auto')).toBe(false);
  });

  it('repairs corrupt or partial stored preferences', () => {
    expect(normalizeA11yPrefs(null)).toEqual(DEFAULT_A11Y_PREFS);
    expect(normalizeA11yPrefs('nonsense')).toEqual(DEFAULT_A11Y_PREFS);
    expect(normalizeA11yPrefs({ textScale: 999, highContrast: 'maybe' }))
      .toEqual(DEFAULT_A11Y_PREFS);
    expect(normalizeA11yPrefs({ useSystemSettings: false, textScale: 175 }))
      .toEqual({ ...DEFAULT_A11Y_PREFS, useSystemSettings: false, textScale: 175 });
  });

  it('defers entirely to the OS media queries while system settings are on', () => {
    const prefs: A11yPrefs = {
      useSystemSettings: true,
      textScale: 200,
      highContrast: 'on',
      reduceMotion: 'on',
      linearResults: true
    };
    const resolved = resolveA11yPrefs(prefs);
    expect(resolved.textScalePercent).toBe(100);
    expect(resolved.forceHighContrast).toBeNull();
    expect(resolved.reduceMotion).toBeNull();
    // Layout has no OS equivalent, so it is honoured either way.
    expect(resolved.linearResults).toBe(true);
  });

  it('applies explicit overrides once system settings are off', () => {
    const resolved = resolveA11yPrefs({
      useSystemSettings: false,
      textScale: 150,
      highContrast: 'on',
      reduceMotion: 'off',
      linearResults: false
    });
    expect(resolved.textScalePercent).toBe(150);
    expect(resolved.forceHighContrast).toBe(true);
    expect(resolved.reduceMotion).toBe(false);
  });

  it('leaves "system" per-setting to the media query even when overriding', () => {
    const resolved = resolveA11yPrefs({
      useSystemSettings: false,
      textScale: 125,
      highContrast: 'system',
      reduceMotion: 'system',
      linearResults: false
    });
    expect(resolved.forceHighContrast).toBeNull();
    expect(resolved.reduceMotion).toBeNull();
  });

  it('stores preferences locally only (spec §38)', () => {
    expect(A11Y_PREFS_STORAGE_KEY).toBe('metinbul:a11y');
  });
});

describe('A11Y-L — shortcuts do not hijack screen reader modifiers (spec §8)', () => {
  it('identifies the keys NVDA, JAWS and Narrator claim', () => {
    for (const key of ['Insert', 'insert', 'CapsLock', 'capslock', 'NumLock']) {
      expect(isScreenReaderReservedKey(key)).toBe(true);
    }
    expect(isScreenReaderReservedKey('M')).toBe(false);
    expect(isScreenReaderReservedKey('Space')).toBe(false);
  });

  it('refuses an accelerator using a reserved key in either position', () => {
    expect(conflictsWithScreenReader('Ctrl+Insert')).toBe(true);
    expect(conflictsWithScreenReader('Insert+M')).toBe(true);
    expect(conflictsWithScreenReader('CapsLock+K')).toBe(true);
    expect(conflictsWithScreenReader('Ctrl+Shift+M')).toBe(false);
  });

  it('rejects reserved combinations through the normal validator', () => {
    expect(isValidAccelerator('Ctrl+Insert')).toBe(false);
    expect(isValidAccelerator('Ctrl+Shift+Insert')).toBe(false);
    expect(isValidAccelerator('Ctrl+Shift+M')).toBe(true);
  });

  it('explains the refusal in Turkish rather than as a syntax error', () => {
    expect(SCREEN_READER_CONFLICT_MESSAGE).toContain('ekran okuyucular');
    expect(SCREEN_READER_CONFLICT_MESSAGE).toContain('Caps Lock');
  });

  it('ships defaults that no target screen reader reserves', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
      const accelerator = getDefaultAccelerator(platform);
      expect(conflictsWithScreenReader(accelerator)).toBe(false);
      // Judged by that platform's rules: Alt+Space is macOS's default and
      // Windows' window menu.
      expect(isValidAccelerator(accelerator, platform), `${platform}: ${accelerator}`).toBe(true);
    }
  });
});
