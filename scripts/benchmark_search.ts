import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { normalizeForSearch } from '../src/db/database.js';
import { generateCustomSnippet } from '../src/search/search.js';

export interface BenchmarkMetrics {
  corpusDocCount: number;
  extractedTextBytes: number;
  dbSizeBytes: number;
  indexingDurationMs: number;
  docsPerSecond: number;
  memoryRssMb: number;
  queryResults: {
    className: string;
    query: string;
    iterations: number;
    p50Ms: number;
    p95Ms: number;
    avgMs: number;
    matchCount: number;
  }[];
}

// Representative queries as defined in Section K
export const REPRESENTATIVE_QUERIES = [
  { className: 'A. Exact Phrase', query: 'ortaklığın giderilmesi' },
  { className: 'A. Exact Phrase', query: 'yargıtay hukuk genel kurulu' },
  { className: 'B. Normal Full Word', query: 'tazminat' },
  { className: 'B. Normal Full Word', query: 'mahkemesi' },
  { className: 'C. Infix', query: 'gıtay' },
  { className: 'C. Infix', query: 'leşme' },
  { className: 'D. Multi-Token / Prefix', query: 'ortaklı gider' },
  { className: 'D. Multi-Token / Prefix', query: 'tazminat dava' }
];

export function generateCorpus(count: number = 100): { filename: string; content: string }[] {
  const legalTemplates = [
    'Başvurucu tarafın belirtmiş olduğu aşağıdaki taşınmazlar hakkında ortaklığın giderilmesi talepli uyuşmazlık konusunda; karşı tarafların iletişim bilgileri başvurucudan ve bürodan istenmiş olup iletişime geçilmiştir.',
    'Yargıtay Hukuk Genel Kurulu kararı uyarınca işbu sözleşmenin haksız feshi nedeniyle açılan tazminat davasında davanın kısmen kabulüne karar verilmiştir.',
    'Ankara 4. Asliye Ticaret Mahkemesi nezdinde görülen alacak ve menfi tespit davasında bilirkişi raporu dosya arasına alınmış olup taraflara tebliğ edilmiştir.',
    'İş sözleşmesinin haklı nedenle feshedilmediği, kıdem ve ihbar tazminatı ile fazla mesai alacaklarının yasal faiziyle tahsiline hükmedilmiştir.',
    'İstanbul Bölge Adliye Mahkemesi ilgili Hukuk Dairesi tarafından verilen istinaf başvurusunun esastan reddi kararı onanmıştır.'
  ];

  const corpus: { filename: string; content: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const template = legalTemplates[i % legalTemplates.length];
    const repeated = Array(8).fill(template).join(' \n');
    corpus.push({
      filename: `belge_${i}.docx`,
      content: `[Belge No: ${i}] ${repeated}`
    });
  }
  return corpus;
}

export function runBenchmark(corpusSize: number = 100, iterationsPerQuery: number = 50): BenchmarkMetrics {
  const tempDbPath = path.join(os.tmpdir(), `metinbul_bench_${Date.now()}.db`);
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

  const db = new Database(tempDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Baseline Schema: FTS5 Trigram
  db.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      content TEXT NOT NULL,
      index_status TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE documents_fts USING fts5(
      filename,
      content,
      content='documents',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, filename, content)
      VALUES (new.id, new.filename, new.content);
    END;
  `);

  const corpus = generateCorpus(corpusSize);
  let totalTextBytes = 0;
  for (const doc of corpus) {
    totalTextBytes += Buffer.byteLength(doc.content, 'utf8');
  }

  // 1. Measure Indexing
  const insertStmt = db.prepare(`
    INSERT INTO documents (path, filename, extension, mtime, size, content, index_status, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((docs: typeof corpus) => {
    for (const d of docs) {
      insertStmt.run(`/virtual/path/${d.filename}`, d.filename, '.docx', Date.now(), d.content.length, d.content, 'indexed', Date.now());
    }
  });

  const indexStart = performance.now();
  insertMany(corpus);
  const indexDuration = performance.now() - indexStart;

  // DB Size on disk
  const dbStat = fs.statSync(tempDbPath);
  let totalDbSize = dbStat.size;
  const walPath = `${tempDbPath}-wal`;
  if (fs.existsSync(walPath)) {
    totalDbSize += fs.statSync(walPath).size;
  }

  // 2. Measure Search Latencies
  const searchStmt = db.prepare(`
    SELECT d.id, d.path, d.filename, d.content
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
    LIMIT 100
  `);

  const queryResults: BenchmarkMetrics['queryResults'] = [];

  for (const qObj of REPRESENTATIVE_QUERIES) {
    const norm = normalizeForSearch(qObj.query).replace(/[\"']/g, ' ').replace(/\s+/g, ' ').trim();
    const ftsQuery = norm.length >= 3 ? `"${norm}"` : null;

    const latencies: number[] = [];
    let matchCount = 0;

    for (let i = 0; i < iterationsPerQuery; i++) {
      const t0 = performance.now();
      if (ftsQuery) {
        const rows = searchStmt.all(ftsQuery) as { content: string }[];
        matchCount = rows.length;
        for (let r = 0; r < Math.min(rows.length, 10); r++) {
          generateCustomSnippet(rows[r].content, qObj.query);
        }
      }
      const t1 = performance.now();
      latencies.push(t1 - t0);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    queryResults.push({
      className: qObj.className,
      query: qObj.query,
      iterations: iterationsPerQuery,
      p50Ms: Number(p50.toFixed(3)),
      p95Ms: Number(p95.toFixed(3)),
      avgMs: Number(avg.toFixed(3)),
      matchCount
    });
  }

  db.close();
  if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

  const memRss = process.memoryUsage().rss / (1024 * 1024);

  return {
    corpusDocCount: corpusSize,
    extractedTextBytes: totalTextBytes,
    dbSizeBytes: totalDbSize,
    indexingDurationMs: Number(indexDuration.toFixed(2)),
    docsPerSecond: Number(((corpusSize / indexDuration) * 1000).toFixed(1)),
    memoryRssMb: Number(memRss.toFixed(1)),
    queryResults
  };
}

// Self-run when executed directly
console.log('=== MetinBul Search Benchmark Baseline (v0.3.0 Preparation) ===');
const res = runBenchmark(100, 50);
console.log(`Corpus Size: ${res.corpusDocCount} documents (${(res.extractedTextBytes / 1024).toFixed(1)} KB text)`);
console.log(`DB Disk Size: ${(res.dbSizeBytes / 1024).toFixed(1)} KB`);
console.log(`Indexing Time: ${res.indexingDurationMs} ms (${res.docsPerSecond} docs/sec)`);
console.log(`Process RSS: ${res.memoryRssMb} MB`);
console.log('\n--- Query Latency Results (50 runs per query) ---');
console.table(res.queryResults);
