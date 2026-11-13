// â, î, û are read as a, i, u -- "şikayet" finds "şikâyet", "hakimliğine"
// finds "HÂKİMLİĞİNE" (a colleague's review of 0.4.3 found neither) -- and a
// search table built by 0.4.4 or earlier is rebuilt once in that form, also
// keeping no second copy of the documents' text.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppDatabase, normalizeForSearch, normalizeForSearchV1 } from '../../src/db/database.js';
import { search, generateSnippets, hasExactWordMatch } from '../../src/search/search.js';

let base: string;
let dbPath: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbfts-')));
  dbPath = path.join(base, 'metinbul.db');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const DOCS: Array<[string, string]> = [
  ['dilekce.udf', 'Müvekkilin şikâyet dilekçesi ekte sunulmuştur.'],
  ['hitap.udf', 'ANKARA 3. ASLİYE HUKUK HÂKİMLİĞİNE'],
  ['ekler.udf', 'Vekâletname ve mahkûmiyet kararı ile millî emlak yazısı.'],
  ['duz.udf', 'Şikayet ve hakim kelimeleri burada şapkasız yazılmış.']
];

function add(db: AppDatabase, [filename, content]: [string, string], i: number) {
  db.upsertDocument({ path: path.join(base, filename), filename, extension: '.udf', mtime: i + 1, size: content.length, content, index_status: 'indexed' });
}

const found = (db: AppDatabase, query: string) => search(query, db).map(r => r.filename).sort();

describe('circumflexes', () => {
  it('fold one letter for one, after Turkish lowercasing', () => {
    expect(normalizeForSearch('HÂKİMLİĞİNE')).toBe('hakimliğine');
    expect(normalizeForSearch('şikâyet MAHKÛM millî')).toBe('şikayet mahkum milli');
    // Decomposed input (a + combining circumflex) is composed first.
    expect(normalizeForSearch('şikâyet')).toBe('şikayet');
    expect(normalizeForSearch('ILGAZ İĞDIR')).toBe('ılgaz iğdır');
    expect(normalizeForSearchV1('HÂKİMLİĞİNE')).toBe('hâkimliğine');
  });

  it('either spelling finds both', () => {
    const db = new AppDatabase(dbPath);
    DOCS.forEach((doc, i) => add(db, doc, i));
    expect(found(db, 'şikayet')).toEqual(['dilekce.udf', 'duz.udf']);
    expect(found(db, 'şikâyet')).toEqual(['dilekce.udf', 'duz.udf']);
    expect(found(db, 'hakimliğine')).toEqual(['hitap.udf']);
    expect(found(db, 'HÂKİM')).toEqual(['duz.udf', 'hitap.udf']);
    expect(found(db, 'vekalet')).toEqual(['ekler.udf']);
    expect(found(db, 'mahkum')).toEqual(['ekler.udf']);
    expect(found(db, 'milli emlak')).toEqual(['ekler.udf']);
    expect(found(db, '"şikayet"')).toEqual(['dilekce.udf', 'duz.udf']);
    db.close();
  });

  it('the result shows the document\'s own spelling, highlighted where it is', () => {
    const { snippets, matchCount } = generateSnippets('Müvekkilin şikâyet dilekçesi ekte.', 'şikayet');
    expect(matchCount).toBe(1);
    expect(snippets[0]).toBe('Müvekkilin <mark>şikâyet</mark> dilekçesi ekte.');
    expect(generateSnippets('HÂKİMLİĞİNE', 'hakimliğine').snippets[0]).toBe('<mark>HÂKİMLİĞİNE</mark>');
    expect(hasExactWordMatch('mahkûmiyet kararı', 'mahkumiyet')).toBe(true);
    expect(hasExactWordMatch('mahkûmiyet kararı', 'mahkum')).toBe(false);
  });
});

