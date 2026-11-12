import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as path from 'path';
import { isPathExcluded, isPathOrSubpath } from '../scanner/scanner.js';
import { ensurePrivateDirectory, restrictDatabaseFiles } from './private-files.js';
import { applyKey } from './encryption.js';

// Deleted rows are removed in transactions of this many documents, so the
// main process -- which writes a setting now and then on the same file -- is
// never kept waiting long for the write lock.
const DELETE_BATCH = 50;

export interface DocumentRecord {
  id?: number;
  path: string;
  filename: string;
  extension: string;
  mtime: number;
  size: number;
  content: string;
  index_status: 'indexed' | 'failed' | 'no_text';
  indexed_at?: number;
  // Text recognition of a PDF's pages that carry almost no text layer
  // (scanned pages): 'none' when no page needed it, 'pending' while it waits
  // for it, 'text' when it added text, 'empty' when it found nothing more,
  // 'failed' when it could not read the file. NULL for other formats, and for
  // a PDF indexed before pages were checked one by one -- such a PDF is
  // checked again once.
  ocr?: OcrState | null;
}

export type OcrState = 'none' | 'pending' | 'text' | 'empty' | 'failed';

export interface OcrCounts {
  /** Scanned PDFs whose content came from text recognition. */
  recognized: number;
  /** Scanned PDFs still waiting for it. */
  pending: number;
}

export interface SearchAreaRecord {
  path: string;
  type: 'include' | 'exclude';
  added_at: number;
}

export interface FolderRecord {
  path: string;
  added_at: number;
}

export interface ScopeStatusCounts {
  indexed: number;
  /** Extraction failed: the document exists but MetinBul could not read it. */
  failed: number;
  /** Read fine but carries no text layer (e.g. a scanned PDF). */
  noText: number;
}

export interface UnreadableDocument {
  path: string;
  filename: string;
  status: 'failed' | 'no_text';
}

export function normalizeForSearch(text: string): string {
  if (!text) return '';
  return text.normalize('NFC').toLocaleLowerCase('tr-TR');
}

export interface AppDatabaseOptions {
  // For a thread that only reads an index the main process has already opened:
  // the schema is left alone and any write fails.
  queryOnly?: boolean;
  // The index key (64 hex characters) when the index is encrypted; see
  // encryption.ts. Without it the file is a plain SQLite database.
  keyHex?: string;
}

export class AppDatabase {
  public db: DatabaseType;

