// Pure presentation helpers for the Quick Search panel and the Settings
// window. No DOM, no Electron, no search engine: the strings and numbers the
// two surfaces show are decided here so they can be unit tested directly and
// so both surfaces phrase the same fact the same way.

import { formatCount } from './a11y-text.js';

// --- Result location ------------------------------------------------------

// The leading part of a path that says nothing about *where in the user's
// own files* a document lives: the drive, the home directory, the mount
// point. Dropping it is what turns
// "/Users/raci/Documents/Müvekkiller/2026/Dava" into "Müvekkiller / 2026 / Dava".
const HOME_ROOTS = new Set(['users', 'home']);

function stripUninformativePrefix(segments: string[]): string[] {
  let rest = segments;
  if (rest.length > 0 && /^[a-z]:$/i.test(rest[0])) rest = rest.slice(1);
  if (rest.length >= 2 && HOME_ROOTS.has(rest[0].toLowerCase())) rest = rest.slice(2);
  else if (rest.length >= 1 && rest[0] === 'Volumes') rest = rest.slice(1);
  return rest;
}

/**
 * The folder a result lives in, as shown under the snippet: the containing
 * directories after the home/drive prefix, at most `maxSegments` of them,
 * joined with " / ". Longer paths keep their deepest folders and lead with
 * "… / ", because the nearest folder is the one that tells documents apart.
 */
export function formatFolderLocation(filePath: string, maxSegments = 3): string {
  if (!filePath) return '';
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  segments.pop(); // the file itself
  const folders = stripUninformativePrefix(segments);
  if (folders.length === 0) return 'Ana klasör';
  if (folders.length <= maxSegments) return folders.join(' / ');
  return `… / ${folders.slice(-maxSegments).join(' / ')}`;
}

// --- Queries the index cannot answer -----------------------------------------

// Mirrors buildFtsQuery (search.ts): the trigram index cannot match fewer than
// three characters, so such a query is never searched -- and must not be
// reported as "nothing found" either. (Not imported from search.ts: that
// module pulls the database layer, which has no place in a renderer bundle;
// a test pins the two rules together instead.)
export const MIN_QUERY_LENGTH = 3;

// Typographic double quotes count as quotes, as in normalizeQueryQuotes
// (search.ts).
export function isQueryTooShort(query: string): boolean {
  const clean = (query || '')
    .normalize('NFC')
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/["']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 0 && clean.length < MIN_QUERY_LENGTH;
}

export const QUERY_TOO_SHORT_MESSAGE = `Aramak için en az ${MIN_QUERY_LENGTH} karakter yazın.`;

// --- "Bulamadım" is not "okuyamadım" ---------------------------------------
//
// The no-results explanation used to be a single sum -- failed + text-less +
// cloud-only -- shown as "2.845 belge aranamadı". On the real profile 2,570 of
// those were cloud placeholders and only 16 had actually failed, so the line
// read as "nothing could be searched" while 1,791 documents had been. Each
// fact is now stated as itself.

export interface IndexCoverage {
  /** Documents whose text is in the index -- what a search actually covers. */
  indexed: number;
  /** Extraction failed (corrupt, encrypted, unsupported variant). */
  failed: number;
  /** Opened fine but contains no text layer (e.g. a scanned PDF). */
  noText: number;
  /** Cloud placeholder whose content is not on this device. */
  dataless: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Whether part of the document set could not be searched. */
export function isCoveragePartial(c: IndexCoverage): boolean {
  return nonNegative(c.failed) + nonNegative(c.noText) + nonNegative(c.dataless) > 0;
}

/**
 * "1.791 belge arandı · 16 belge işlenemedi · 259 belgede metin yok ·
 * 2.570 belge yalnızca bulutta". With `spoken`, commas and a full stop
 * instead of middle dots, for the live region.
 */
export function describeCoverage(c: IndexCoverage, options: { spoken?: boolean } = {}): string {
  const parts = [`${formatCount(nonNegative(c.indexed))} belge arandı`];
  if (nonNegative(c.failed) > 0) parts.push(`${formatCount(nonNegative(c.failed))} belge işlenemedi`);
  if (nonNegative(c.noText) > 0) parts.push(`${formatCount(nonNegative(c.noText))} belgede metin yok`);
  if (nonNegative(c.dataless) > 0) parts.push(`${formatCount(nonNegative(c.dataless))} belge yalnızca bulutta`);
  return options.spoken ? `${parts.join(', ')}.` : parts.join(' · ');
}

export const INDEX_UPDATING_NOTE = 'İndeks güncelleniyor — mevcut indeks üzerinde arama yapılıyor.';

// --- Index status (Settings › İndeks) --------------------------------------

const TR_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * "Bugün 14:32", "Dün 09:05", "12 Eylül 14:32", "12 Eylül 2025".
 * Local time throughout: this is a wall-clock answer to "when did MetinBul
 * last look at my files?".
 */
export function formatIndexTimestamp(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const then = new Date(timestamp);
  const today = new Date(now);
  const dayDiff = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000);

  if (dayDiff === 0) return `Bugün ${clock(then)}`;
  if (dayDiff === 1) return `Dün ${clock(then)}`;
  const dayMonth = `${then.getDate()} ${TR_MONTHS[then.getMonth()]}`;
  if (then.getFullYear() === today.getFullYear()) return `${dayMonth} ${clock(then)}`;
  return `${dayMonth} ${then.getFullYear()}`;
}

// --- Panel height ------------------------------------------------------------

export interface PanelHeightBounds {
  min: number;
  max: number;
}

/**
 * The window height the panel should take for a given content height.
 *
 * `allowShrink` is false for changes that only move the selection: the
 * selected row reveals extra passages, and letting the window follow that up
 * and down on every arrow press is exactly the jitter the panel must avoid.
 * Within one result set the window therefore only ever grows; it shrinks
 * again when the result set itself changes.
 */
export function nextPanelHeight(
  current: number,
  content: number,
  bounds: PanelHeightBounds,
  allowShrink: boolean
): number {
  const clamped = Math.round(Math.min(bounds.max, Math.max(bounds.min, content)));
  if (!allowShrink && clamped < current) return current;
  return clamped;
}
