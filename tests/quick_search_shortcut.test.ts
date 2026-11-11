import { describe, it, expect } from 'vitest';
import { getDefaultAccelerator, isValidAccelerator } from '../src/main/quick-search-shortcut.js';

describe('Quick Search Shortcut — accelerator logic (spec §6)', () => {
  describe('getDefaultAccelerator', () => {
    it('defaults to Option+Space (Alt+Space) on macOS -- not Cmd+M (system Minimize)', () => {
      expect(getDefaultAccelerator('darwin')).toBe('Alt+Space');
    });

    it('defaults to Ctrl+Shift+M on Windows -- not Alt+Space (system window menu)', () => {
      expect(getDefaultAccelerator('win32')).toBe('Ctrl+Shift+M');
    });

    it('defaults to Ctrl+Shift+M on Linux as well', () => {
      expect(getDefaultAccelerator('linux')).toBe('Ctrl+Shift+M');
    });
  });

  describe('isValidAccelerator', () => {
    it('accepts the platform defaults', () => {
      expect(isValidAccelerator('Alt+Space')).toBe(true);
      expect(isValidAccelerator('Ctrl+Shift+M')).toBe(true);
    });

    it('accepts common modifier+key combinations', () => {
      expect(isValidAccelerator('CmdOrCtrl+Shift+F')).toBe(true);
      expect(isValidAccelerator('Control+Alt+K')).toBe(true);
      expect(isValidAccelerator('Super+Space')).toBe(true);
      expect(isValidAccelerator('Shift+F12')).toBe(true);
      expect(isValidAccelerator('Ctrl+9')).toBe(true);
    });

    it('rejects a bare key with no modifier (would hijack that key system-wide)', () => {
      expect(isValidAccelerator('Space')).toBe(false);
      expect(isValidAccelerator('A')).toBe(false);
      expect(isValidAccelerator('F5')).toBe(false);
    });

    it('rejects empty, malformed, or unknown-key input', () => {
      expect(isValidAccelerator('')).toBe(false);
      expect(isValidAccelerator('   ')).toBe(false);
      expect(isValidAccelerator('Ctrl+')).toBe(false);
      expect(isValidAccelerator('Ctrl+NotAKey')).toBe(false);
      expect(isValidAccelerator('NotAModifier+M')).toBe(false);
    });

    it('is case-insensitive on token names', () => {
      expect(isValidAccelerator('ctrl+shift+m')).toBe(true);
      expect(isValidAccelerator('CTRL+SHIFT+M')).toBe(true);
    });
  });
});