  constructor(dbPath: string = ':memory:', options: AppDatabaseOptions = {}) {
    if (options.queryOnly) {
      this.db = new Database(dbPath, { fileMustExist: true });
      try {
        if (options.keyHex) applyKey(this.db, options.keyHex);
        this.db.pragma('busy_timeout = 3000');
        this.db.pragma('query_only = ON');
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }

    if (dbPath !== ':memory:') {
      ensurePrivateDirectory(path.dirname(dbPath));
      restrictDatabaseFiles(dbPath);
    }

    this.db = new Database(dbPath);
    try {
      // The key comes before anything else reads or writes the file.
      if (options.keyHex) applyKey(this.db, options.keyHex);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      // The background indexer and the search worker each have their own
      // connection to this same file; a busy_timeout keeps a rare lock
      // collision from surfacing as SQLITE_BUSY.
      this.db.pragma('busy_timeout = 3000');
      // A deleted or rewritten document's text is overwritten with zeros
      // instead of lingering in free pages of the file (see also
      // compactSearchIndex for the search index's own leftovers).
      this.db.pragma('secure_delete = ON');
      this.initSchema();
    } catch (error) {
      // Not left open behind a failed start: on Windows an open handle keeps
      // the file locked until the garbage collector gets to it.
      this.db.close();
      throw error;
    }
    // The -wal and -shm files only exist once the file has been opened.
    restrictDatabaseFiles(dbPath);
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        path TEXT PRIMARY KEY NOT NULL,
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_areas (
        path TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
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

      CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
      CREATE INDEX IF NOT EXISTS idx_search_areas_type ON search_areas(type);
    `);

    // Added with text recognition. The indexer worker opens the same file on
    // its own connection, so the other one may have added it first.
    const documentColumns = this.db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    if (!documentColumns.some(column => column.name === 'ocr')) {
      try {
        this.db.exec('ALTER TABLE documents ADD COLUMN ocr TEXT');
      } catch {
        // Already there
      }
    }

    // Migrate any legacy folders to search_areas
    try {
      this.db.exec(`
        INSERT INTO search_areas (path, type, added_at)
        SELECT path, 'include', added_at FROM folders
        WHERE path NOT IN (SELECT path FROM search_areas);
      `);
    } catch {
      // Ignore migration errors
    }

    // The search table must exist and use the trigram tokenizer. Building it
    // (or replacing an older one) is a single transaction: an interrupted
    // build used to leave an empty trigram table behind, which nothing ever
    // filled again -- the indexer skips unchanged documents -- so every
    // document indexed before stayed unsearchable. Now it rolls back and the
    // next start builds it again. IMMEDIATE takes the write lock first, so
    // the main process and the indexer thread cannot both build it.
    const readFtsTable = () => this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'
    `).get() as { sql: string } | undefined;
    const isTrigram = (table: { sql: string } | undefined) => table !== undefined && table.sql.toLowerCase().includes('trigram');

    if (!isTrigram(readFtsTable())) {
      this.db.transaction(() => {
        const ftsTable = readFtsTable();
        if (isTrigram(ftsTable)) return;
        if (ftsTable) {
          // Drop existing non-trigram FTS table and recreate with trigram
          this.db.exec(`DROP TABLE documents_fts;`);
        }
        this.createAndPopulateFtsTable();
      }).immediate();
    }

    this.disableFtsSecureDelete();
  }

  // FTS5's own 'secure-delete' option was tried and dropped: on a 5,000
  // document index it made one delete 60x slower (a 50-document batch held
  // the write lock for seconds, long enough for a setting written by the
  // main process to fail with SQLITE_BUSY). compactSearchIndex removes the
  // same leftovers in short steps instead. The option is stored in the index
  // itself, so a test profile that had it is switched back here.
  private disableFtsSecureDelete() {
    const row = this.db.prepare(
      "SELECT v FROM documents_fts_config WHERE k = 'secure-delete'"
    ).get() as { v: number } | undefined;
    if (row?.v !== 1) return;
    this.db.prepare(
      "INSERT INTO documents_fts(documents_fts, rank) VALUES('secure-delete', 0)"
    ).run();
  }

  /**
   * FTS5 only marks a deleted document's entries as deleted and keeps them
   * until its segments are merged: with the trigram tokenizer that is most
   * of the document's text, in pieces, with positions. This merges all
   * segments together in small steps (each its own short write, a few ms to
   * a few tens of ms), which drops those entries, until there is nothing left
   * to merge or the time budget is spent. Returns whether it finished.
   * Measured: 1.2 s in all after deleting 1,000 of 5,000 documents.
   */
  public compactSearchIndex(budgetMs = 60_000): boolean {
    const merge = this.db.prepare("INSERT INTO documents_fts(documents_fts, rank) VALUES('merge', -16)");
    const changes = this.db.prepare('SELECT total_changes() AS n');
    const started = Date.now();
    for (;;) {
      const before = (changes.get() as { n: number }).n;
      merge.run();
      // Fewer than two changed rows: nothing was left to merge.
      if ((changes.get() as { n: number }).n - before < 2) return true;
      if (Date.now() - started > budgetMs) return false;
    }
  }

  /**
   * Gives the space of the write-ahead log back once a batch of documents has
   * been deleted, so their old pages do not stay in the -wal file until the
   * next automatic checkpoint. Best effort: a reader still using an older
   * snapshot keeps part of the log until it finishes.
   */
  public truncateWriteAheadLog(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Busy: the next checkpoint does it.
    }
  }

