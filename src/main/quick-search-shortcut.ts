// Pure, Electron-free helpers for the global Quick Search shortcut, kept
// separate from main.ts so they're unit-testable without a running Electron
// process (globalShortcut.register itself can only be exercised by the
// packaged-app smoke pass).

// Explicitly NOT Cmd+M (macOS system Minimize) and NOT Alt+Space on Windows
// (system window menu) -- per the real user feedback this feature is a
// response to. Nor Ctrl+Shift+M on Windows, the default until 0.4.4: a
// colleague's review of 0.4.3 found it taking over Outlook's new message,
// Teams' microphone mute, Word's outdent and Chrome's profile menu
// everywhere, all day -- a lawyer could not mute themselves in a Teams
// hearing. Ctrl+Alt+Space is not a shortcut of Office, Teams, Chrome, Edge
// or Windows that we know of, and AltGr+Space (AltGr is Ctrl+Alt on Windows)
// is not a character of the Turkish Q and F layouts. To be tried on a real
// office Windows before release. Users who picked a shortcut keep it.
export function getDefaultAccelerator(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Alt+Space' : 'Ctrl+Alt+Space';
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

// The modifier a shortcut must have besides Shift: Shift and a key is just
// typing (Shift+K is a capital K) or another program's own shortcut.
type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';

function canonicalModifier(token: string, platform: NodeJS.Platform): Modifier | null {
  switch (token.toLowerCase()) {
    case 'ctrl': case 'control': return 'ctrl';
    case 'alt': case 'option': case 'altgr': return 'alt';
    case 'shift': return 'shift';
    case 'cmd': case 'command': case 'super': case 'meta': return 'meta';
    case 'cmdorctrl': case 'commandorcontrol': return platform === 'darwin' ? 'meta' : 'ctrl';
    default: return null;
  }
}

// What everyone presses every day, and what the system keeps for itself.
// Written as sorted modifiers and the key, lowercase.
const EVERYDAY_LETTERS = ['a', 'c', 'f', 'n', 'o', 'p', 'q', 's', 't', 'v', 'w', 'x', 'y', 'z'];
const RESERVED: Record<'darwin' | 'other', Set<string>> = {
  darwin: new Set([
    ...EVERYDAY_LETTERS.map(k => `meta+${k}`), 'meta+h', 'meta+m', 'meta+tab', 'meta+space',
    'ctrl+space', 'ctrl+meta+space', 'alt+meta+escape', 'ctrl+meta+q', 'meta+shift+3', 'meta+shift+4', 'meta+shift+5'
  ]),
  other: new Set([
    ...EVERYDAY_LETTERS.map(k => `ctrl+${k}`), 'ctrl+h', 'ctrl+r', 'ctrl+tab', 'ctrl+escape',
    'ctrl+shift+escape', 'alt+ctrl+delete', 'alt+f4', 'alt+tab', 'alt+escape', 'alt+space', 'ctrl+space'
  ])
};

/**
 * True for a shortcut MetinBul must not take away from everything else:
 * Ctrl+C/V/X/Z/S…, Alt+F4, Alt+Tab, the system's own; on Windows also any
 * Windows-key shortcut without Ctrl or Alt (Windows keeps nearly all of them).
 */
export function isReservedAccelerator(accelerator: string, platform: NodeJS.Platform = process.platform): boolean {
  const parts = accelerator.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1].toLowerCase();
  const modifiers = [...new Set(parts.slice(0, -1).map(m => canonicalModifier(m, platform)))].sort();
  if (modifiers.includes(null)) return false;
  if (platform !== 'darwin' && modifiers.includes('meta') && !modifiers.includes('ctrl') && !modifiers.includes('alt')) return true;
  return RESERVED[platform === 'darwin' ? 'darwin' : 'other'].has([...modifiers, key].join('+'));
}

export const RESERVED_SHORTCUT_MESSAGE =
  'Bu kısayolu sistem ya da sık kullanılan programlar kullanıyor; MetinBul onu her yerde ele geçirirdi. '
  + 'Ctrl veya Alt içeren başka bir kombinasyon seçin.';

// Requires at least one modifier other than Shift plus exactly one trailing
// key token -- deliberately stricter than every string Electron's
// accelerator parser would accept, since a global shortcut with no modifier
// (e.g. a bare letter) would hijack that key everywhere on the system -- and
// none of the shortcuts everyone relies on (isReservedAccelerator).
export function isValidAccelerator(accelerator: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!accelerator || typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  if (!isKeyToken(key)) return false;
  if (modifiers.length === 0) return false;
  if (conflictsWithScreenReader(accelerator)) return false;
  if (!modifiers.every(m => MODIFIER_TOKENS.has(m.toLowerCase()))) return false;
  if (!modifiers.some(m => canonicalModifier(m, platform) !== 'shift')) return false;
  return !isReservedAccelerator(accelerator, platform);
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
