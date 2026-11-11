import { AppDatabase, normalizeForSearch } from '../db/database.js';
import { isPathExcluded, isPathOrSubpath } from '../scanner/scanner.js';

export interface SearchResult {
  id: number;
  filename: string;
  path: string;
  extension: string;
  mtime: number;
  snippet: string;
  snippets: string[];
  matchCount: number;
  index_status: string;
}

export type SearchSort = 'modified' | 'oldest' | 'relevance';

export interface SearchScopeOptions {
  mode?: 'all' | 'selected';
  includedPaths?: string[];
  excludedPaths?: string[];
}

export function isDocumentInScope(
  docPath: string,
  mode: 'all' | 'selected',
  includedPaths: string[],
  excludedPaths: string[]
): boolean {
  // Exclude rule is ALWAYS stronger than include rule
  if (excludedPaths.length > 0 && isPathExcluded(docPath, excludedPaths)) {
    return false;
  }

  if (mode === 'selected') {
    if (includedPaths.length === 0) {
      return false;
    }
    return includedPaths.some(folder => isPathOrSubpath(folder, docPath));
  }

  return true;
}

// Typographic double quotes are what macOS smart quotes, Word, UDF and most
// legal text produce. Left as they were, “ortaklığın giderilmesi” was not
// recognised as an exact-mode query, and the “ and ” characters went into the
// FTS phrase itself -- which can never match: zero results for a phrase
// present in 22 of the user's documents (reproduced on the real index). Only
// DOUBLE quotes are mapped: single quotes and apostrophes are part of Turkish
// words ("Yargıtay’ın") and keep their existing behaviour.
const TYPOGRAPHIC_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g;

export function normalizeQueryQuotes(userQuery: string): string {
  return (userQuery || '').replace(TYPOGRAPHIC_DOUBLE_QUOTES, '"');
}

