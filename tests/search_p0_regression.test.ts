// P0 regression: "ortaklığın giderilmesi" showed "Sonuç bulunamadı" on the
// real profile although 22 indexed documents contain it.
//
// What the existing tests could not catch: they seed a clean in-memory DB
// directly (no extraction, no persisted file, no reopen) and only ever type
// straight ASCII quotes, while search() swallowed every engine error into
// `[]`. These tests run the real chain instead -- a real DOCX through the
// extractor and indexer into a file-backed DB, reopened as the app does on
// start -- and pin the three outcomes the UI must keep apart.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { AppDatabase, normalizeForSearch } from '../src/db/database.js';
import { search, buildFtsQuery, normalizeQueryQuotes } from '../src/search/search.js';
import { runSearch } from '../src/search/search-outcome.js';
import { indexFolders } from '../src/search/indexer.js';

const PHRASE = 'ortaklığın giderilmesi';

function writeDocx(filePath: string, paragraphs: string[]) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`));
  const body = paragraphs.map(p => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  zip.writeZip(filePath);
}

describe('P0 — the real chain: DOCX → extraction → content → FTS → search, on a persisted DB', () => {
  let dir: string;
  let docsDir: string;
  let dbPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-p0-'));
    docsDir = path.join(dir, 'Davalar', 'Örnek İl 1. Asliye Hukuk Mahkemesi - 2000-1');
    fs.mkdirSync(docsDir, { recursive: true });
    writeDocx(path.join(docsDir, 'Dava Dilekçesi.docx'), [
      'İSTANBUL 9. ASLİYE HUKUK MAHKEMESİ SAYIN HAKİMLİĞİNE',
      'KONU: Paydaşı olduğumuz taşınmazda ORTAKLIĞIN GİDERİLMESİ talebimizden ibarettir.',
      'Yukarıda açıklanan nedenlerle ortaklığın giderilmesine karar verilmesini talep ederiz.'
    ]);
    writeDocx(path.join(docsDir, 'Cevaba Cevap Dilekçesi.docx'), [
      'Davalı yanın itirazları yerinde değildir; ortaklığın giderilmesi davası yasal koşulları taşımaktadır.'
    ]);
    // A decoy: both words, but never as the exact phrase.
    writeDocx(path.join(docsDir, 'Bilirkişi Raporu.docx'), [
      'Ortaklığın sona erdirilmesi ve giderilmesi ayrı taleplerdir.'
    ]);

    dbPath = path.join(dir, 'profile', 'metinbul.db');
    const indexing = new AppDatabase(dbPath);
    const summary = await indexFolders([docsDir], indexing, undefined, [], [docsDir]);
    expect(summary.failed).toBe(0);
    indexing.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has the phrase in documents.content and in the FTS index', () => {
    const db = new AppDatabase(dbPath);
    const withPhrase = (db.db.prepare('SELECT path, content FROM documents').all() as { path: string; content: string }[])
      .filter(r => normalizeForSearch(r.content).includes(PHRASE));
    expect(withPhrase.map(r => path.basename(r.path)).sort()).toEqual(['Cevaba Cevap Dilekçesi.docx', 'Dava Dilekçesi.docx']);
    const ftsRows = db.db.prepare('SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?').all(buildFtsQuery(PHRASE));
    expect(ftsRows).toHaveLength(2);
    db.close();
  });

  it('finds it after an app restart, quoted, unquoted, and with the quotes macOS and Word type', () => {
    // A fresh connection on the existing file is exactly what the app does on
    // start (schema init included); nothing is re-indexed first.
    const db = new AppDatabase(dbPath);
    const names = (q: string) => runSearch(q, db).results.map(r => r.filename).sort();
    const expected = ['Cevaba Cevap Dilekçesi.docx', 'Dava Dilekçesi.docx'];
    expect(names(`"${PHRASE}"`)).toEqual(expected);
    expect(names(PHRASE)).toEqual(expected);
    expect(names(`“${PHRASE}”`)).toEqual(expected);
    expect(names(`„${PHRASE}“`)).toEqual(expected);
    expect(names(`«${PHRASE}»`)).toEqual(expected);
    expect(names(`"${PHRASE}”`)).toEqual(expected);
    expect(names(`“${PHRASE.toLocaleUpperCase('tr-TR')}”`)).toEqual(expected);
    db.close();
  });

  it('keeps exact-mode semantics with typographic quotes: the decoy is not an exact match', () => {
    const db = new AppDatabase(dbPath);
    const exact = runSearch(`“${PHRASE}”`, db).results.map(r => r.filename);
    expect(exact).not.toContain('Bilirkişi Raporu.docx');
    // Unquoted keeps its existing infix behaviour (the decoy has both words
    // but not the contiguous phrase, so it is not a hit either).
    const unquoted = runSearch(PHRASE, db);
    expect(unquoted.state).toBe('success');
    expect(unquoted.results.map(r => r.filename).sort()).toEqual(['Cevaba Cevap Dilekçesi.docx', 'Dava Dilekçesi.docx']);
    db.close();
  });

  it('opening the persisted index re-indexes nothing: startup never rescans', () => {
    const before = new AppDatabase(dbPath);
    const snapshot = () => before.db.prepare('SELECT COUNT(*) c, MAX(indexed_at) m, SUM(LENGTH(content)) s FROM documents').get();
    const was = snapshot();
    before.close();

    const reopened = new AppDatabase(dbPath); // what the main process does at launch
    expect(runSearch(`"${PHRASE}"`, reopened).state).toBe('success');
    expect(reopened.db.prepare('SELECT COUNT(*) c, MAX(indexed_at) m, SUM(LENGTH(content)) s FROM documents').get()).toEqual(was);
    reopened.close();
  });

  it('stays searchable while another connection is writing (a manual "Belgeleri Güncelle")', () => {
    const main = new AppDatabase(dbPath);     // the main process: searches
    const worker = new AppDatabase(dbPath);   // the indexer worker: writes
    worker.db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 200; i++) {
      worker.upsertDocument({
        path: path.join(docsDir, `Yeni Belge ${i}.docx`), filename: `Yeni Belge ${i}.docx`, extension: '.docx',
        mtime: Date.now(), size: 10, content: `Yeni içerik ${i}`, index_status: 'indexed'
      });
    }
    // Mid-transaction: the last committed index is still fully searchable.
    const during = runSearch(`"${PHRASE}"`, main);
    expect(during.state).toBe('success');
    expect(during.results).toHaveLength(2);
    worker.db.exec('COMMIT');
    expect(runSearch(`"${PHRASE}"`, main).results).toHaveLength(2);
    worker.close();
    main.close();
  });
});

