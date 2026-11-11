// Pure, Electron-free helpers for the global Quick Search shortcut, kept
// separate from main.ts so they're unit-testable without a running Electron
// process (globalShortcut.register itself can only be exercised by the
// packaged-app smoke pass).

// Explicitly NOT Cmd+M (macOS system Minimize) and NOT Alt+Space on Windows
// (system window menu) -- per the real user feedback this feature is a
// response to.
export function getDefaultAccelerator(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Alt+Space' : 'Ctrl+Shift+M';
}

const MODIFIER_TOKENS = new Set([
  'cmd', 'command', 'commandorcontrol', 'cmdorctrl',
  'control', 'ctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta'
]);

const NAMED_KEY_TOKENS = new Set([
  'space', 'tab', 'backspace', 'delete', 'insert', 'return', 'enter',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'escape', 'esc', 'volumeup', 'volumedown', 'volumemute',
  'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause',
  'printscreen', 'plus', 'minus'
]);

// Keys that Windows screen readers claim as their own modifier. NVDA and
// JAWS both default to Insert (and Caps Lock), and Narrator uses Insert or
// Caps Lock as well; Narrator additionally reserves Caps Lock+key. Binding a
// global shortcut onto one of these would take the navigation key away from
// the screen reader across the whole system, which is exactly the hijacking
// the accessibility spec forbids (spec §8).
const SCREEN_READER_RESERVED_KEYS = new Set([
  'insert', 'capslock', 'numlock'
]);

export function isScreenReaderReservedKey(token: string): boolean {
  return SCREEN_READER_RESERVED_KEYS.has(token.trim().toLowerCase());
}

/**
 * True when the accelerator would collide with a screen reader's modifier
 * key, in either the key or the modifier position.
 */
export function conflictsWithScreenReader(accelerator: string): boolean {
  if (!accelerator || typeof accelerator !== 'string') return false;
  return accelerator
    .split('+')
    .map(p => p.trim())
    .filter(Boolean)
    .some(isScreenReaderReservedKey);
}

export const SCREEN_READER_CONFLICT_MESSAGE =
  'Bu kısayol ekran okuyucular tarafından kullanılıyor. '
  + 'Insert veya Caps Lock tuşlarını içermeyen bir kombinasyon seçin.';

function isKeyToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (NAMED_KEY_TOKENS.has(lower)) return true;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return true; // F1-F24
  if (/^[0-9]$/.test(token)) return true;
  if (/^[a-z]$/i.test(token)) return true;
  return false;
}

// Requires at least one modifier plus exactly one trailing key token --
// deliberately stricter than every string Electron's accelerator parser
// would accept, since a global shortcut with no modifier (e.g. a bare
// letter) would hijack that key everywhere on the system.
export function isValidAccelerator(accelerator: string): boolean {
  if (!accelerator || typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  if (!isKeyToken(key)) return false;
  if (modifiers.length === 0) return false;
  if (conflictsWithScreenReader(accelerator)) return false;
  return modifiers.every(m => MODIFIER_TOKENS.has(m.toLowerCase()));
}

const MAC_SYMBOLS: Record<string, string> = {
  cmd: '⌘', command: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘',
  control: '⌃', ctrl: '⌃',
  alt: '⌥', option: '⌥', altgr: '⌥',
  shift: '⇧',
  super: '⌘', meta: '⌘'
};

// Turns the stored Electron accelerator into the label the user sees, e.g.
// 'Alt+Space' -> '⌥ Space' on macOS. Non-Mac platforms keep the familiar
// 'Ctrl+Shift+M' plus-separated spelling.
export function formatAcceleratorForDisplay(accelerator: string, platform: NodeJS.Platform): string {
  if (!accelerator) return '';
  const parts = accelerator.split('+').map(p => p.trim()).filter(Boolean);
  if (platform !== 'darwin') {
    return parts.join('+');
  }
  return parts.map(part => MAC_SYMBOLS[part.toLowerCase()] ?? part).join(' ');
}
