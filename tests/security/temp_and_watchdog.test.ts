// Temporary OCR files (they hold a document's path and recognised text) and
// the indexing watchdog (a document whose parser never returns must not stop
// indexing for good).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/extractors/udf.js', () => ({
  extractUdf: async (filePath: string) => fs.readFileSync(filePath, 'utf8')
}));

import { makePrivateTempDir, removePrivateTempDir, removeStalePrivateTempFiles } from '../../src/shared/private-temp.js';
import { AppDatabase } from '../../src/db/database.js';
import { DOCUMENT_READ_LIMIT_MS, documentReadLimitMs, indexFolders } from '../../src/search/indexer.js';
import { ocrTimeoutMs } from '../../src/ocr/ocr.js';
import { effectiveIndexingMemoryLimitBytes, indexingMemoryLimitBytes } from '../../src/main/index-memory.js';
import { setupFixtures, FIXTURES_DIR } from '../fixtures/create_fixtures.js';

const isWindows = process.platform === 'win32';
const ROOT = path.resolve(__dirname, '../..');
let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbtest-')));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('temporary files of text recognition', () => {
  it('each job gets a randomly named folder of its own, private to the user', () => {
    const a = makePrivateTempDir('ocr', base);
    const b = makePrivateTempDir('ocr', base);
    expect(a).not.toBe(b);
    expect(path.basename(a)).toMatch(/^metinbul-ocr-[A-Za-z0-9]{6}$/);
    if (!isWindows) expect(fs.statSync(a).mode & 0o777).toBe(0o700);
    fs.writeFileSync(path.join(a, 'out.txt'), 'tanınan metin');
    removePrivateTempDir(a);
    expect(fs.existsSync(a)).toBe(false);
  });

  it('leftovers of an interrupted run are removed at the next launch, and nothing else', () => {
    const now = Date.now();
    const old = (p: string) => {
      const t = new Date(now - 2 * 60 * 60 * 1000);
      fs.utimesSync(p, t, t);
      return p;
    };
    const staleJob = old(makePrivateTempDir('ocr', base));
    const runningJob = makePrivateTempDir('attrs', base);
    const legacyFiles = ['metinbul-ocr-123-0.json', 'metinbul-ocr-123-0.txt', 'metinbul-attrs-45-7.txt'].map(name => {
      const p = path.join(base, name);
      fs.writeFileSync(p, 'belge yolu ve metni');
      return old(p);
    });
    const unrelated = path.join(base, 'metinbul-notlar.txt');
    fs.writeFileSync(unrelated, 'kullanıcının dosyası');
    old(unrelated);
    const target = path.join(base, 'hedef');
    fs.mkdirSync(target);
    const link = path.join(base, 'metinbul-ocr-AbC123');
    if (!isWindows) fs.symlinkSync(target, link);

    const removed = removeStalePrivateTempFiles(60 * 60 * 1000, now, base);

    expect(removed).toBe(1 + legacyFiles.length);
    expect(fs.existsSync(staleJob)).toBe(false);
    for (const file of legacyFiles) expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(runningJob)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('the Windows OCR and attribute reader write only into such folders', () => {
    for (const file of ['src/ocr/windows-ocr.ts', 'src/scanner/windows-availability.ts']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/os\.tmpdir\(\)/);
      expect(source, file).toMatch(/makePrivateTempDir\(/);
      expect(source, file).toMatch(/removePrivateTempDir\(/);
    }
  });
});

describe('the indexing watchdog', () => {
  it('the indexer announces each document, with its time limit, before reading it', async () => {
    const docs = path.join(base, 'Belgeler');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'a.udf'), '<udf>bir</udf>');
    fs.writeFileSync(path.join(docs, 'b.udf'), '<udf>iki</udf>');
    const db = new AppDatabase(path.join(base, 'index.db'));
    const announced: Array<[string, number]> = [];

    await indexFolders([docs], db, undefined, [], [], {
      onReading: (file, limitMs) => announced.push([path.basename(file.path), limitMs])
    });

    const size = fs.statSync(path.join(docs, 'a.udf')).size;
    expect(announced).toEqual([['a.udf', documentReadLimitMs(size)], ['b.udf', documentReadLimitMs(size)]]);
    db.close();
  });

  it('a large file on a slow share gets more time, a stuck parser no more than that', () => {
    expect(documentReadLimitMs(0)).toBe(DOCUMENT_READ_LIMIT_MS);
    expect(documentReadLimitMs(1024)).toBe(DOCUMENT_READ_LIMIT_MS + 60_000);
    expect(documentReadLimitMs(512 * 1024 * 1024)).toBe(DOCUMENT_READ_LIMIT_MS + 11 * 60_000);
  });

  it('text recognition gets a limit sized to its pages', async () => {
    setupFixtures();
    const docs = path.join(base, 'Belgeler');
    fs.mkdirSync(docs);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), path.join(docs, 'tarama.pdf'));
    const db = new AppDatabase(path.join(base, 'index.db'));
    const limits: number[] = [];

    await indexFolders([docs], db, undefined, [], [], {
      ocr: { engine: { recognizePdfPages: async (_file, pages) => pages.map(() => 'tanınan metin '.repeat(50)) }, budgetMs: 60_000 },
      onReading: (_file, limitMs) => limits.push(limitMs)
    });

    const size = fs.statSync(path.join(docs, 'tarama.pdf')).size;
    expect(limits).toEqual([documentReadLimitMs(size), ocrTimeoutMs(1) + 2 * 60 * 1000]);
    db.close();
  });

  it('a document may take MetinBul to 40% of the memory, between 1.5 and 3 GiB', () => {
    const GiB = 1024 ** 3;
    expect(indexingMemoryLimitBytes(2 * GiB)).toBe(1.5 * GiB);
    expect(indexingMemoryLimitBytes(6 * GiB)).toBeCloseTo(2.4 * GiB);
    expect(indexingMemoryLimitBytes(16 * GiB)).toBe(3 * GiB);
    // A smoke test may lower it, never raise it.
    expect(effectiveIndexingMemoryLimitBytes(16 * GiB, { METINBUL_TEST_INDEX_MEMORY_LIMIT_MB: '512' })).toBe(512 * 1024 ** 2);
    expect(effectiveIndexingMemoryLimitBytes(16 * GiB, { METINBUL_TEST_INDEX_MEMORY_LIMIT_MB: '99999' })).toBe(3 * GiB);
    expect(effectiveIndexingMemoryLimitBytes(16 * GiB, { METINBUL_TEST_INDEX_MEMORY_LIMIT_MB: 'yok' })).toBe(3 * GiB);
  });

  it('main.ts stops an overrunning or crashed update and records that document as unreadable', () => {
    const main = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(main).toMatch(/msg\.type === 'reading'[\s\S]{0,300}setTimeout\(\(\) => \{[\s\S]{0,400}worker\.terminate\(\)[\s\S]{0,50}msg\.limitMs\)/);
    expect(main).toMatch(/worker\.on\('error'[\s\S]{0,80}if \(reading\) stuckOn = reading/);
    // A worker that simply ends mid-document (a promise that never settles).
    expect(main).toMatch(/msg\.type === 'done' \|\| msg\.type === 'error'\) finished = true/);
    expect(main).toMatch(/worker\.on\('exit'[\s\S]{0,400}if \(!finished && reading && !stuckOn && !isQuitting\) stuckOn = reading/);
    expect(main).toMatch(/worker\.on\('exit'[\s\S]{0,1000}markDocumentUnreadable\(quarantined\)[\s\S]{0,1000}triggerIndexing\(trigger, \{ retryFailed: false \}\)/);
    // A document whose reading ended is forgotten at the next progress
    // message, so a later error is never pinned on it.
    expect(main).toMatch(/msg\.type === 'progress'\) \{\s*\/\/[^\n]*\n\s*reading = null;\s*disarm\(\);/);
    // A limit Electron's shared V8 heap cage can actually reach.
    expect(main).toMatch(/resourceLimits: \{ maxOldGenerationSizeMb: 2048 \}/);
    // Memory outside that heap (a PDF's decompressed streams) is watched while
    // a document is read, and stops the update the same way.
    expect(main).toMatch(/memoryWatch = setInterval\(\(\) => \{\s*if \(process\.memoryUsage\(\)\.rss <= memoryLimit\) return;\s*stuckOn = reading;[\s\S]{0,300}worker\.terminate\(\)/);
    expect(main).toMatch(/const disarm = \(\) => \{[\s\S]{0,200}clearInterval\(memoryWatch\)/);
    const worker = fs.readFileSync(path.join(ROOT, 'src/main/indexer-worker.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(worker).toMatch(/onReading: \(file, limitMs\) =>[\s\S]{0,200}type: 'reading'/);
  });
});