  private createAndPopulateFtsTable() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        filename,
        content,
        tokenize = 'trigram'
      );
    `);

    // Repopulate from documents if any documents already exist in DB
    const docs = this.db.prepare(`
      SELECT id, filename, content, index_status FROM documents
    `).all() as { id: number; filename: string; content: string; index_status: string }[];

    if (docs.length > 0) {
      const insertStmt = this.db.prepare(`
        INSERT INTO documents_fts (rowid, filename, content)
        VALUES (?, ?, ?)
      `);
      const populateTx = this.db.transaction(() => {
        for (const doc of docs) {
          const content = doc.index_status === 'indexed' && doc.content ? normalizeForSearch(doc.content) : '';
          insertStmt.run(doc.id, normalizeForSearch(doc.filename), content);
        }
      });
      populateTx();
    }
  }

  public getAppSetting(key: string): string | undefined {
    try {
      const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  }

  public setAppSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  public getSearchScopeMode(): 'all' | 'selected' {
    const value = this.getAppSetting('search_scope_mode');
    if (value === 'all' || value === 'selected') {
      return value;
    }
    return 'all';
  }

  public setSearchScopeMode(mode: 'all' | 'selected'): void {
    if (mode !== 'all' && mode !== 'selected') return;
    this.setAppSetting('search_scope_mode', mode);
  }

  public isOnboardingCompleted(): boolean {
    return this.getAppSetting('onboarding_completed') === '1';
  }

  public setOnboardingCompleted(): void {
    this.setAppSetting('onboarding_completed', '1');
  }

  public getSearchAreas(): SearchAreaRecord[] {
    const rows = this.db.prepare('SELECT path, type, added_at FROM search_areas ORDER BY added_at ASC').all() as {
      path: string;
      type: 'include' | 'exclude';
      added_at: number;
    }[];
    return rows;
  }

  public getIncludedFolders(): string[] {
    const rows = this.db.prepare("SELECT path FROM search_areas WHERE type = 'include' ORDER BY added_at ASC").all() as { path: string }[];
    return rows.map(r => r.path);
  }

  public getExcludedFolders(): string[] {
    const rows = this.db.prepare("SELECT path FROM search_areas WHERE type = 'exclude' ORDER BY added_at ASC").all() as { path: string }[];
    return rows.map(r => r.path);
  }

  public addSearchArea(folderPath: string, type: 'include' | 'exclude'): void {
    const resolvedPath = path.resolve(folderPath);
    this.db.prepare(`
      INSERT INTO search_areas (path, type, added_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET type = excluded.type, added_at = excluded.added_at
    `).run(resolvedPath, type, Date.now());

    // Keep legacy folders table in sync for includes
    if (type === 'include') {
      this.db.prepare(`
        INSERT INTO folders (path, added_at)
        VALUES (?, ?)
        ON CONFLICT(path) DO NOTHING
      `).run(resolvedPath, Date.now());
    } else if (type === 'exclude') {
      this.db.prepare('DELETE FROM folders WHERE path = ?').run(resolvedPath);
      // Immediately purge indexed records inside this excluded area
      this.removeDocumentsInFolder(resolvedPath);
    }
  }

  public removeSearchArea(folderPath: string): void {
    const resolvedPath = path.resolve(folderPath);
    this.db.prepare('DELETE FROM search_areas WHERE path = ?').run(resolvedPath);
    this.db.prepare('DELETE FROM folders WHERE path = ?').run(resolvedPath);
  }

  public removeDocumentsInFolder(folderPath: string): void {
    const norm = path.resolve(folderPath);
    const deleteTx = this.db.transaction(() => {
      // Find all documents in this folder or its subfolders (supports / and \)
      const docs = this.db.prepare(`
        SELECT id FROM documents WHERE path = ? OR path LIKE ? OR path LIKE ?
      `).all(norm, `${norm}/%`, `${norm}\\%`) as { id: number }[];

      if (docs.length > 0) {
        const ids = docs.map(d => d.id);
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM documents_fts WHERE rowid IN (${placeholders})`).run(...ids);
        this.db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...ids);
      }
    });

    deleteTx();
  }

  public getFolders(): string[] {
    return this.getIncludedFolders();
  }

  public addFolder(folderPath: string): void {
    this.addSearchArea(folderPath, 'include');
  }

  public removeFolder(folderPath: string): void {
    const resolvedPath = path.resolve(folderPath);
    this.removeDocumentsInFolder(resolvedPath);
    this.removeSearchArea(resolvedPath);
  }

  public getDocumentByPath(docPath: string): DocumentRecord | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE path = ?').get(docPath) as DocumentRecord | undefined;
  }

  public getAllDocuments(): DocumentRecord[] {
    return this.db.prepare('SELECT * FROM documents').all() as DocumentRecord[];
  }

  // Path-only projection for reconciliation passes that never need the full
  // (potentially large) content column — avoids loading every document's
  // text into memory just to check which paths still exist on disk.
  public getAllDocumentPaths(): { path: string }[] {
    return this.db.prepare('SELECT path FROM documents').all() as { path: string }[];
  }

  // Count of indexed documents visible under the given scope, using the same
  // include/exclude precedence as isDocumentInScope (search.ts) so the
  // displayed count never diverges from what search() can actually return.
  public getInScopeDocumentCount(mode: 'all' | 'selected', includedPaths: string[], excludedPaths: string[]): number {
    if (mode === 'selected' && includedPaths.length === 0) {
      return 0;
    }

    const rows = this.db.prepare("SELECT path FROM documents WHERE index_status = 'indexed'").all() as { path: string }[];

    let count = 0;
    for (const row of rows) {
      if (this.isInScope(row.path, mode, includedPaths, excludedPaths)) count++;
    }
    return count;
  }

  // Mirrors isDocumentInScope (search.ts) so every count shown to the user
  // matches what search() can actually return; kept local (rather than
  // importing search.ts) to avoid a database.ts <-> search.ts import cycle.
  private isInScope(docPath: string, mode: 'all' | 'selected', includedPaths: string[], excludedPaths: string[]): boolean {
    if (excludedPaths.length > 0 && isPathExcluded(docPath, excludedPaths)) {
      return false;
    }
    if (mode === 'selected' && !includedPaths.some(folder => isPathOrSubpath(folder, docPath))) {
      return false;
    }
    return true;
  }

  // Whether there is anything to search at all. A search against an index
  // with no readable documents must not be reported as "no matches".
  public hasIndexedDocuments(): boolean {
    return this.db.prepare("SELECT 1 FROM documents WHERE index_status = 'indexed' LIMIT 1").get() !== undefined;
  }

  // Read-only breakdown behind "N belge indekslendi, M belge işlenemedi".
  // A document that failed extraction stays in the table with its status,
  // so "found nothing" and "could not read" can be told apart without
  // touching the indexer or the schema.
  public getInScopeStatusCounts(mode: 'all' | 'selected', includedPaths: string[], excludedPaths: string[]): ScopeStatusCounts {
    const counts: ScopeStatusCounts = { indexed: 0, failed: 0, noText: 0 };
    if (mode === 'selected' && includedPaths.length === 0) {
      return counts;
    }
    const rows = this.db.prepare('SELECT path, index_status FROM documents').all() as { path: string; index_status: string }[];
    for (const row of rows) {
      if (!this.isInScope(row.path, mode, includedPaths, excludedPaths)) continue;
      if (row.index_status === 'indexed') counts.indexed++;
      else if (row.index_status === 'failed') counts.failed++;
      else if (row.index_status === 'no_text') counts.noText++;
    }
    return counts;
  }

  // Behind "Metin tanımayla okunan / sırada bekleyen" in Settings › İndeks.
  public getInScopeOcrCounts(mode: 'all' | 'selected', includedPaths: string[], excludedPaths: string[]): OcrCounts {
    const counts: OcrCounts = { recognized: 0, pending: 0 };
    if (mode === 'selected' && includedPaths.length === 0) {
      return counts;
    }
    // A PDF without any text indexed before pages were checked one by one is
    // waiting too, until that check runs.
    const rows = this.db.prepare(`
      SELECT path, index_status, ocr FROM documents
      WHERE ocr IN ('text', 'pending') OR (extension = '.pdf' AND index_status = 'no_text' AND ocr IS NULL)
    `).all() as { path: string; index_status: string; ocr: OcrState | null }[];
    for (const row of rows) {
      if (!this.isInScope(row.path, mode, includedPaths, excludedPaths)) continue;
      if (row.ocr === 'text') counts.recognized++;
      else counts.pending++;
    }
    return counts;
  }

  // The documents behind the "işlenemedi" count, so the user can see which
  // ones they are when they need to (Settings › İndeks).
  public getUnreadableDocuments(
    mode: 'all' | 'selected',
    includedPaths: string[],
    excludedPaths: string[],
    limit: number = 200
  ): UnreadableDocument[] {
    if (mode === 'selected' && includedPaths.length === 0) {
      return [];
    }
    const rows = this.db.prepare(`
      SELECT path, filename, index_status FROM documents
      WHERE index_status IN ('failed', 'no_text')
      ORDER BY filename COLLATE NOCASE
    `).all() as { path: string; filename: string; index_status: 'failed' | 'no_text' }[];

    const result: UnreadableDocument[] = [];
    for (const row of rows) {
      if (!this.isInScope(row.path, mode, includedPaths, excludedPaths)) continue;
      result.push({ path: row.path, filename: row.filename, status: row.index_status });
      if (result.length >= limit) break;
    }
    return result;
  }

  public getDocumentsInFolder(folderPath: string): DocumentRecord[] {
    return this.db.prepare(`
      SELECT * FROM documents WHERE path = ? OR path LIKE ? OR path LIKE ?
    `).all(folderPath, `${folderPath}/%`, `${folderPath}\\%`) as DocumentRecord[];
  }

  public upsertDocument(doc: DocumentRecord): void {
    const upsertTx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(doc.path) as { id: number } | undefined;
      const now = Date.now();

      let rowId: number;
      if (existing) {
        rowId = existing.id;
        this.db.prepare(`
          UPDATE documents
          SET filename = ?, extension = ?, mtime = ?, size = ?, content = ?, index_status = ?, indexed_at = ?, ocr = ?
          WHERE id = ?
        `).run(doc.filename, doc.extension, doc.mtime, doc.size, doc.content, doc.index_status, now, doc.ocr ?? null, rowId);

        // Delete from FTS first to update
        this.db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(rowId);
      } else {
        const info = this.db.prepare(`
          INSERT INTO documents (path, filename, extension, mtime, size, content, index_status, indexed_at, ocr)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(doc.path, doc.filename, doc.extension, doc.mtime, doc.size, doc.content, doc.index_status, now, doc.ocr ?? null);
        rowId = Number(info.lastInsertRowid);
      }

      // Insert normalized content into FTS table if indexed
      if (doc.index_status === 'indexed' && doc.content) {
        this.db.prepare(`
          INSERT INTO documents_fts (rowid, filename, content)
          VALUES (?, ?, ?)
        `).run(
          rowId,
          normalizeForSearch(doc.filename),
          normalizeForSearch(doc.content)
        );
      } else if (doc.index_status === 'no_text' || doc.index_status === 'failed') {
        // Still index filename so user can find file by name
        this.db.prepare(`
          INSERT INTO documents_fts (rowid, filename, content)
          VALUES (?, ?, ?)
        `).run(
          rowId,
          normalizeForSearch(doc.filename),
          ''
        );
      }
    });

    upsertTx();
  }

  /**
   * Records a document whose reading had to be stopped (it overran its time
   * or brought the indexer down) so later updates do not try it again unless
   * the user asks. A document whose text is already in the index and has not
   * changed keeps that text; only its text recognition is marked as failed.
   */
  public markDocumentUnreadable(file: Pick<DocumentRecord, 'path' | 'filename' | 'extension' | 'mtime' | 'size'>): void {
    const existing = this.db.prepare('SELECT mtime, size, index_status FROM documents WHERE path = ?')
      .get(file.path) as { mtime: number; size: number; index_status: string } | undefined;
    if (existing && existing.mtime === file.mtime && existing.size === file.size && existing.index_status !== 'failed') {
      this.db.prepare("UPDATE documents SET ocr = 'failed' WHERE path = ?").run(file.path);
      return;
    }
    this.upsertDocument({ ...file, content: '', index_status: 'failed', ocr: null });
  }

  // A point lookup on the unique path index: no document text is read.
  public hasDocument(docPath: string): boolean {
    return this.db.prepare('SELECT 1 FROM documents WHERE path = ? LIMIT 1').get(docPath) !== undefined;
  }

  public deleteDocuments(paths: string[]): void {
    if (paths.length === 0) return;

    const deleteBatch = this.db.transaction((batch: string[]) => {
      const placeholders = batch.map(() => '?').join(',');
      const docs = this.db.prepare(`SELECT id FROM documents WHERE path IN (${placeholders})`).all(...batch) as { id: number }[];

      if (docs.length > 0) {
        const ids = docs.map(d => d.id);
        const idPlaceholders = ids.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM documents_fts WHERE rowid IN (${idPlaceholders})`).run(...ids);
        this.db.prepare(`DELETE FROM documents WHERE id IN (${idPlaceholders})`).run(...ids);
      }
    });

    for (let i = 0; i < paths.length; i += DELETE_BATCH) {
      deleteBatch(paths.slice(i, i + DELETE_BATCH));
    }
  }

  public close(): void {
    this.db.close();
  }
}
