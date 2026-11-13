// How much memory MetinBul may use while a document is being read.
//
// The indexer thread's V8 heap is capped (resourceLimits), but what a parser
// decompresses goes into ArrayBuffers outside that heap: a small PDF whose
// FlateDecode streams expand without end ("zip bomb") could fill the
// computer's memory before any heap limit noticed. The main process watches
// the whole process's resident memory while a document is read and stops the
// update above this limit; the document is then recorded as unreadable, as
// one that overruns its time limit is.

const GiB = 1024 * 1024 * 1024;

// Polled this often while a document is read. Decompression runs at a few
// hundred MB a second, so the limit is overshot by little before it is seen.
export const INDEXING_MEMORY_POLL_MS = 500;

/**
 * 40% of the computer's memory, kept between 1.5 and 3 GiB. The colleague's
 * review measured MetinBul at about 320 MB at its peak while indexing, so
 * this leaves real documents ample room and stops a runaway one well before
 * the rest of the computer starts swapping.
 */
export function indexingMemoryLimitBytes(totalMemoryBytes: number): number {
  return Math.min(3 * GiB, Math.max(1.5 * GiB, totalMemoryBytes * 0.4));
}

/**
 * The limit for this run. A smoke test can lower it (never raise it) through
 * METINBUL_TEST_INDEX_MEMORY_LIMIT_MB, to see the watch stop a real update
 * without a document big enough to reach the normal limit.
 */
export function effectiveIndexingMemoryLimitBytes(totalMemoryBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const limit = indexingMemoryLimitBytes(totalMemoryBytes);
  const requested = Number.parseInt(env.METINBUL_TEST_INDEX_MEMORY_LIMIT_MB ?? '', 10);
  if (!Number.isFinite(requested) || requested <= 0) return limit;
  return Math.min(limit, requested * 1024 * 1024);
}
