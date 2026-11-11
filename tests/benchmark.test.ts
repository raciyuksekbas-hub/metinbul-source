import { describe, it, expect } from 'vitest';
import { runBenchmark, REPRESENTATIVE_QUERIES } from '../scripts/benchmark_search.js';

describe('Search Quality Benchmark Harness (v0.3.0 Preparation)', () => {
  it('should run benchmark on synthetic corpus and collect all metrics cleanly', () => {
    const metrics = runBenchmark(20, 5);

    expect(metrics.corpusDocCount).toBe(20);
    expect(metrics.extractedTextBytes).toBeGreaterThan(0);
    expect(metrics.dbSizeBytes).toBeGreaterThan(0);
    expect(metrics.indexingDurationMs).toBeGreaterThan(0);
    expect(metrics.docsPerSecond).toBeGreaterThan(0);
    expect(metrics.memoryRssMb).toBeGreaterThan(0);
    expect(metrics.queryResults.length).toBe(REPRESENTATIVE_QUERIES.length);

    for (const qRes of metrics.queryResults) {
      expect(qRes.p50Ms).toBeGreaterThanOrEqual(0);
      expect(qRes.p95Ms).toBeGreaterThanOrEqual(0);
      expect(qRes.avgMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Large Corpus Stress (spec §11 -- 24k/44k field reports)', () => {
  // IMPORTANT: this harness inserts synthetic rows directly into a
  // schema-matching SQLite DB (see scripts/benchmark_search.ts) -- it
  // measures FTS5 write-throughput and query latency at scale, NOT the full
  // real-world pipeline (filesystem walk, dataless-flag checks, DOC/DOCX/PDF
  // text extraction). Those stages have their own coverage elsewhere
  // (tests/scanner, tests/extractors, tests/background_indexing.test.ts).
  // These numbers are a synthetic ceiling for the DB layer, not a production
  // time-to-index guarantee.
  it('handles a 24,000-document synthetic corpus (field report scale) without degrading query latency', () => {
    const metrics = runBenchmark(24000, 3);

    expect(metrics.corpusDocCount).toBe(24000);
    expect(metrics.indexingDurationMs).toBeGreaterThan(0);
    expect(metrics.memoryRssMb).toBeGreaterThan(0);

    for (const qRes of metrics.queryResults) {
      // Generous ceiling -- real-machine numbers observed well under 2ms;
      // this guards against a gross regression, not a strict SLA.
      expect(qRes.p95Ms).toBeLessThan(200);
    }
  }, 30000);

  it('handles a 44,000-document synthetic corpus (field report scale) without degrading query latency', () => {
    const metrics = runBenchmark(44000, 3);

    expect(metrics.corpusDocCount).toBe(44000);
    expect(metrics.indexingDurationMs).toBeGreaterThan(0);
    expect(metrics.memoryRssMb).toBeGreaterThan(0);

    for (const qRes of metrics.queryResults) {
      expect(qRes.p95Ms).toBeLessThan(200);
    }
  }, 30000);
});
