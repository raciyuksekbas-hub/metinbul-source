import { describe, it, expect } from 'vitest';
import { getDefaultAccelerator, isReservedAccelerator, isValidAccelerator } from '../src/main/quick-search-shortcut.js';

describe('Quick Search Shortcut — accelerator logic (spec §6)', () => {
  describe('getDefaultAccelerator', () => {
    it('defaults to Option+Space (Alt+Space) on macOS -- not Cmd+M (system Minimize)', () => {
      expect(getDefaultAccelerator('darwin')).toBe('Alt+Space');
    });

    it('defaults to Ctrl+Alt+Space on Windows -- not Alt+Space (window menu), nor Ctrl+Shift+M (Teams mute, Outlook new message)', () => {
      expect(getDefaultAccelerator('win32')).toBe('Ctrl+Alt+Space');
    });

    it('defaults to Ctrl+Alt+Space on Linux as well', () => {
      expect(getDefaultAccelerator('linux')).toBe('Ctrl+Alt+Space');
    });
  });

  describe('isValidAccelerator', () => {
    it('accepts the platform defaults', () => {
      expect(isValidAccelerator('Alt+Space', 'darwin')).toBe(true);
      expect(isValidAccelerator('Ctrl+Alt+Space', 'win32')).toBe(true);
    });

    it('accepts common modifier+key combinations', () => {
      expect(isValidAccelerator('CmdOrCtrl+Shift+F', 'darwin')).toBe(true);
      expect(isValidAccelerator('CmdOrCtrl+Shift+F', 'win32')).toBe(true);
      expect(isValidAccelerator('Control+Alt+K', 'win32')).toBe(true);
      expect(isValidAccelerator('Super+Shift+K', 'darwin')).toBe(true);
      expect(isValidAccelerator('Ctrl+9', 'win32')).toBe(true);
      // A user may still choose a combination another program uses.
      expect(isValidAccelerator('Ctrl+Shift+M', 'win32')).toBe(true);
    });

    it('rejects a bare key with no modifier (would hijack that key system-wide)', () => {
      expect(isValidAccelerator('Space')).toBe(false);
      expect(isValidAccelerator('A')).toBe(false);
      expect(isValidAccelerator('F5')).toBe(false);
    });

    it('rejects Shift as the only modifier: Shift+K is a capital K', () => {
      for (const platform of ['win32', 'darwin'] as const) {
        expect(isValidAccelerator('Shift+K', platform)).toBe(false);
        expect(isValidAccelerator('Shift+F12', platform)).toBe(false);
        expect(isValidAccelerator('Shift+Space', platform)).toBe(false);
      }
    });

    it('rejects the shortcuts everyone relies on, and the system\'s own', () => {
      for (const accelerator of ['Ctrl+C', 'Control+V', 'ctrl+x', 'Ctrl+Z', 'Ctrl+S', 'CmdOrCtrl+P', 'Alt+F4', 'Alt+Tab', 'Alt+Space', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Delete', 'Super+L', 'Super+D', 'Super+Shift+S']) {
        expect(isReservedAccelerator(accelerator, 'win32'), accelerator).toBe(true);
        expect(isValidAccelerator(accelerator, 'win32'), accelerator).toBe(false);
      }
      for (const accelerator of ['Command+C', 'Cmd+V', 'CmdOrCtrl+Q', 'Command+Space', 'Super+Space', 'Control+Command+Space', 'Command+Tab', 'Command+Shift+4', 'Control+Space']) {
        expect(isReservedAccelerator(accelerator, 'darwin'), accelerator).toBe(true);
        expect(isValidAccelerator(accelerator, 'darwin'), accelerator).toBe(false);
      }
      // Windows-key shortcuts are fine with Ctrl or Alt added; Alt+Space is
      // macOS's default and free there.
      expect(isReservedAccelerator('Ctrl+Super+K', 'win32')).toBe(false);
      expect(isReservedAccelerator('Alt+Space', 'darwin')).toBe(false);
      expect(isReservedAccelerator('Ctrl+C', 'darwin')).toBe(false);
    });

    it('rejects empty, malformed, or unknown-key input', () => {
      expect(isValidAccelerator('')).toBe(false);
      expect(isValidAccelerator('   ')).toBe(false);
      expect(isValidAccelerator('Ctrl+')).toBe(false);
      expect(isValidAccelerator('Ctrl+NotAKey')).toBe(false);
      expect(isValidAccelerator('NotAModifier+M')).toBe(false);
    });

    it('is case-insensitive on token names', () => {
      expect(isValidAccelerator('ctrl+alt+m', 'win32')).toBe(true);
      expect(isValidAccelerator('CTRL+ALT+M', 'win32')).toBe(true);
    });
  });
});