// A table as 0.4.4 and earlier built it: content kept, no folding.
function makeOldTable(file: string) {
  const raw = new Database(file);
  raw.exec('DROP TABLE documents_fts');
  raw.exec("CREATE VIRTUAL TABLE documents_fts USING fts5(filename, content, tokenize = 'trigram')");
  const rows = raw.prepare('SELECT id, filename, content, index_status FROM documents').all() as Array<{ id: number; filename: string; content: string; index_status: string }>;
  const insert = raw.prepare('INSERT INTO documents_fts (rowid, filename, content) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.id, normalizeForSearchV1(row.filename), row.index_status === 'indexed' ? normalizeForSearchV1(row.content) : '');
  raw.close();
}

describe('a search table built by 0.4.4 or earlier', () => {
  function oldIndex(extra = 0) {
    const db = new AppDatabase(dbPath);
    DOCS.forEach((doc, i) => add(db, doc, i));
    for (let i = 0; i < extra; i++) add(db, [`ek ${i}.udf`, `Ek belge ${i} tazminat`], 100 + i);
    db.close();
    makeOldTable(dbPath);
    return new AppDatabase(dbPath);
  }

  it('is opened as it is and searched in its own form until rebuilt', () => {
    const db = oldIndex();
    expect(db.searchTextForm()).toBe(1);
    expect(db.needsSearchTableUpgrade()).toBe(true);
    // As before: each spelling finds only itself.
    expect(found(db, 'şikâyet')).toEqual(['dilekce.udf']);
    expect(found(db, 'şikayet')).toEqual(['duz.udf']);
    // A document written now goes in in the old form too.
    add(db, ['yeni.udf', 'Şikâyet konusu'], 50);
    expect(found(db, 'şikâyet')).toEqual(['dilekce.udf', 'yeni.udf']);
    db.close();
  });

  it('is rebuilt in the current form, with nothing lost', () => {
    const db = oldIndex(450);
    expect(db.upgradeSearchTable()).toBe(true);
    expect(db.searchTextForm()).toBe(2);
    expect(db.needsSearchTableUpgrade()).toBe(false);
    const sql = (db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get() as { sql: string }).sql;
    expect(sql).toMatch(/content = ''/);
    expect(found(db, 'şikayet')).toEqual(['dilekce.udf', 'duz.udf']);
    expect(search('tazminat', db, 1000)).toHaveLength(450);
    // No copy of the text is kept in the table any more.
    expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'documents_fts_content'").get()).toBeUndefined();
    // And a document written now goes in in the new form.
    add(db, ['yeni.udf', 'Şikâyet konusu'], 50);
    expect(found(db, 'şikayet')).toContain('yeni.udf');
    expect(db.upgradeSearchTable()).toBe(false);
    db.close();
  });

  it('takes in what changed while it was rebuilt: new, rewritten and deleted documents', () => {
    const db = oldIndex(450);
    // Another connection (the main process) writes while the indexer thread
    // rebuilds, between its pages.
    const other = new AppDatabase(dbPath);
    let page = 0;
    const done = db.upgradeSearchTable({
      shouldStop: () => {
        page++;
        if (page === 2) {
          other.deleteDocuments([path.join(base, 'duz.udf')]);
          add(other, ['dilekce.udf', 'Artık bambaşka bir metin: ecrimisil'], 7);
          add(other, ['sonradan.udf', 'Sonradan gelen hâkim kararı'], 60);
        }
        return false;
      }
    });
    expect(done).toBe(true);
    expect(page).toBeGreaterThan(2);
    expect(found(db, 'şikayet')).toEqual([]);
    expect(found(db, 'ecrimisil')).toEqual(['dilekce.udf']);
    expect(found(db, 'hakim')).toEqual(['hitap.udf', 'sonradan.udf']);
    expect(search('tazminat', db, 1000)).toHaveLength(450);
    other.close();
    db.close();
  });

  it('interrupted, stays as it was and is rebuilt at the next update', () => {
    const db = oldIndex(450);
    let pages = 0;
    expect(db.upgradeSearchTable({ shouldStop: () => ++pages > 1 })).toBe(false);
    expect(db.searchTextForm()).toBe(1);
    expect(found(db, 'şikâyet')).toEqual(['dilekce.udf']);
    db.close();

    const again = new AppDatabase(dbPath);
    expect(again.upgradeSearchTable()).toBe(true);
    expect(found(again, 'şikayet')).toEqual(['dilekce.udf', 'duz.udf']);
    expect(search('tazminat', again, 1000)).toHaveLength(450);
    again.close();
  });
});

describe('the search scope', () => {
  it('is applied before the 1,000-candidate limit: a chosen folder\'s older matches are not crowded out', () => {
    const db = new AppDatabase(dbPath);
    const chosen = path.join(base, 'Seçilen');
    const elsewhere = path.join(base, 'Başka');
    db.db.exec('BEGIN');
    for (let i = 0; i < 1100; i++) {
      db.upsertDocument({ path: path.join(elsewhere, `b${i}.udf`), filename: `b${i}.udf`, extension: '.udf', mtime: 10_000 + i, size: 1, content: 'tazminat talebi', index_status: 'indexed' });
    }
    for (let i = 0; i < 5; i++) {
      db.upsertDocument({ path: path.join(chosen, `s${i}.udf`), filename: `s${i}.udf`, extension: '.udf', mtime: i, size: 1, content: 'tazminat talebi', index_status: 'indexed' });
    }
    db.db.exec('COMMIT');
    const results = search('tazminat', db, 100, { mode: 'selected', includedPaths: [chosen], excludedPaths: [] });
    expect(results.map(r => r.filename).sort()).toEqual(['s0.udf', 's1.udf', 's2.udf', 's3.udf', 's4.udf']);
    // An excluded folder's documents never come back either.
    expect(search('tazminat', db, 2000, { mode: 'all', includedPaths: [], excludedPaths: [elsewhere] })).toHaveLength(5);
    db.close();
  });
});

describe('temporary data of an encrypted index', () => {
  it('stays in memory, on the writing and the reading connections', async () => {
    const { newKeyHex } = await import('../../src/db/encryption.js');
    const key = newKeyHex();
    const db = new AppDatabase(dbPath, { keyHex: key });
    expect(db.db.pragma('temp_store', { simple: true })).toBe(2);
    const reader = new AppDatabase(dbPath, { keyHex: key, queryOnly: true });
    expect(reader.db.pragma('temp_store', { simple: true })).toBe(2);
    reader.close();
    db.close();
  });
});
