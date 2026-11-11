import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import { setupFixtures, FIXTURES_DIR } from './fixtures/create_fixtures.js';

describe('MetinBul End-to-End Smoke Test', () => {
  let db: AppDatabase;
  const tempDbPath = path.join(FIXTURES_DIR, 'smoke_test.db');
  const tempDocsDir = path.join(FIXTURES_DIR, 'smoke_docs');

  beforeAll(() => {
    setupFixtures();
  });

  beforeEach(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDocsDir)) fs.rmSync(tempDocsDir, { recursive: true, force: true });
    fs.mkdirSync(tempDocsDir, { recursive: true });
    db = new AppDatabase(tempDbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDocsDir)) fs.rmSync(tempDocsDir, { recursive: true, force: true });
  });

  it('verifies complete lifecycle: add folder -> index -> search -> Turkish query -> remove folder', async () => {
    // 1. Add folder to DB
    db.addFolder(tempDocsDir);
    expect(db.getFolders()).toContain(tempDocsDir);

    // 2. Place documents (DOCX, PDF, UDF)
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(tempDocsDir, 'mahkeme_karari.docx'));
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), path.join(tempDocsDir, 'dava_dilekcesi.pdf'));
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.udf'), path.join(tempDocsDir, 'uyap_belgesi.udf'));

    // 3. Index folders
    const summary = await indexFolders(db.getFolders(), db);
    expect(summary.scanned).toBe(3);
    expect(summary.indexed).toBe(3);

    // 4. Search in DOCX
    const resDocx = search('İSTANBUL', db);
    expect(resDocx.length).toBe(1);
    expect(resDocx[0].filename).toBe('mahkeme_karari.docx');
    expect(resDocx[0].extension).toBe('.docx');
    expect(resDocx[0].snippet).toContain('<mark>');

    // 5. Search in PDF
    const resPdf = search('ANKARA', db);
    expect(resPdf.length).toBe(1);
    expect(resPdf[0].filename).toBe('dava_dilekcesi.pdf');
    expect(resPdf[0].extension).toBe('.pdf');

    // 6. Search in UDF
    const resUdf = search('İZMİR', db);
    expect(resUdf.length).toBe(1);
    expect(resUdf[0].filename).toBe('uyap_belgesi.udf');
    expect(resUdf[0].extension).toBe('.udf');

    // 7. Remove folder and verify documents are purged
    db.removeFolder(tempDocsDir);
    expect(db.getFolders()).not.toContain(tempDocsDir);
    expect(search('İSTANBUL', db).length).toBe(0);
    expect(search('ANKARA', db).length).toBe(0);
    expect(search('İZMİR', db).length).toBe(0);
  });
});
