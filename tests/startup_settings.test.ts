import { describe, it, expect } from 'vitest';
import {
  AUTOSTART_ARG,
  buildLoginItemConfig,
  buildLoginItemQueryOptions,
  isBackgroundResidencySupported,
  isStartAtLoginSupported,
  parseBooleanSetting,
  serializeBooleanSetting,
  shouldRunAutoIndex,
  wasLaunchedAtLogin,
  AUTO_INDEX_INTERVAL_MS
} from '../src/main/startup-settings.js';
import { formatAcceleratorForDisplay } from '../src/main/quick-search-shortcut.js';

describe('Startup & background preferences — pure logic', () => {
  describe('buildLoginItemConfig', () => {
    it('registers the bundle itself on macOS, with no argv of its own', () => {
      const config = buildLoginItemConfig('darwin', true, '/Applications/MetinBul.app/Contents/MacOS/MetinBul');
      expect(config).toEqual({ openAtLogin: true });
    });

    it('tags the Windows Run-key entry so the launched process knows it was auto-started', () => {
      const config = buildLoginItemConfig('win32', true, 'C:\\Program Files\\MetinBul\\MetinBul.exe');
      expect(config.openAtLogin).toBe(true);
      expect(config.path).toBe('C:\\Program Files\\MetinBul\\MetinBul.exe');
      expect(config.args).toEqual([AUTOSTART_ARG]);
    });

    it('turns the login item off with the same shape it was written with', () => {
      expect(buildLoginItemConfig('darwin', false, '/x').openAtLogin).toBe(false);
      const win = buildLoginItemConfig('win32', false, 'C:\\x.exe');
      expect(win.openAtLogin).toBe(false);
      expect(win.args).toEqual([AUTOSTART_ARG]);
    });

    it('never sets the deprecated openAsHidden (a no-op on macOS 13+)', () => {
      expect(buildLoginItemConfig('darwin', true, '/x')).not.toHaveProperty('openAsHidden');
    });
  });

  describe('buildLoginItemQueryOptions', () => {
    // Electron matches the Windows Run-key value by path+args; reading it
    // back without them reports openAtLogin false even when it is set.
    it('reads the Windows entry back with the same path and args', () => {
      expect(buildLoginItemQueryOptions('win32', 'C:\\x.exe')).toEqual({
        path: 'C:\\x.exe',
        args: [AUTOSTART_ARG]
      });
    });

    it('needs no options on macOS', () => {
      expect(buildLoginItemQueryOptions('darwin', '/x')).toEqual({});
    });
  });

  describe('platform support gates', () => {
    it('offers start-at-login where Electron has a native mechanism', () => {
      expect(isStartAtLoginSupported('darwin')).toBe(true);
      expect(isStartAtLoginSupported('win32')).toBe(true);
      expect(isStartAtLoginSupported('linux')).toBe(false);
    });

    it('offers background residency only where a windowless app can still be quit', () => {
      expect(isBackgroundResidencySupported('darwin')).toBe(true);
      expect(isBackgroundResidencySupported('win32')).toBe(true);
      expect(isBackgroundResidencySupported('linux')).toBe(false);
    });
  });

  describe('wasLaunchedAtLogin', () => {
    it('detects a Windows auto-start from the marker argument', () => {
      expect(wasLaunchedAtLogin('win32', ['MetinBul.exe', AUTOSTART_ARG], undefined)).toBe(true);
      expect(wasLaunchedAtLogin('win32', ['MetinBul.exe'], undefined)).toBe(false);
    });

    it('detects a macOS auto-start from wasOpenedAtLogin, not from argv', () => {
      expect(wasLaunchedAtLogin('darwin', ['MetinBul'], { wasOpenedAtLogin: true })).toBe(true);
      expect(wasLaunchedAtLogin('darwin', ['MetinBul'], { wasOpenedAtLogin: false })).toBe(false);
      expect(wasLaunchedAtLogin('darwin', ['MetinBul', AUTOSTART_ARG], { wasOpenedAtLogin: false })).toBe(false);
    });

    it('treats missing login-item state as a normal user launch', () => {
      expect(wasLaunchedAtLogin('darwin', ['MetinBul'], undefined)).toBe(false);
      expect(wasLaunchedAtLogin('linux', ['MetinBul'], undefined)).toBe(false);
    });
  });

  describe('boolean setting round-trip (app_settings stores TEXT)', () => {
    it('defaults to off when the key has never been written', () => {
      expect(parseBooleanSetting(undefined)).toBe(false);
      expect(parseBooleanSetting(null)).toBe(false);
    });

    it('honours an explicit stored value in both directions', () => {
      expect(parseBooleanSetting('1')).toBe(true);
      expect(parseBooleanSetting('0')).toBe(false);
      expect(parseBooleanSetting('0', true)).toBe(false);
    });

    it('falls back for values it does not recognise', () => {
      expect(parseBooleanSetting('true')).toBe(false);
      expect(parseBooleanSetting('yes', true)).toBe(true);
    });

    it('round-trips through serialize', () => {
      expect(parseBooleanSetting(serializeBooleanSetting(true))).toBe(true);
      expect(parseBooleanSetting(serializeBooleanSetting(false))).toBe(false);
    });
  });
});

describe('formatAcceleratorForDisplay', () => {
  it('renders the macOS default as the "⌥ Space" the UI promises', () => {
    expect(formatAcceleratorForDisplay('Alt+Space', 'darwin')).toBe('⌥ Space');
  });

  it('maps every modifier to its Mac symbol', () => {
    expect(formatAcceleratorForDisplay('CmdOrCtrl+Shift+F', 'darwin')).toBe('⌘ ⇧ F');
    expect(formatAcceleratorForDisplay('Control+Option+K', 'darwin')).toBe('⌃ ⌥ K');
  });

  it('keeps the plus-separated spelling on Windows and Linux', () => {
    expect(formatAcceleratorForDisplay('Ctrl+Shift+M', 'win32')).toBe('Ctrl+Shift+M');
    expect(formatAcceleratorForDisplay('Ctrl+Shift+M', 'linux')).toBe('Ctrl+Shift+M');
  });

  it('leaves unknown tokens alone rather than dropping them', () => {
    expect(formatAcceleratorForDisplay('Alt+F12', 'darwin')).toBe('⌥ F12');
  });

  it('returns an empty string for an empty accelerator', () => {
    expect(formatAcceleratorForDisplay('', 'darwin')).toBe('');
  });
});

describe('Automatic index update', () => {
  it('runs every ten minutes', () => {
    expect(AUTO_INDEX_INTERVAL_MS).toBe(10 * 60 * 1000);
  });

  it('starts a due update only when it is on, idle, and setup is done', () => {
    const due = { enabled: true, isIndexing: false, onboardingPending: false };
    expect(shouldRunAutoIndex(due)).toBe(true);
    expect(shouldRunAutoIndex({ ...due, enabled: false })).toBe(false);
    expect(shouldRunAutoIndex({ ...due, isIndexing: true })).toBe(false);
    expect(shouldRunAutoIndex({ ...due, onboardingPending: true })).toBe(false);
  });

  it('is on unless the user turned it off', () => {
    expect(parseBooleanSetting(undefined, true)).toBe(true);
    expect(parseBooleanSetting('0', true)).toBe(false);
  });
});
