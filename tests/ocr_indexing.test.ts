// What an index update does with PDF pages that carry no real text layer --
// scanned pages -- when text recognition (OCR) is available. 603 of the real
// profile's PDFs (2026-11-07) had no text layer at all, and more had only a
// stamp or a page number on top of the picture of their content.
//
// Real files in a temp folder go through the real scanner and indexer. Two
// things are stand-ins: the PDF text extractor (pages are separated by a line
// "===", a page starting with TARAMA has no text layer) and the recognizer,
// which returns what the test gives it. tests/ocr_helper.test.ts and
// tests/windows_ocr.test.ts run the real recognizers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Every PDF whose text layer the extractor read.
const pdfReads: string[] = [];

function fakeTextLayer(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').split('\n===\n').map(page => (page.startsWith('TARAMA') ? '' : page));
}

vi.mock('../src/extractors/pdf.js', () => ({
  extractPdfPages: async (filePath: string) => {
    pdfReads.push(filePath);
    return fakeTextLayer(filePath);
  },
  extractPdf: async (filePath: string) => fakeTextLayer(filePath).join('\n')
}));

vi.mock('../src/extractors/udf.js', () => ({
  extractUdf: async (filePath: string) => fs.readFileSync(filePath, 'utf8')
}));

import { AppDatabase } from '../src/db/database.js';
import { indexFolders, IndexOptions } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import { OcrEngine, ocrTimeoutMs } from '../src/ocr/ocr.js';
import { ContentNotLocallyAvailableError } from '../src/scanner/windows-availability.js';

let base: string;
let root: string;
let db: AppDatabase;

// What the stand-in recognizer "reads" on each page, and what it was asked.
const pageText = new Map<string, string>();
const recognizeCalls: { filePath: string; pages: number[] }[] = [];
const failing = new Set<string>();
const wentToCloud = new Set<string>();
let recognizeDelayMs = 0;

const engine: OcrEngine = {
  async recognizePdfPages(filePath: string, pages: number[]) {
    recognizeCalls.push({ filePath, pages });
    if (recognizeDelayMs) await new Promise(resolve => setTimeout(resolve, recognizeDelayMs));
    if (wentToCloud.has(filePath)) throw new ContentNotLocallyAvailableError(filePath);
    if (failing.has(filePath)) throw new Error('unreadable scan');
    return pages.map(n => pageText.get(`${filePath}#${n}`) ?? '');
  }
};

function withOcr(budgetMs = 60_000, retryFailed?: boolean): IndexOptions {
  return { ocr: { engine, budgetMs }, retryFailed };
}

function write(relativePath: string, text: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  return filePath;
}

// A full page of real text: far more than a stamp or a footer.
function fullPage(words: string): string {
  return `${words} ${'dava dosyası incelendi '.repeat(30)}`;
}

// A PDF of the given pages; a string starting with TARAMA has no text layer.
function pdf(relativePath: string, pages: string[]): string {
  return write(relativePath, pages.join('\n===\n'));
}

// A fully scanned one-page PDF whose page "shows" the given text.
function scanned(relativePath: string, shows: string): string {
  const filePath = pdf(relativePath, [`TARAMA ${relativePath}`]);
  pageText.set(`${filePath}#1`, shows);
  return filePath;
}

function update(options: IndexOptions = {}) {
  return indexFolders([root], db, undefined, [], [], options);
}

function foundPaths(query: string): string[] {
  return search(query, db).map(r => r.path);
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-ocr-'));
  root = path.join(base, 'home');
  fs.mkdirSync(root);
  db = new AppDatabase(path.join(base, 'index.db'));
  pdfReads.length = 0;
  recognizeCalls.length = 0;
  pageText.clear();
  failing.clear();
  wentToCloud.clear();
  recognizeDelayMs = 0;
});

