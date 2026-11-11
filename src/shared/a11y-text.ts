// Turkish accessible-text helpers for MetinBul.
//
// This is a pure presentation-layer module: no DOM, no Electron, no search
// engine. It exists so the exact strings a screen reader speaks can be unit
// tested directly (spec §28, §30), and so every surface -- main window,
// Quick Search, live announcements -- phrases the same fact the same way.
//
// All output is Turkish. Sentences end with a full stop so VoiceOver,
// Narrator, NVDA and JAWS all insert a natural prosodic break instead of
// running fragments together.

export type AnnouncementPriority = 'polite' | 'assertive';

/** Formats a count with Turkish digit grouping (1.234 rather than 1,234). */
export function formatCount(value: number): string {
  return Number(value).toLocaleString('tr-TR');
}

// --- Search status ---------------------------------------------------------

export const SEARCH_STATUS_SEARCHING = 'Aranıyor.';
export const SEARCH_STATUS_NO_RESULTS = 'Sonuç bulunamadı.';
export const SEARCH_STATUS_FAILED = 'Arama tamamlanamadı.';

/**
 * The sentence announced when a search settles. Screen readers get a count
 * plus the noun, never a bare number.
 */
export function getAccessibleSearchStatus(resultCount: number): string {
  if (!Number.isFinite(resultCount) || resultCount <= 0) {
    return SEARCH_STATUS_NO_RESULTS;
  }
  return `${formatCount(resultCount)} sonuç bulundu.`;
}

// --- Match context ---------------------------------------------------------

/**
 * Strips the <mark> highlight wrapper from a snippet, leaving the plain
 * context sentence. The highlight is visual-only; the same information is
 * carried textually by `getAccessibleMatchContext` (spec §13), so the marked
 * term must not be spoken twice.
 */
export function stripHighlight(snippet: string): string {
  if (!snippet) return '';
  return snippet
    .replace(/<\/?mark>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls the highlighted term out of a snippet, if the snippet has one. */
export function extractHighlightedTerm(snippet: string): string {
  if (!snippet) return '';
  const match = /<mark>([\s\S]*?)<\/mark>/.exec(snippet);
  return match ? match[1].trim() : '';
}

export interface MatchContextInput {
  /** 1-based position of this match within the document. */
  index: number;
  /** Total matches in this document. */
  total: number;
  /** The term the user searched for. */
  query: string;
  /** Snippet text; may still contain <mark> wrappers. */
  snippet: string;
}

/**
 * "Eşleşme 2 / 4. Aranan ifade: tahliye. Bağlam: Davacının kiralanana olan
 * ihtiyacı gerçek, samimi ve zorunludur."
 *
 * The position clause is omitted when a document has a single match, so the
 * common case is not padded with "Eşleşme 1 / 1".
 */
export function getAccessibleMatchContext(input: MatchContextInput): string {
  const { index, total, query, snippet } = input;
  const parts: string[] = [];

  if (Number.isFinite(total) && total > 1) {
    parts.push(`Eşleşme ${index} / ${total}.`);
  }

  const term = (query || '').trim() || extractHighlightedTerm(snippet);
  if (term) {
    parts.push(`Aranan ifade: ${term}.`);
  }

  const context = stripHighlight(snippet).replace(/^…+|…+$/g, '').trim();
  if (context) {
    parts.push(`Bağlam: ${context}`);
  }

  return parts.join(' ').trim();
}

// --- Search results --------------------------------------------------------

export interface SearchResultInput {
  /** 1-based position in the result list. */
  index: number;
  /** Total results in the list. */
  total: number;
  filename: string;
  matchCount?: number;
  /** Containing folder, spoken only when supplied. */
  folder?: string;
}

/**
 * "Sonuç 1 / 12. Merve.udf. 4 eşleşme."
 *
 * This is the accessible NAME of a result row. The match context is exposed
 * separately as the row's description so a screen reader reading the list
 * quickly is not forced through every snippet.
 */
export function getAccessibleSearchResult(input: SearchResultInput): string {
  const { index, total, filename, matchCount, folder } = input;
  const parts: string[] = [`Sonuç ${index} / ${total}.`];

  if (filename) {
    parts.push(`${filename}.`);
  }

  if (typeof matchCount === 'number' && matchCount > 0) {
    parts.push(`${formatCount(matchCount)} eşleşme.`);
  }

  if (folder) {
    parts.push(`${folder} klasörü.`);
  }

  return parts.join(' ');
}

// --- Filter / scope state --------------------------------------------------

/**
 * "UDF, seçili." -- selection state must never be carried by colour alone
 * (spec §17, §20).
 */
export function getAccessibleFilterState(label: string, selected: boolean): string {
  return `${label}, ${selected ? 'seçili' : 'seçili değil'}.`;
}

export type SearchScopeMode = 'all' | 'selected';

export function getAccessibleScopeState(mode: SearchScopeMode, includeCount: number): string {
  if (mode === 'all') {
    return 'Arama kapsamı: bilgisayarın tümü.';
  }
  if (includeCount <= 0) {
    return 'Arama kapsamı: seçili klasörler. Henüz klasör eklenmedi.';
  }
  return `Arama kapsamı: seçili klasörler. ${formatCount(includeCount)} klasör.`;
}

// --- Indexing state --------------------------------------------------------

export function getAccessibleIndexingStatus(current: number, total: number): string {
  return `İndeksleniyor. ${formatCount(total)} belgeden ${formatCount(current)} tanesi tamamlandı.`;
}

export function getAccessibleDocumentCount(count: number): string {
  if (count <= 0) return 'Henüz belge indekslenmedi.';
  return `${formatCount(count)} belge indekslendi.`;
}

// --- Error states (spec §26) ----------------------------------------------

export const ERROR_MESSAGES = {
  indexUnavailable: 'İndeks henüz hazır değil.',
  directoryUnreadable: 'Belge dizini okunamadı.',
  fileMissing: 'Dosya artık mevcut değil.',
  searchFailed: SEARCH_STATUS_FAILED,
  indexingFailed: 'İndeksleme tamamlanamadı.'
} as const;
