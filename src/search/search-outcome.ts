// The answer to "what happened to this search?", not just "which documents".
//
// search() returns matches and, since the P0 fix, throws on a real failure.
// This wrapper is what the UI calls through IPC, and it keeps three outcomes
// apart that used to collapse into the same empty list:
//
//   no_matches       the index is ready and the phrase is not in it
//   index_not_ready  there is nothing readable to search yet
//   search_error     SQLite / FTS failed -- never presented as "no results"
//
// plus query_too_short (the trigram index cannot match < 3 characters, so
// the query was not searched at all), and superseded: the window typed on and
// asked for a newer search. Only a window that has moved on ever receives it,
// and it drops the answer by its own searchToken.
import { AppDatabase } from '../db/database.js';
import {
  search,
  buildFtsQuery,
  isExactPhraseQuery,
  extractExactPhrase,
  normalizeQueryQuotes,
  SearchResult,
  SearchSort
} from './search.js';

export type SearchState = 'success' | 'no_matches' | 'query_too_short' | 'index_not_ready' | 'search_error' | 'superseded';

export interface SearchOutcome {
  state: SearchState;
  results: SearchResult[];
  /** Technical reason for 'search_error' -- for the log and Settings, not the panel. */
  error?: string;
}

/** Whether the engine will actually run this query (mirrors search()). */
export function isSearchableQuery(query: string): boolean {
  const normalized = normalizeQueryQuotes(query);
  const exact = isExactPhraseQuery(normalized);
  return buildFtsQuery(exact ? extractExactPhrase(normalized) : normalized) !== null;
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    const parts = [code, message].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(': ');
  }
  return String(error);
}

export function runSearch(
  query: string,
  appDb: AppDatabase,
  options: { limit?: number; sort?: SearchSort; shouldStop?: () => boolean } = {}
): SearchOutcome {
  if (!isSearchableQuery(query)) {
    return { state: 'query_too_short', results: [] };
  }
  try {
    if (!appDb.hasIndexedDocuments()) {
      return { state: 'index_not_ready', results: [] };
    }
    const results = search(query, appDb, options.limit ?? 100, undefined, options.sort ?? 'modified', options.shouldStop);
    if (options.shouldStop?.()) {
      return { state: 'superseded', results: [] };
    }
    return { state: results.length > 0 ? 'success' : 'no_matches', results };
  } catch (error) {
    return { state: 'search_error', results: [], error: describeError(error) };
  }
}
