// Pure, Electron-free helpers for the two startup/background preferences
// ("Bilgisayar açıldığında MetinBul'u başlat" and "Pencere kapandığında
// arka planda açık tut"), kept separate from main.ts so they're
// unit-testable without a running Electron process -- the same split
// quick-search-shortcut.ts already uses. The Electron-side effects
// (app.setLoginItemSettings, app.quit) can only be exercised by the
// packaged-app smoke pass.

// Passed to the Windows login-item registration so the launched process can
// tell "the user started me" from "Windows started me at sign-in". macOS
// gets the same information from getLoginItemSettings().wasOpenedAtLogin
// and needs no argument.
export const AUTOSTART_ARG = '--metinbul-autostart';

export interface LoginItemConfig {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

// macOS deliberately gets no `path`/`args`: on macOS 13+ Electron registers
// the bundle through SMAppService, which launches the .app itself and has
// nowhere to put custom argv. Windows writes a Run-key entry, where the
// marker argument is both allowed and necessary.
//
// `openAsHidden` is deliberately NOT set: Electron marks it deprecated and
// it does nothing on macOS 13 and up. The hidden start is instead achieved
// by simply not creating the main window on a login launch (see main.ts).
export function buildLoginItemConfig(
  platform: NodeJS.Platform,
  enabled: boolean,
  execPath: string
): LoginItemConfig {
  if (platform === 'win32') {
    return { openAtLogin: enabled, path: execPath, args: [AUTOSTART_ARG] };
  }
  return { openAtLogin: enabled };
}

// Whether the OS-level login item is something we can offer at all. macOS
// and Windows both have a native mechanism behind setLoginItemSettings;
// Linux has none in Electron, so the setting is hidden there rather than
// silently doing nothing.
export function isStartAtLoginSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

// A windowless MetinBul needs a visible way back and a way to quit. macOS has
// the Dock icon and the menu bar ("MetinBul'dan Çık", Cmd+Q); Windows has the
// notification area icon (createTray in main.ts). Linux has neither here, so
// it keeps the "closing the window quits" rule.
export function isBackgroundResidencySupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export interface LoginItemStateLike {
  wasOpenedAtLogin?: boolean;
}

// True when this process was started by the OS at sign-in rather than by the
// user. Used only to decide whether to put a window on screen and whether to
// kick off the launch-time index -- never to enable any background work.
export function wasLaunchedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  loginItemState: LoginItemStateLike | undefined
): boolean {
  if (platform === 'win32') {
    return argv.includes(AUTOSTART_ARG);
  }
  if (platform === 'darwin') {
    return loginItemState?.wasOpenedAtLogin === true;
  }
  return false;
}

// app_settings stores everything as TEXT; '1'/'0' matches the existing
// 'onboarding_completed' convention rather than introducing a second one.
export function parseBooleanSetting(raw: string | undefined | null, fallback = false): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

export function serializeBooleanSetting(value: boolean): string {
  return value ? '1' : '0';
}

// "Belgeleri otomatik güncelle" ('auto_index_enabled', default on): while
// MetinBul runs, the index is brought up to date this long after the previous
// update ended -- or after launch, never at launch itself, so starting
// MetinBul still costs no disk walk.
export const AUTO_INDEX_INTERVAL_MS = 10 * 60 * 1000;

export interface AutoIndexState {
  enabled: boolean;
  isIndexing: boolean;
  onboardingPending: boolean;
}

// Whether a due automatic update should start now: never on top of a running
// update, and not before setup has decided what to search.
export function shouldRunAutoIndex(state: AutoIndexState): boolean {
  return state.enabled && !state.isIndexing && !state.onboardingPending;
}

// The options shape app.getLoginItemSettings() needs in order to look up the
// entry buildLoginItemConfig() wrote: Electron matches the Windows Run-key
// value by path+args, so reading it back without them reports openAtLogin
// as false even when the entry exists.
export function buildLoginItemQueryOptions(
  platform: NodeJS.Platform,
  execPath: string
): { path?: string; args?: string[] } {
  if (platform === 'win32') {
    return { path: execPath, args: [AUTOSTART_ARG] };
  }
  return {};
}