describe('P0 — outcomes are kept apart; a failure is never "no results"', () => {
  function seeded(): AppDatabase {
    const db = new AppDatabase(':memory:');
    db.upsertDocument({ path: '/d/a.docx', filename: 'a.docx', extension: '.docx', mtime: 1, size: 1, content: `Davacı ${PHRASE} talep etmiştir.`, index_status: 'indexed' });
    return db;
  }

  it('success / no_matches / query_too_short', () => {
    const db = seeded();
    expect(runSearch(`"${PHRASE}"`, db).state).toBe('success');
    expect(runSearch('tahliye', db)).toEqual({ state: 'no_matches', results: [] });
    for (const q of ['ab', '"ab"', '“ab”', '  ']) {
      expect(runSearch(q, db).state).toBe('query_too_short');
    }
  });

  it('index_not_ready when nothing readable is indexed, even if filenames are', () => {
    const db = new AppDatabase(':memory:');
    db.upsertDocument({ path: '/d/scan.pdf', filename: 'ortaklığın giderilmesi.pdf', extension: '.pdf', mtime: 1, size: 1, content: '', index_status: 'no_text' });
    db.upsertDocument({ path: '/d/bad.docx', filename: 'bozuk.docx', extension: '.docx', mtime: 1, size: 1, content: '', index_status: 'failed' });
    expect(runSearch(`"${PHRASE}"`, db).state).toBe('index_not_ready');
  });

  it('a real engine failure throws from search() instead of returning []', () => {
    const db = seeded();
    db.db.exec('DROP TABLE documents_fts');
    expect(() => search(`"${PHRASE}"`, db)).toThrow(/documents_fts/);
  });

  it('...and reaches the UI as search_error with a diagnosable reason', () => {
    const db = seeded();
    db.db.exec('DROP TABLE documents_fts');
    const outcome = runSearch(`"${PHRASE}"`, db);
    expect(outcome.state).toBe('search_error');
    expect(outcome.results).toEqual([]);
    expect(outcome.error).toMatch(/no such table: documents_fts/);
  });
});

describe('P0 — typographic double quotes are exact-mode quotes; apostrophes are untouched', () => {
  it('maps “ ” „ ‟ « » to " and nothing else', () => {
    expect(normalizeQueryQuotes('“a” „b“ ‟c” «d»')).toBe('"a" "b" "c" "d"');
    expect(normalizeQueryQuotes('Yargıtay’ın ‘tespit’')).toBe('Yargıtay’ın ‘tespit’');
  });

  it('keeps the existing behaviour of a typographic apostrophe inside a word', () => {
    const db = new AppDatabase(':memory:');
    db.upsertDocument({ path: '/d/y.docx', filename: 'y.docx', extension: '.docx', mtime: 1, size: 1, content: 'Yargıtay’ın yerleşik içtihadı', index_status: 'indexed' });
    expect(search('Yargıtay’ın', db)).toHaveLength(1);
  });
});
