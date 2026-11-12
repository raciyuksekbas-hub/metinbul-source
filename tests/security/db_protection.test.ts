// The index holds the text of every document MetinBul read. These tests check
// that its files are private to their owner, that deleted text does not stay
// behind in them, and that an interrupted schema migration rolls back
// instead of leaving the index unsearchable. All documents are synthetic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AppDatabase, normalizeForSearch } from '../../src/db/database.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../../src/db/private-files.js';

const isWindows = process.platform === 'win32';
let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-dbsec-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  // Windows may hold a just-closed database file for a moment (virus scan).
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

function doc(docPath: string, content: string) {
  return {
    path: docPath,
    filename: path.basename(docPath),
    extension: path.extname(docPath),
    mtime: 1,
    size: content.length,
    content,
    index_status: 'indexed' as const
  };
}

describe.skipIf(isWindows)('file permissions of the index', () => {
  it('creates the profile folder 0700 and the database files 0600', () => {
    const dir = path.join(base, 'profil');
    const dbPath = path.join(dir, 'metinbul.db');
    const db = new AppDatabase(dbPath);
    db.upsertDocument(doc('/belgeler/a.udf', 'gizli metin'));

    expect(mode(dir)).toBe(PRIVATE_DIR_MODE);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fs.existsSync(dbPath + suffix)).toBe(true);
      expect(mode(dbPath + suffix)).toBe(PRIVATE_FILE_MODE);
    }
    db.close();
  });

  it('narrows an existing world-readable profile left by an older version', () => {
    const dir = path.join(base, 'eski');
    const dbPath = path.join(dir, 'metinbul.db');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const old = new Database(dbPath);
    old.pragma('journal_mode = WAL');
    old.exec('CREATE TABLE t (x)');
    old.close();
    fs.chmodSync(dbPath, 0o644);
    expect(mode(dbPath)).toBe(0o644);

    const db = new AppDatabase(dbPath);

    expect(mode(dir)).toBe(0o700);
    expect(mode(dbPath)).toBe(0o600);
    db.close();
  });

  it('never changes a file through a link planted next to the database', () => {
    const dir = path.join(base, 'profil');
    fs.mkdirSync(dir, { mode: 0o700 });
    const outside = path.join(base, 'baska-dosya.txt');
    fs.writeFileSync(outside, 'x');
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(dir, 'metinbul.db-journal'));

    const db = new AppDatabase(path.join(dir, 'metinbul.db'));

    expect(mode(outside)).toBe(0o644);
    db.close();
  });
});

describe('deleted text does not stay in the file', () => {
  const marker = 'ZQXJ GİZLİ İŞARET 7731';
  const forms = [marker, normalizeForSearch(marker)].map(text => Buffer.from(text, 'utf8'));
  const fileHolds = (file: string) => fs.existsSync(file) && forms.some(form => fs.readFileSync(file).includes(form));

  it('is overwritten in the database, its search table and its write-ahead log', () => {
    const dbPath = path.join(base, 'metinbul.db');
    const db = new AppDatabase(dbPath);
    for (let i = 0; i < 20; i++) db.upsertDocument(doc(`/belgeler/dolgu-${i}.udf`, `sıradan metin ${i} `.repeat(200)));
    db.upsertDocument(doc('/belgeler/gizli.udf', `başlangıç ${marker} bitiş`));
    db.truncateWriteAheadLog();
    expect(fileHolds(dbPath)).toBe(true);

    // The search index holds the text as trigrams with positions; the ones
    // only this document has are the ones that must go.
    db.db.exec("CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main, documents_fts, 'row')");
    const ownTerms = ['zqx', 'qxj', '773'].filter(term => term.length === 3);
    const termCount = () => (db.db.prepare(`SELECT count(*) AS n FROM temp.vocab WHERE term IN (${ownTerms.map(() => '?').join(',')})`).get(...ownTerms) as { n: number }).n;
    expect(termCount()).toBeGreaterThan(0);

    db.deleteDocuments(['/belgeler/gizli.udf']);
    expect(db.compactSearchIndex()).toBe(true);
    db.truncateWriteAheadLog();

    expect(fileHolds(dbPath)).toBe(false);
    expect(fileHolds(`${dbPath}-wal`)).toBe(false);
    expect(termCount()).toBe(0);
    // Searching still works on what is left.
    expect(db.db.prepare('SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH ?').get('"sıradan"')).toEqual({ n: 20 });
    db.close();
  });

  it('uses no FTS5 secure-delete (it held the write lock for seconds), and switches off a profile that had it', () => {
    const dbPath = path.join(base, 'metinbul.db');
    const first = new AppDatabase(dbPath);
    first.db.prepare("INSERT INTO documents_fts(documents_fts, rank) VALUES('secure-delete', 1)").run();
    first.close();

    const db = new AppDatabase(dbPath);
    const row = db.db.prepare("SELECT v FROM documents_fts_config WHERE k = 'secure-delete'").get() as { v: number } | undefined;
    expect(row?.v ?? 0).toBe(0);
    db.close();
  });

  it('deleting a batch of documents holds the write lock only briefly', () => {
    const db = new AppDatabase(path.join(base, 'metinbul.db'));
    const text = (i: number) => `dava ${i} tazminat karar müvekkil dilekçe istinaf `.repeat(300);
    db.db.transaction(() => { for (let i = 0; i < 400; i++) db.upsertDocument(doc(`/belgeler/${i}.udf`, text(i))); })();
    const started = Date.now();
    db.deleteDocuments(Array.from({ length: 200 }, (_, i) => `/belgeler/${i}.udf`));
    db.compactSearchIndex();
    expect(Date.now() - started).toBeLessThan(5_000);
    db.close();
  });

  it('(control: without secure delete, SQLite leaves it in the file)', () => {
    const dbPath = path.join(base, 'kontrol.db');
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, content TEXT); CREATE VIRTUAL TABLE documents_fts USING fts5(content, tokenize='trigram');");
    for (let i = 0; i < 20; i++) raw.prepare('INSERT INTO documents (content) VALUES (?)').run(`sıradan metin ${i} `.repeat(200));
    const id = raw.prepare('INSERT INTO documents (content) VALUES (?)').run(`başlangıç ${marker} bitiş`).lastInsertRowid;
    raw.prepare('INSERT INTO documents_fts (rowid, content) VALUES (?, ?)').run(id, `başlangıç ${marker} bitiş`);
    raw.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(id);
    raw.prepare('DELETE FROM documents WHERE id = ?').run(id);
    raw.close();

    expect(fileHolds(dbPath)).toBe(true);
  });

  it('deletes large batches (more than one transaction) completely', () => {
    const db = new AppDatabase(path.join(base, 'metinbul.db'));
    const paths = Array.from({ length: 137 }, (_, i) => `/belgeler/${i}.udf`);
    for (const p of paths) db.upsertDocument(doc(p, `metin ${p}`));

    db.deleteDocuments(paths.slice(0, 120));

    expect(db.getAllDocumentPaths().length).toBe(17);
    expect((db.db.prepare('SELECT count(*) AS n FROM documents_fts').get() as { n: number }).n).toBe(17);
    db.close();
  });
});