afterEach(() => {
  db.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('a scanned PDF and text recognition', () => {
  it('is read by text recognition and found by its words; a PDF with text is not', async () => {
    const scan = scanned('Belgeler/bilirkisi.pdf', 'ortaklığın giderilmesi davasında bilirkişi raporu');
    const typed = pdf('Belgeler/kira.pdf', [fullPage('kira tespiti davası')]);

    const summary = await update(withOcr());

    expect(recognizeCalls).toEqual([{ filePath: scan, pages: [1] }]);
    expect(summary.ocrRecognized).toBe(1);
    expect(summary.ocrPending).toBe(0);
    expect(foundPaths('ortaklığın giderilmesi')).toEqual([scan]);
    expect(foundPaths('kira tespiti')).toEqual([typed]);
    expect(db.getDocumentByPath(scan)).toMatchObject({ index_status: 'indexed', ocr: 'text' });
    expect(db.getDocumentByPath(typed)).toMatchObject({ index_status: 'indexed', ocr: 'none' });
  });

  it('is read even when a stamp or a footer gives it a line of real text', async () => {
    const scan = pdf('damgali.pdf', ['Dosya No 2024-117']);
    // Recognition misreads the stamp; the exact text layer must stay searchable.
    pageText.set(`${scan}#1`, 'Dosya N0 2O24-ll7 ecrimisil davasında keşif ve bilirkişi incelemesi yapılmıştır');

    await update(withOcr());

    expect(recognizeCalls).toEqual([{ filePath: scan, pages: [1] }]);
    expect(foundPaths('ecrimisil davasında')).toEqual([scan]);
    expect(foundPaths('Dosya No 2024-117')).toEqual([scan]);
    expect(db.getDocumentByPath(scan)).toMatchObject({ index_status: 'indexed', ocr: 'text' });
  });

  it('reads only the pages that need it in a partly scanned document', async () => {
    const mixed = pdf('karma.pdf', [fullPage('birinci sayfa dilekçe'), 'TARAMA ek', fullPage('üçüncü sayfa sonuç')]);
    pageText.set(`${mixed}#2`, 'taranmış ek tapu kaydı');

    await update(withOcr());

    expect(recognizeCalls).toEqual([{ filePath: mixed, pages: [2] }]);
    for (const words of ['birinci sayfa dilekçe', 'taranmış ek tapu', 'üçüncü sayfa sonuç']) {
      expect(foundPaths(words), words).toEqual([mixed]);
    }
  });

  it('keeps the exact text of a short page when recognition finds no more', async () => {
    const short = pdf('kisa.pdf', ['Ek: vekaletname örneği']);
    pageText.set(`${short}#1`, 'Ek vekaletname');

    await update(withOcr());

    expect(foundPaths('vekaletname örneği')).toEqual([short]);
    expect(db.getDocumentByPath(short)).toMatchObject({ index_status: 'indexed', ocr: 'empty' });
  });

  it('is not read again once done, whether or not it had text', async () => {
    const withText = scanned('a.pdf', 'tapu iptali ve tescil');
    const photo = scanned('b.pdf', '');
    await update(withOcr());
    expect(recognizeCalls.map(c => c.filePath).sort()).toEqual([withText, photo].sort());
    expect(db.getDocumentByPath(photo)).toMatchObject({ index_status: 'no_text', ocr: 'empty' });

    recognizeCalls.length = 0;
    pdfReads.length = 0;
    const next = await update(withOcr());

    expect(recognizeCalls).toEqual([]);
    expect(pdfReads).toEqual([]);
    expect(next.skipped).toBe(2);
  });

  it('spreads a large first run over several updates', async () => {
    const scans = [1, 2, 3, 4, 5].map(i => scanned(`Arsiv/tarama-${i}.pdf`, `dilekçe numarası ${i}00`));
    recognizeDelayMs = 40;

    const first = await update(withOcr(60));
    expect(first.ocrRecognized).toBeGreaterThan(0);
    expect(first.ocrRecognized).toBeLessThan(5);
    expect(first.ocrPending).toBe(5 - first.ocrRecognized);
    expect(db.getInScopeOcrCounts('all', [], [])).toEqual({ recognized: first.ocrRecognized, pending: first.ocrPending });

    // With no budget at all, a waiting PDF is not even opened.
    pdfReads.length = 0;
    const idle = await update(withOcr(0));
    expect(pdfReads).toEqual([]);
    expect(idle.ocrPending).toBe(first.ocrPending);

    for (let pass = 0; pass < 5 && db.getInScopeOcrCounts('all', [], []).pending > 0; pass++) {
      await update(withOcr(60));
    }

    expect(db.getInScopeOcrCounts('all', [], [])).toEqual({ recognized: 5, pending: 0 });
    expect(new Set(recognizeCalls.map(c => c.filePath)).size).toBe(5);
    expect(recognizeCalls).toHaveLength(5);
    for (const [i, scan] of scans.entries()) {
      expect(foundPaths(`dilekçe numarası ${i + 1}00`)).toEqual([scan]);
    }
  });

  it('waits when text recognition is not available, without being opened every time', async () => {
    const scan = scanned('tarama.pdf', 'icra takibine itiraz');

    const without = await update();
    expect(recognizeCalls).toEqual([]);
    expect(without.ocrPending).toBe(0);
    expect(db.getDocumentByPath(scan)).toMatchObject({ index_status: 'no_text', ocr: 'pending' });
    expect(db.getInScopeOcrCounts('all', [], [])).toEqual({ recognized: 0, pending: 1 });

    pdfReads.length = 0;
    const again = await update();
    expect(pdfReads).toEqual([]);
    expect(again.skipped).toBe(1);
    expect(again.ocrPending).toBe(0);

    await update(withOcr());
    expect(foundPaths('icra takibine itiraz')).toEqual([scan]);
  });

  it('retries a failed recognition on "Belgeleri Güncelle", not on automatic updates', async () => {
    const scan = scanned('bozuk.pdf', 'nafaka artırımı');
    failing.add(scan);
    await update(withOcr());
    expect(db.getDocumentByPath(scan)).toMatchObject({ index_status: 'no_text', ocr: 'failed' });

    failing.delete(scan);
    recognizeCalls.length = 0;
    await update(withOcr(60_000, false));
    expect(recognizeCalls).toEqual([]);

    await update(withOcr(60_000, true));
    expect(recognizeCalls).toEqual([{ filePath: scan, pages: [1] }]);
    expect(foundPaths('nafaka artırımı')).toEqual([scan]);
  });

  it('is read again when it changes', async () => {
    const scan = scanned('dilekce.pdf', 'eski dilekçe metni');
    await update(withOcr());

    fs.writeFileSync(scan, 'TARAMA yeniden taranmış, daha uzun bir sürüm');
    pageText.set(`${scan}#1`, 'yeni dilekçe metni');
    await update(withOcr());

    expect(foundPaths('yeni dilekçe')).toEqual([scan]);
    expect(foundPaths('eski dilekçe')).toEqual([]);
  });

  it('keeps waiting when its content went to the cloud meanwhile', async () => {
    const scan = scanned('bulut.pdf', 'kat mülkiyeti');
    wentToCloud.add(scan);

    const summary = await update(withOcr());

    expect(summary.ocrPending).toBe(1);
    expect(db.getDocumentByPath(scan)).toMatchObject({ index_status: 'no_text', ocr: 'pending' });
  });

  it('is only for PDFs: a Word or UDF document without text is left alone', async () => {
    write('bos.udf', '');
    await update(withOcr());
    expect(recognizeCalls).toEqual([]);
  });
});

describe('a PDF indexed before pages were checked one by one', () => {
  function indexedByAnOlderVersion(filePath: string, content: string, index_status: 'indexed' | 'no_text') {
    const stat = fs.statSync(filePath);
    db.upsertDocument({
      path: filePath, filename: path.basename(filePath), extension: '.pdf',
      mtime: Math.floor(stat.mtimeMs), size: stat.size, content, index_status, ocr: null
    });
  }

  it('is checked once after the update, without the index being rebuilt', async () => {
    const typed = pdf('metin.pdf', [fullPage('karar düzeltme')]);
    const stamped = pdf('damgali.pdf', ['Sayfa 1']);
    indexedByAnOlderVersion(typed, fullPage('karar düzeltme'), 'indexed');
    indexedByAnOlderVersion(stamped, 'Sayfa 1', 'indexed');
    pageText.set(`${stamped}#1`, 'Sayfa 1 temyiz incelemesi sonucunda onama kararı verilmiştir');

    await update(withOcr());

    expect(recognizeCalls).toEqual([{ filePath: stamped, pages: [1] }]);
    expect(db.getDocumentByPath(typed)).toMatchObject({ index_status: 'indexed', ocr: 'none' });
    expect(foundPaths('onama kararı')).toEqual([stamped]);

    pdfReads.length = 0;
    recognizeCalls.length = 0;
    await update(withOcr());
    expect(pdfReads).toEqual([]);
    expect(recognizeCalls).toEqual([]);
  });

  it('keeps its text when reading it again fails', async () => {
    const file = pdf('okunamayan.pdf', [fullPage('tanıma davası')]);
    indexedByAnOlderVersion(file, fullPage('tanıma davası'), 'indexed');
    const extractors = await import('../src/extractors/pdf.js');
    const failingRead = vi.spyOn(extractors, 'extractPdfPages').mockRejectedValueOnce(new Error('dosya şu an okunamıyor'));

    const summary = await update(withOcr());

    failingRead.mockRestore();
    expect(summary.failed).toBe(0);
    expect(foundPaths('tanıma davası')).toEqual([file]);
    expect(db.getDocumentByPath(file)).toMatchObject({ index_status: 'indexed', ocr: null });

    // Still unchecked, so the next update tries again.
    await update(withOcr());
    expect(db.getDocumentByPath(file)).toMatchObject({ index_status: 'indexed', ocr: 'none' });
  });

  it('is checked even where text recognition is not available, and then waits', async () => {
    const stamped = pdf('damgali.pdf', ['Sayfa 1']);
    indexedByAnOlderVersion(stamped, 'Sayfa 1', 'indexed');

    await update();

    expect(db.getDocumentByPath(stamped)).toMatchObject({ index_status: 'indexed', ocr: 'pending' });
    expect(foundPaths('Sayfa 1')).toEqual([stamped]);
  });
});

describe('the time limit of text recognition', () => {
  it('grows with the pages, so a long scan is not failed for its length', () => {
    // Room for the first use, when the system loads its recognizer (about 25 s).
    expect(ocrTimeoutMs(1)).toBeGreaterThanOrEqual(2 * 60 * 1000);
    // Windows takes about a second a page; leave room for a slow computer.
    expect(ocrTimeoutMs(1000)).toBeGreaterThanOrEqual(1000 * 3 * 1000);
  });
});

describe('an index made before text recognition', () => {
  it('gets the new column and keeps its documents', async () => {
    const dbPath = path.join(base, 'eski.db');
    const Database = (await import('better-sqlite3')).default;
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
        extension TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, content TEXT NOT NULL,
        index_status TEXT NOT NULL, indexed_at INTEGER NOT NULL
      );
      INSERT INTO documents (path, filename, extension, mtime, size, content, index_status, indexed_at)
      VALUES ('/eski/tarama.pdf', 'tarama.pdf', '.pdf', 1, 1, '', 'no_text', 1),
             ('/eski/karar.pdf', 'karar.pdf', '.pdf', 1, 1, 'temyiz incelemesi', 'indexed', 1);
    `);
    old.close();

    const upgraded = new AppDatabase(dbPath);
    try {
      expect(upgraded.getDocumentByPath('/eski/tarama.pdf')).toMatchObject({ index_status: 'no_text', ocr: null });
      expect(upgraded.getInScopeOcrCounts('all', [], [])).toEqual({ recognized: 0, pending: 1 });
      expect(search('temyiz incelemesi', upgraded).map(r => r.path)).toEqual(['/eski/karar.pdf']);
    } finally {
      upgraded.close();
    }
  });
});
