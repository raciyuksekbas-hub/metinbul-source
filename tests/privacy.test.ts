import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { AppDatabase } from '../src/db/database.js';
import { search } from '../src/search/search.js';
import { FIXTURES_DIR } from './fixtures/create_fixtures.js';

describe('Privacy & Search Query Zero-Persistence (v0.2.0 Section H)', () => {
  let db: AppDatabase;
  const tempDbPath = path.join(FIXTURES_DIR, 'privacy_test.db');

  beforeEach(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    db = new AppDatabase(tempDbPath);
    // Add sample doc
    db.upsertDocument({
      path: '/test/secret_doc.docx',
      filename: 'secret_doc.docx',
      extension: '.docx',
      mtime: Date.now(),
      size: 100,
      content: 'Müvekkil Ahmet Yılmaz TC 12345678901 hakkında gizli ticari dava dosyası.',
      index_status: 'indexed'
    });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  });

  it('should NEVER persist search queries or search history into database', () => {
    // Check initial tables
    const initialTables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(initialTables).not.toContain('query_history');
    expect(initialTables).not.toContain('search_logs');
    expect(initialTables).not.toContain('telemetry');

    // Run confidential searches
    search('12345678901', db);
    search('Ahmet Yılmaz', db);
    search('gizli ticari dava', db);
    search('bulunamayan_cok_gizli_ifade', db);

    // Verify no new tables created
    const postTables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(postTables).toEqual(initialTables);

    // Verify app_settings has no query entries
    const settings = db.db.prepare('SELECT * FROM app_settings').all();
    for (const row of settings as any[]) {
      expect(row.key).not.toContain('query');
      expect(row.value).not.toContain('12345678901');
      expect(row.value).not.toContain('Ahmet');
    }
  });

  it('Quick Search reuses this same search() with no separate persistence path (spec §6, §12)', () => {
    // Quick Search (src/renderer/quick-search.ts) calls window.api.search(),
    // which is the exact same app:search IPC -> search() function exercised
    // above -- there is no separate query-logging code path for it to have.
    // This is a static-source guard against a future regression introducing
    // one (e.g. writing the query to app_settings or localStorage).
    const quickSearchSrc = fs.readFileSync(
      path.join(FIXTURES_DIR, '..', '..', 'src/renderer/quick-search.ts'),
      'utf8'
    );
    // Check for actual write calls, not just the word (which appears in this
    // file's own explanatory comment above).
    expect(quickSearchSrc).not.toMatch(/localStorage\s*[.[]\s*(setItem|set)/);
    expect(quickSearchSrc).not.toMatch(/setAppSetting|app_settings|query_history|search_logs/);
  });
});