describe('an interrupted migration of the search table', () => {
  // An index from before the trigram tokenizer: the migration rebuilds the
  // search table from the documents table.
  function writeOldIndex(dbPath: string) {
    const raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, filename TEXT NOT NULL,
        extension TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, content TEXT NOT NULL,
        index_status TEXT NOT NULL, indexed_at INTEGER NOT NULL, ocr TEXT);
      CREATE VIRTUAL TABLE documents_fts USING fts5(filename, content);
    `);
    const info = raw.prepare(`INSERT INTO documents (path, filename, extension, mtime, size, content, index_status, indexed_at)
      VALUES ('/belgeler/karar.udf', 'karar.udf', '.udf', 1, 1, 'istinaf mahkemesi kararı', 'indexed', 1)`).run();
    raw.prepare('INSERT INTO documents_fts (rowid, filename, content) VALUES (?, ?, ?)').run(info.lastInsertRowid, 'karar.udf', 'istinaf mahkemesi kararı');
    raw.close();
  }

  const ftsSql = (dbPath: string) => {
    const raw = new Database(dbPath, { readonly: true });
    const row = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'documents_fts'").get() as { sql: string } | undefined;
    raw.close();
    return row?.sql ?? '';
  };

  it('rolls back, and the next start completes it with every document searchable', () => {
    const dbPath = path.join(base, 'metinbul.db');
    writeOldIndex(dbPath);

    // The process dies (here: throws) while the new table is being filled.
    const realPrepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes('INSERT INTO documents_fts (rowid, filename, content)')) throw new Error('kesinti');
      return realPrepare.call(this, sql);
    });
    expect(() => new AppDatabase(dbPath)).toThrow('kesinti');
    spy.mockRestore();

    // Rolled back: the old table, with its row, is still there.
    expect(ftsSql(dbPath)).not.toContain('trigram');

    const db = new AppDatabase(dbPath);
    expect(ftsSql(dbPath)).toContain('trigram');
    const hits = db.db.prepare('SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?').all(`"${normalizeForSearch('mahkemesi')}"`);
    expect(hits.length).toBe(1);
    db.close();
  });
});

describe('looking documents up from the main process', () => {
  it('hasDocument answers from the path index alone', () => {
    const db = new AppDatabase(path.join(base, 'metinbul.db'));
    db.upsertDocument(doc('/belgeler/a.pdf', 'metin'));
    expect(db.hasDocument('/belgeler/a.pdf')).toBe(true);
    expect(db.hasDocument('/belgeler/b.pdf')).toBe(false);
    const plan = db.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM documents WHERE path = ? LIMIT 1").all('/x') as { detail: string }[];
    expect(plan.map(p => p.detail).join(' ')).toMatch(/COVERING INDEX/);
    db.close();
  });

  it('markDocumentUnreadable keeps the text of an unchanged document and only fails its OCR', () => {
    const db = new AppDatabase(path.join(base, 'metinbul.db'));
    db.upsertDocument({ ...doc('/belgeler/tarama.pdf', 'metin katmanı'), mtime: 5, size: 9 });
    db.markDocumentUnreadable({ path: '/belgeler/tarama.pdf', filename: 'tarama.pdf', extension: '.pdf', mtime: 5, size: 9 });
    const kept = db.getDocumentByPath('/belgeler/tarama.pdf');
    expect(kept?.index_status).toBe('indexed');
    expect(kept?.content).toBe('metin katmanı');
    expect(kept?.ocr).toBe('failed');

    db.markDocumentUnreadable({ path: '/belgeler/yeni.docx', filename: 'yeni.docx', extension: '.docx', mtime: 1, size: 1 });
    expect(db.getDocumentByPath('/belgeler/yeni.docx')?.index_status).toBe('failed');
    db.close();
  });
});
