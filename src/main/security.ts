// Rules the main process applies to whatever reaches it from a renderer.
//
// The renderers only ever show MetinBul's own pages, run sandboxed and escape
// every document name, path and passage they display. These checks are the
// layer behind that: should a page ever run code it did not ship with, it
// still cannot open an arbitrary file or program, send the user to an
// arbitrary site or slip malformed values into the settings.
//
// Everything here is pure (no Electron import) so the tests can drive it.
import * as path from 'path';
import { fileURLToPath } from 'url';

// The pages MetinBul loads, relative to its renderer directory.
export const TRUSTED_PAGES = ['index.html', 'quick-search.html', 'settings.html'] as const;

// Longest string accepted for a file or folder path, a search query, and text
// sent to the clipboard. Real values are far shorter; the caps only stop a
// misbehaving page from pushing megabytes through a channel.
export const MAX_PATH_LENGTH = 32_767; // Windows' extended-length limit
export const MAX_QUERY_LENGTH = 1_000;
export const MAX_CLIPBOARD_LENGTH = 64 * 1024;

// The only sites MetinBul sends the user to: its own releases page, where
// both the update notice and "Sürümler" point.
const RELEASES_URL_PREFIX = '/raciyuksekbas-hub/metinbul-releases';

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether a frame URL is one of MetinBul's own pages: a file: URL that names
 * one of TRUSTED_PAGES directly inside the renderer directory. The query
 * string (the Settings window's ?section=) is ignored.
 */
export function isTrustedRendererUrl(
  frameUrl: string,
  rendererDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  let url: URL;
  try {
    // Electron's loadFile leaves a '%' in a folder name as it is (C:\Users\a%b),
    // which is not valid percent-encoding; read it as the literal it is.
    url = new URL(frameUrl.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return false;
  }
  if (url.protocol !== 'file:') return false;
  // A host only makes sense for a Windows network path (\\server\share\...).
  if (url.host !== '' && url.host !== 'localhost' && platform !== 'win32') return false;
  let filePath: string;
  try {
    filePath = fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return false;
  }
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const dir = pathApi.dirname(pathApi.normalize(filePath));
  const page = pathApi.basename(filePath);
  return samePath(dir, pathApi.normalize(rendererDir), platform)
    && TRUSTED_PAGES.some(trusted => samePath(page, trusted, platform));
}

/**
 * The URLs "Sürümler", the update notice and "Geri Bildirim Gönder" may hand
 * to the operating system: MetinBul's GitHub releases over https, and a mail
 * to the feedback address. Anything else -- another site, http, file:,
 * javascript:, a custom protocol that would start some other program -- is
 * refused.
 */
export function isAllowedExternalUrl(value: unknown, feedbackEmail: string): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && (url.pathname === RELEASES_URL_PREFIX || url.pathname.startsWith(`${RELEASES_URL_PREFIX}/`));
  }
  if (url.protocol === 'mailto:') {
    let address: string;
    try {
      address = decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      return false;
    }
    if (address !== feedbackEmail.toLowerCase()) return false;
    // A subject and a body, as "Geri Bildirim Gönder" writes them; no extra
    // recipients (cc, bcc, to) slipped in.
    return [...url.searchParams.keys()].every(key => key === 'subject' || key === 'body');
  }
  return false;
}

/** A string no longer than `max`; anything else is rejected. */
export function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/**
 * An absolute path in a form the rest of MetinBul can store and compare:
 * no NUL byte (which would cut the path short in native calls), not
 * relative, not overlong.
 */
export function absolutePath(value: unknown, platform: NodeJS.Platform = process.platform): string | null {
  const text = boundedString(value, MAX_PATH_LENGTH);
  if (!text || text.includes('\0')) return null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.isAbsolute(text) ? text : null;
}

export type SearchAreaType = 'include' | 'exclude';

export function isSearchAreaType(value: unknown): value is SearchAreaType {
  return value === 'include' || value === 'exclude';
}

export function isSearchScopeMode(value: unknown): value is 'all' | 'selected' {
  return value === 'all' || value === 'selected';
}

// The document types MetinBul indexes, and so the only ones it opens.
const OPENABLE_EXTENSIONS = new Set(['.doc', '.docx', '.pdf', '.udf']);

/** Whether a file name ends in one of the document types MetinBul opens. */
export function hasOpenableExtension(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return OPENABLE_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase());
}

/**
 * Whether a renderer may ask for this file to be opened or shown: it has to
 * be a document MetinBul indexed, of a type it indexes. Opening is what
 * shell.openPath does with a double-click, so an executable, a script or an
 * application bundle would run -- none of those is ever in the index.
 */
export function isOpenableDocument(
  value: unknown,
  isIndexed: (documentPath: string) => boolean,
  platform: NodeJS.Platform = process.platform
): value is string {
  const filePath = absolutePath(value, platform);
  if (!filePath) return false;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!OPENABLE_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase())) return false;
  return isIndexed(filePath);
}

// Command-line switches that would let another program on the computer drive
// or debug MetinBul: a DevTools endpoint into its pages, a Node.js debugger,
// or a wrapper around its helper processes. Refused at start in packaged macOS
// builds, where MetinBul holds the user's folder permissions (the Electron
// fuses in scripts/electron-fuses.cjs cover ELECTRON_RUN_AS_NODE, NODE_OPTIONS
// and --inspect; these are Chromium's).
export const FORBIDDEN_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'debug',
  'debug-brk',
  'js-flags',
  'gpu-launcher',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'gpu-cmd-prefix',
  'browser-subprocess-path',
  'load-extension'
] as const;

/** The first forbidden switch among the arguments, if any. */
export function findForbiddenSwitch(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const match = /^--?([A-Za-z0-9-]+)(?:=|$)/.exec(arg);
    if (match && (FORBIDDEN_SWITCHES as readonly string[]).includes(match[1].toLowerCase())) return match[1];
  }
  return null;
}
