import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { AppDatabase, normalizeForSearch } from '../../src/db/database.js';
import { search } from '../../src/search/search.js';
import { indexFolders } from '../../src/search/indexer.js';
import { setupFixtures, FIXTURES_DIR } from '../fixtures/create_fixtures.js';

describe('Search & Indexing Engine (Phase 2)', () => {
  let db: AppDatabase;
  const testWorkspaceDir = path.join(FIXTURES_DIR, 'test_index_ws');

  beforeAll(() => {
    setupFixtures();
  });

  beforeEach(() => {
    db = new AppDatabase(':memory:');
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testWorkspaceDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
  });

  describe('Turkish Character Normalization & Search', () => {
    it('should correctly normalize Turkish casing pairs', () => {
      expect(normalizeForSearch('İSTANBUL')).toBe('istanbul');
      expect(normalizeForSearch('İŞ')).toBe('iş');
      expect(normalizeForSearch('IĞDIR')).toBe('ığdır');
      expect(normalizeForSearch('ŞÖFÖR')).toBe('şöför');
      expect(normalizeForSearch('AĞAÇ')).toBe('ağaç');
      expect(normalizeForSearch('ÇİÇEK')).toBe('çiçek');
      expect(normalizeForSearch('ILIK')).toBe('ılık');
      expect(normalizeForSearch('İNCİR')).toBe('incir');
    });

    it('should match Turkish uppercase and lowercase across all variants in FTS5', () => {
      db.upsertDocument({
        path: '/test/karar1.docx',
        filename: 'karar1.docx',
        extension: '.docx',
        mtime: 1000,
        size: 500,
        content: 'T.C. İSTANBUL Bölge Adliye Mahkemesi İş Hukuku Dairesi ve IĞDIR dosyası şöför ağaç çiçek ılık incir.',
        index_status: 'indexed'
      });

      const queries = [
        { q: 'istanbul', expected: 1 },
        { q: 'İSTANBUL', expected: 1 },
        { q: 'iş hukuku', expected: 1 },
        { q: 'İŞ HUKUKU', expected: 1 },
        { q: 'ığdır', expected: 1 },
        { q: 'IĞDIR', expected: 1 },
        { q: 'şöför', expected: 1 },
        { q: 'ŞÖFÖR', expected: 1 },
        { q: 'ağaç', expected: 1 },
        { q: 'AĞAÇ', expected: 1 },
        { q: 'çiçek', expected: 1 },
        { q: 'ÇİÇEK', expected: 1 },
        { q: 'ılık', expected: 1 },
        { q: 'ILIK', expected: 1 },
        { q: 'incir', expected: 1 },
        { q: 'İNCİR', expected: 1 },
        { q: 'bulunmayan_kelime', expected: 0 }
      ];

      for (const { q, expected } of queries) {
        const results = search(q, db);
        expect(results.length, `Expected query "${q}" to return ${expected} match`).toBe(expected);
      }
    });

    it('should perform arbitrary substring / infix matching on Yargıtay Hukuk Genel Kurulu fixture', () => {
      db.upsertDocument({
        path: '/test/yargitay.docx',
        filename: 'yargitay.docx',
        extension: '.docx',
        mtime: 1000,
        size: 500,
        content: 'Yargıtay Hukuk Genel Kurulu emsal kararı ve gerekçesi.',
        index_status: 'indexed'
      });

      const passQueries = [
        'Yargıtay',
        'yargıtay',
        'gıtay',
        'argıt',
        'gıtay hukuk',
        'uk genel',
        'genel kurul',
        'nel kurul'
      ];

      for (const q of passQueries) {
        const res = search(q, db);
        expect(res.length, `Expected match for substring query "${q}"`).toBe(1);
        expect(res[0].snippet).toContain('<mark>');
      }

      const negativeQueries = [
        'xyz',
        'hukuk xyz',
        'anadolu',
        'gıtayzzz'
      ];

      for (const q of negativeQueries) {
        const res = search(q, db);
        expect(res.length, `Expected NO match for query "${q}"`).toBe(0);
      }
    });

    it('should perform arbitrary substring / infix matching on Raci Çetin Yüksekbaş fixture', () => {
      db.upsertDocument({
        path: '/test/vekalet.pdf',
        filename: 'vekalet.pdf',
        extension: '.pdf',
        mtime: 1000,
        size: 400,
        content: 'Bu belge Raci Çetin Yüksekbaş tarafından düzenlenmiştir.',
        index_status: 'indexed'
      });

      const passQueries = [
        'raci çetin yüksekbaş',
        'çetin yüksekbaş',
        'tin yüksekbaş',
        'tin yüksek',
        'yüksekbaş',
        'sekbaş'
      ];

      for (const q of passQueries) {
        const res = search(q, db);
        expect(res.length, `Expected match for substring query "${q}"`).toBe(1);
        expect(res[0].snippet).toContain('<mark>');
      }
    });

    it('should correctly match Turkish casing on İstanbul Bölge Adliye Mahkemesi fixture', () => {
      db.upsertDocument({
        path: '/test/istinaf.udf',
        filename: 'istinaf.udf',
        extension: '.udf',
        mtime: 1000,
        size: 600,
        content: 'İstanbul Bölge Adliye Mahkemesi 4. Hukuk Dairesi kararı.',
        index_status: 'indexed'
      });

      const passQueries = [
        'istanbul',
        'İSTANBUL',
        'bölge adliye',
        'BÖLGE ADLİYE',
        'adliye mahkemesi',
        'ADLİYE MAHKEMESİ',
        'ye mahke'
      ];

      for (const q of passQueries) {
        const res = search(q, db);
        expect(res.length, `Expected match for query "${q}"`).toBe(1);
      }
    });
  });

  describe('Full Folder Indexing & Search Results', () => {
    it('should index fixture folder and find content in DOCX, PDF and UDF files', async () => {
      // Copy fixtures into test workspace
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(testWorkspaceDir, 'karar.docx'));
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), path.join(testWorkspaceDir, 'dilekce.pdf'));
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.udf'), path.join(testWorkspaceDir, 'ilam.udf'));

      const summary = await indexFolders([testWorkspaceDir], db);
      expect(summary.scanned).toBe(3);
      expect(summary.indexed).toBe(3);
      expect(summary.failed).toBe(0);

      // Search DOCX text
      const docxRes = search('tazminatı', db);
      expect(docxRes.length).toBe(1);
      expect(docxRes[0].filename).toBe('karar.docx');
      expect(docxRes[0].snippet).toContain('tazminatı');

      // Search PDF text
      const pdfRes = search('ankara', db);
      expect(pdfRes.length).toBe(1);
      expect(pdfRes[0].filename).toBe('dilekce.pdf');

      // Search UDF text
      const udfRes = search('haczedilmezlik', db);
      expect(udfRes.length).toBe(1);
      expect(udfRes[0].filename).toBe('ilam.udf');
      expect(udfRes[0].snippet).toContain('haczedilmezlik');
      // Real extraction, and the first use of the PDF engine in this run: on a
      // Windows runner shared with every other test file this has taken 11 s.
    }, 30_000);

    it('should perform incremental indexing and skip unchanged files', async () => {
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(testWorkspaceDir, 'karar.docx'));

      // First index run
      const summary1 = await indexFolders([testWorkspaceDir], db);
      expect(summary1.indexed).toBe(1);
      expect(summary1.skipped).toBe(0);

      // Second index run (no changes)
      const summary2 = await indexFolders([testWorkspaceDir], db);
      expect(summary2.indexed).toBe(0);
      expect(summary2.skipped).toBe(1);
    });

    it('should remove deleted files from index', async () => {
      const docPath = path.join(testWorkspaceDir, 'silinecek.docx');
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), docPath);

      await indexFolders([testWorkspaceDir], db);
      expect(search('tazminatı', db).length).toBe(1);

      // Delete file from disk
      fs.unlinkSync(docPath);

      // Re-index
      const summary = await indexFolders([testWorkspaceDir], db);
      expect(summary.removed).toBe(1);
      expect(search('tazminatı', db).length).toBe(0);
    });

    it('should handle corrupted files without crashing the scanner', async () => {
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(testWorkspaceDir, 'valid.docx'));
      fs.copyFileSync(path.join(FIXTURES_DIR, 'corrupt.pdf'), path.join(testWorkspaceDir, 'corrupt.pdf'));

      const summary = await indexFolders([testWorkspaceDir], db);
      expect(summary.scanned).toBe(2);
      expect(summary.indexed).toBe(1);
      expect(summary.failed).toBe(1);

      // Valid doc should still be searchable
      expect(search('tazminatı', db).length).toBe(1);
    });

    it('should safely handle malformed or special character queries', () => {
      const maliciousQueries = [
        '""',
        '***',
        'NEAR(tazminat, 5)',
        'NOT AND OR',
        'karar::column',
        '{invalid json fts}',
        '   ',
        'çalışma) (AND'
      ];

      for (const q of maliciousQueries) {
        expect(() => search(q, db)).not.toThrow();
      }
    });

    it('should limit search results to maximum 100 items', () => {
      for (let i = 0; i < 150; i++) {
        db.upsertDocument({
          path: `/path/doc_${i}.docx`,
          filename: `doc_${i}.docx`,
          extension: '.docx',
          mtime: 1000 + i,
          size: 200,
          content: 'Ortak arama metni ve içerik',
          index_status: 'indexed'
        });
      }

      const results = search('ortak', db);
      expect(results.length).toBe(100);
    });

    it('should safely migrate legacy FTS table to trigram on initialization', () => {
      // Create a temporary database with legacy unicode61 FTS5 table
      const legacyDb = new AppDatabase(':memory:');
      
      // Simulate legacy schema
      legacyDb.db.exec(`
        DROP TABLE documents_fts;
        CREATE VIRTUAL TABLE documents_fts USING fts5(
          filename,
          content,
          tokenize = 'unicode61 remove_diacritics 0'
        );
      `);

      legacyDb.upsertDocument({
        path: '/test/legacy.docx',
        filename: 'legacy.docx',
        extension: '.docx',
        mtime: 1000,
        size: 300,
        content: 'Yargıtay Hukuk Genel Kurulu kararları burada yer alır.',
        index_status: 'indexed'
      });

      // Close and re-open to trigger initSchema migration
      // Since it's in-memory, we test the schema migration directly on the instance:
      const ftsSql = legacyDb.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'").get() as { sql: string };
      expect(ftsSql.sql.toLowerCase()).not.toContain('trigram');

      // Now trigger migration logic by calling private initSchema via new instance or directly
      legacyDb['initSchema']();

      const newFtsSql = legacyDb.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents_fts'").get() as { sql: string };
      expect(newFtsSql.sql.toLowerCase()).toContain('trigram');

      // Substring search should now work on migrated legacy documents
      const res = search('gıtay', legacyDb);
      expect(res.length).toBe(1);
      expect(res[0].filename).toBe('legacy.docx');
      expect(res[0].snippet).toContain('<mark>');

      legacyDb.close();
    });

    it('should allow searching while indexing is in progress', async () => {
      // Pre-seed some docs
      db.upsertDocument({
        path: '/test/seed.docx',
        filename: 'seed.docx',
        extension: '.docx',
        mtime: 100,
        size: 100,
        content: 'İlk indekslenen tazminat kararı.',
        index_status: 'indexed'
      });

      // Create test file to be indexed
      const newFile = path.join(testWorkspaceDir, 'new_file.docx');
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), newFile);

      let searchedDuringProgress = false;
      let resultsFoundDuringIndexing: any[] = [];

      await indexFolders([testWorkspaceDir], db, (progress) => {
        if (progress.status === 'indexing') {
          // Perform search concurrently while indexing is actively running
          resultsFoundDuringIndexing = search('tazminat', db);
          searchedDuringProgress = true;
        }
      });

      expect(searchedDuringProgress).toBe(true);
      expect(resultsFoundDuringIndexing.length).toBeGreaterThanOrEqual(1);
      expect(resultsFoundDuringIndexing[0].filename).toBe('seed.docx');
    });
  });
});