export function buildFtsQuery(userQuery: string): string | null {
  if (!userQuery || !userQuery.trim()) {
    return null;
  }

  const normalized = normalizeForSearch(normalizeQueryQuotes(userQuery));
  // Remove quote and control characters, normalize multiple spaces
  const clean = normalized.replace(/[\"']/g, ' ').replace(/\s+/g, ' ').trim();

  // Trigram index requires at least 3 characters for infix matching
  if (clean.length < 3) {
    return null;
  }

  // Exact phrase / contiguous substring match in trigram index
  return `"${clean}"`;
}

// A query is EXACT MODE only when the entire trimmed input is wrapped in a
// single pair of double quotes (spec §8) -- e.g. foo "bar baz" qux is NOT
// exact mode in this version, by design.
export function isExactPhraseQuery(userQuery: string): boolean {
  const trimmed = normalizeQueryQuotes(userQuery).trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

export function extractExactPhrase(userQuery: string): string {
  const trimmed = normalizeQueryQuotes(userQuery).trim();
  if (!isExactPhraseQuery(trimmed)) return trimmed;
  return trimmed.slice(1, -1).trim();
}

interface MatchOccurrence {
  start: number;
  end: number;
}

// Unicode-aware "is this a word character" check -- deliberately not
// JavaScript's ASCII-only \b, so Turkish letters (ç, ğ, ı, ö, ş, ü, and
// their dotted/dotless I/İ forms once lowercased) count as word characters
// for boundary purposes.
const WORD_CHAR = /[\p{L}\p{N}]/u;

// Finds every occurrence of `cleanQuery` inside `cleanContent` (both already
// NFC-normalized and whitespace-collapsed by the caller). In exact mode, an
// occurrence only counts if neither the character immediately before nor
// immediately after it is a word character (or the string edge) -- so
// "zilyet" matches inside "zilyet oldu" but not inside "zilyetlik".
function findMatchOccurrences(
  cleanContent: string,
  cleanQuery: string,
  exact: boolean,
  maxOccurrences: number = 50
): MatchOccurrence[] {
  if (!cleanQuery) return [];

  const lowerContent = cleanContent.toLocaleLowerCase('tr-TR');
  const lowerQuery = cleanQuery.toLocaleLowerCase('tr-TR');
  if (!lowerQuery) return [];

  const occurrences: MatchOccurrence[] = [];
  let fromIndex = 0;

  while (occurrences.length < maxOccurrences) {
    const idx = lowerContent.indexOf(lowerQuery, fromIndex);
    if (idx === -1) break;

    const end = idx + lowerQuery.length;
    const boundaryOk = !exact || (
      (idx === 0 || !WORD_CHAR.test(lowerContent[idx - 1])) &&
      (end >= lowerContent.length || !WORD_CHAR.test(lowerContent[end]))
    );

    if (boundaryOk) {
      occurrences.push({ start: idx, end });
    }
    fromIndex = idx + 1;
  }

  return occurrences;
}

// Used to decide whether a document belongs in exact-mode results at all
// (a trigram substring hit alone isn't enough -- "zilyetlik" contains
// "zilyet" as a substring but must NOT match an exact search for "zilyet").
export function hasExactWordMatch(content: string, phrase: string): boolean {
  if (!content || !phrase) return false;
  const cleanContent = content.normalize('NFC').replace(/[\r\n\t\s]+/g, ' ').trim();
  const cleanQuery = phrase.normalize('NFC').replace(/[\r\n\t\s]+/g, ' ').trim();
  return findMatchOccurrences(cleanContent, cleanQuery, true, 1).length > 0;
}

export interface SnippetOptions {
  exact?: boolean;
  maxSnippets?: number;
  budget?: number;
}

export interface SnippetResult {
  snippets: string[];
  // Total distinct boundary/substring-valid occurrences found (capped at the
  // internal scan limit), independent of how many snippets were actually
  // rendered -- lets the UI show "+N eşleşme" beyond the displayed ones.
  matchCount: number;
}

// Multi-passage version of generateCustomSnippet: returns up to
// `maxSnippets` distinct, non-overlapping highlighted passages instead of
// just the first match (spec §9 -- "hemşire" and "hemşirelik" both
// highlighted under the same document card rather than a duplicate card).
export function generateSnippets(content: string, userQuery: string, options: SnippetOptions = {}): SnippetResult {
  const { exact = false, maxSnippets = 3, budget = 180 } = options;
  if (!content || !content.trim()) return { snippets: [], matchCount: 0 };

  const cleanContent = content.normalize('NFC').replace(/[\r\n\t\s]+/g, ' ').trim();
  const cleanQuery = userQuery ? userQuery.normalize('NFC').replace(/[\r\n\t\s]+/g, ' ').trim() : '';

  if (!cleanQuery) {
    const single = cleanContent.length > budget ? cleanContent.substring(0, budget) + '…' : cleanContent;
    return { snippets: [single], matchCount: 0 };
  }

  const occurrences = findMatchOccurrences(cleanContent, cleanQuery, exact);

  if (occurrences.length === 0) {
    if (cleanContent.length <= budget) {
      return { snippets: [cleanContent], matchCount: 0 };
    }
    const endSpace = cleanContent.lastIndexOf(' ', budget);
    const end = endSpace > 0 ? endSpace : budget;
    return { snippets: [cleanContent.substring(0, end) + '…'], matchCount: 0 };
  }

  const snippets: string[] = [];
  const usedRanges: MatchOccurrence[] = [];

  for (const occ of occurrences) {
    if (snippets.length >= maxSnippets) break;

    const remainingBudget = Math.max(0, budget - (occ.end - occ.start));
    const leftBudget = Math.floor(remainingBudget * 0.45);
    const rightBudget = remainingBudget - leftBudget;

    let rawStart = Math.max(0, occ.start - leftBudget);
    let rawEnd = Math.min(cleanContent.length, occ.end + rightBudget);

    if (occ.start - leftBudget < 0) {
      rawEnd = Math.min(cleanContent.length, rawEnd + (leftBudget - occ.start));
    } else if (occ.end + rightBudget > cleanContent.length) {
      rawStart = Math.max(0, rawStart - (occ.end + rightBudget - cleanContent.length));
    }

    let start = rawStart;
    if (start > 0) {
      const spaceAfter = cleanContent.indexOf(' ', start);
      if (spaceAfter !== -1 && spaceAfter < occ.start) start = spaceAfter + 1;
    }

    let end = rawEnd;
    if (end < cleanContent.length) {
      const spaceBefore = cleanContent.lastIndexOf(' ', end);
      if (spaceBefore !== -1 && spaceBefore > occ.end) end = spaceBefore;
    }

    // Skip near-duplicate passages whose window overlaps one already kept
    // (e.g. two occurrences a few words apart landing in the same window).
    const overlapsExisting = usedRanges.some(r => start < r.end && end > r.start);
    if (overlapsExisting) continue;
    usedRanges.push({ start, end });

    const leftPart = cleanContent.substring(start, occ.start);
    const rightPart = cleanContent.substring(occ.end, end);
    const matchedText = cleanContent.substring(occ.start, occ.end);
    const hasLeftEllipsis = start > 0;
    const hasRightEllipsis = end < cleanContent.length;

    snippets.push(`${hasLeftEllipsis ? '…' : ''}${leftPart}<mark>${matchedText}</mark>${rightPart}${hasRightEllipsis ? '…' : ''}`);
  }

  return { snippets, matchCount: occurrences.length };
}

export function generateCustomSnippet(
  content: string,
  userQuery: string,
  budget: number = 180
): string {
  if (!content || !content.trim()) {
    return '';
  }

  // 1. Normalize to NFC and collapse multiple whitespaces, tabs, and newlines into single spaces
  const cleanContent = content.normalize('NFC').replace(/[\r\n\t\s]+/g, ' ').trim();
  const cleanQuery = userQuery ? userQuery.normalize('NFC').trim() : '';

  if (!cleanQuery) {
    return cleanContent.length > budget
      ? cleanContent.substring(0, budget) + '…'
      : cleanContent;
  }

  // 2. Case-insensitive search using Turkish locale
  const lowerContentTr = cleanContent.toLocaleLowerCase('tr-TR');
  const lowerQueryTr = cleanQuery.toLocaleLowerCase('tr-TR');

  let matchIndex = lowerContentTr.indexOf(lowerQueryTr);
  let matchLength = cleanQuery.length;

  if (matchIndex === -1) {
    // Fallback to standard lowercase
    const lowerContentStd = cleanContent.toLowerCase();
    const lowerQueryStd = cleanQuery.toLowerCase();
    matchIndex = lowerContentStd.indexOf(lowerQueryStd);
  }

  // If still not found (e.g. symbol mismatch), fallback gracefully to beginning of text
  if (matchIndex === -1) {
    if (cleanContent.length <= budget) {
      return cleanContent;
    }
    const endSpace = cleanContent.lastIndexOf(' ', budget);
    const end = endSpace > 0 ? endSpace : budget;
    return cleanContent.substring(0, end) + '…';
  }

  const matchStart = matchIndex;
  const matchEnd = matchIndex + matchLength;
  const matchedText = cleanContent.substring(matchStart, matchEnd);

  // 3. Allocate left (~45%) and right (~55%) character budget around match
  const remainingBudget = Math.max(0, budget - matchLength);
  const leftBudget = Math.floor(remainingBudget * 0.45);
  const rightBudget = remainingBudget - leftBudget;

  let rawStart = Math.max(0, matchStart - leftBudget);
  let rawEnd = Math.min(cleanContent.length, matchEnd + rightBudget);

  // Rebalance budget if one side hits text boundary
  if (matchStart - leftBudget < 0) {
    const extra = leftBudget - matchStart;
    rawEnd = Math.min(cleanContent.length, rawEnd + extra);
  } else if (matchEnd + rightBudget > cleanContent.length) {
    const extra = matchEnd + rightBudget - cleanContent.length;
    rawStart = Math.max(0, rawStart - extra);
  }

  // 4. Snap to whole word boundaries
  let start = rawStart;
  if (start > 0) {
    const spaceAfter = cleanContent.indexOf(' ', start);
    if (spaceAfter !== -1 && spaceAfter < matchStart) {
      start = spaceAfter + 1;
    }
  }

  let end = rawEnd;
  if (end < cleanContent.length) {
    const spaceBefore = cleanContent.lastIndexOf(' ', end);
    if (spaceBefore !== -1 && spaceBefore > matchEnd) {
      end = spaceBefore;
    }
  }

  const leftPart = cleanContent.substring(start, matchStart);
  const rightPart = cleanContent.substring(matchEnd, end);
  const hasLeftEllipsis = start > 0;
  const hasRightEllipsis = end < cleanContent.length;

  return `${hasLeftEllipsis ? '…' : ''}${leftPart}<mark>${matchedText}</mark>${rightPart}${hasRightEllipsis ? '…' : ''}`;
}

export function search(
  query: string,
  appDb: AppDatabase,
  limit: number = 100,
  scopeOrExcluded?: SearchScopeOptions | string[],
  sort: SearchSort = 'modified',
  shouldStop?: () => boolean
): SearchResult[] {
  if (!query || !query.trim()) {
    return [];
  }
  query = normalizeQueryQuotes(query);

  // A query wrapped entirely in double quotes is EXACT MODE (spec §8): the
  // underlying FTS query stays the same trigram substring match (that's what
  // makes infix search work at all), but each candidate row additionally
  // needs a Unicode word-boundary check below before it counts as a real hit.
  const exactMode = isExactPhraseQuery(query);
  const exactPhrase = exactMode ? extractExactPhrase(query) : '';

  const ftsQuery = buildFtsQuery(exactMode ? exactPhrase : query);
  if (!ftsQuery) {
    return [];
  }

  let mode: 'all' | 'selected' = appDb.getSearchScopeMode();
  let includedPaths: string[] = appDb.getIncludedFolders();
  let excludedPaths: string[] = appDb.getExcludedFolders();

  if (Array.isArray(scopeOrExcluded)) {
    excludedPaths = scopeOrExcluded;
  } else if (scopeOrExcluded && typeof scopeOrExcluded === 'object') {
    if (scopeOrExcluded.mode !== undefined) mode = scopeOrExcluded.mode;
    if (scopeOrExcluded.includedPaths !== undefined) includedPaths = scopeOrExcluded.includedPaths;
    if (scopeOrExcluded.excludedPaths !== undefined) excludedPaths = scopeOrExcluded.excludedPaths;
  }

  // Fast path: if in selected mode and no included folders, return 0 results
  if (mode === 'selected' && includedPaths.length === 0) {
    return [];
  }

  // Sort is a fixed 3-way whitelist (never raw user input) before it reaches
  // the SQL string, so this interpolation carries no injection risk.
  const orderBy = sort === 'relevance'
    ? 'rank'
    : sort === 'oldest'
      ? 'd.mtime ASC, d.id ASC'
      : 'd.mtime DESC, d.id ASC';

  // No catch here. A database or FTS failure used to be swallowed into `[]`,
  // which the UI could only present as "Sonuç bulunamadı" -- a failure shown
  // as an answer. It now reaches the caller; runSearch() (search-outcome.ts)
  // turns it into an explicit 'search_error'.
  //
  // A document's text is deliberately not read here. Selecting it made SQLite
  // load and sort the full text of every match just to throw most of it away,
  // so a common word over a large index took seconds. These columns sit before
  // the text in the row, so reading them does not touch it.
  const sql = `
    SELECT
      d.id,
      d.path,
      d.filename,
      d.extension,
      d.mtime
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
    ORDER BY ${orderBy}
    LIMIT ?
  `;

  // Fetch candidate rows up to 1000 and filter by active scope
  const fetchLimit = 1000;
  const rows = appDb.db.prepare(sql).all(ftsQuery, fetchLimit) as {
    id: number;
    path: string;
    filename: string;
    extension: string;
    mtime: number;
  }[];
  const readText = appDb.db.prepare('SELECT content, index_status FROM documents WHERE id = ?');

  const results: SearchResult[] = [];
  for (const r of rows) {
    if (shouldStop?.()) {
      break;
    }
    if (!isDocumentInScope(r.path, mode, includedPaths, excludedPaths)) {
      continue;
    }
    // The indexer works on its own connection: a document can be gone by now.
    const text = readText.get(r.id) as { content: string; index_status: string } | undefined;
    if (!text) {
      continue;
    }
    if (exactMode && !hasExactWordMatch(text.content, exactPhrase)) {
      continue;
    }

    const { snippets, matchCount } = generateSnippets(text.content, exactMode ? exactPhrase : query, {
      exact: exactMode,
      maxSnippets: 3
    });
    const finalSnippets = snippets.length > 0 ? snippets : [r.filename];

    results.push({
      id: r.id,
      filename: r.filename,
      path: r.path,
      extension: r.extension,
      mtime: r.mtime,
      snippet: finalSnippets[0],
      snippets: finalSnippets,
      matchCount,
      index_status: text.index_status
    });
    if (results.length >= limit) {
      break;
    }
  }

  return results;
}
