// An update stops between documents when the main process asks (the search
// areas changed under it), and "Dizini sil ve yeniden oluştur" empties the
// index, leaving settings alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';

let base: string;
let docs: string;
let db: AppDatabase;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbrestart-')));
  docs = path.join(base, 'Belgeler');
  fs.mkdirSync(docs);
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(docs, `dilekçe ${i}.udf`), `<udf>tazminat davası ${i}</udf>`);
  db = new AppDatabase(path.join(base, 'index.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('an update asked to stop', () => {
  it('stops before the next document and leaves the rest for the update that follows', async () => {
    let read = 0;
    const summary = await indexFolders([docs], db, undefined, [], [], {
      onReading: () => { read++; },
      shouldStop: () => read >= 2
    });
    expect(read).toBe(2);
    expect(summary.indexed).toBe(2);
    expect(db.getAllDocumentPaths()).toHaveLength(2);

    const next = await indexFolders([docs], db);
    expect(next.indexed).toBe(3);
    expect(db.getAllDocumentPaths()).toHaveLength(5);
  });
});

describe('emptying the index', () => {
  it('removes every document and its searchable text, and keeps the settings', async () => {
    db.setSearchScopeMode('selected');
    db.addSearchArea(docs, 'include');
    db.setAppSetting('theme', 'dark');
    await indexFolders([docs], db);
    expect(search('tazminat', db)).toHaveLength(5);

    // Enough text for the file to have something to give back.
    for (let i = 0; i < 300; i++) {
      db.upsertDocument({ path: path.join(base, `ek ${i}.udf`), filename: `ek ${i}.udf`, extension: '.udf', mtime: i, size: 1, content: 'ecrimisil davası '.repeat(150), index_status: 'indexed' });
    }
    const pagesBefore = db.db.pragma('page_count', { simple: true }) as number;
    db.clearDocuments();

    // Compacted: fewer pages, none of them free.
    expect(db.db.pragma('page_count', { simple: true }) as number).toBeLessThan(pagesBefore);
    expect(db.db.pragma('freelist_count', { simple: true })).toBe(0);
    expect(db.getAllDocumentPaths()).toHaveLength(0);
    expect(search('tazminat', db)).toHaveLength(0);
    expect((db.db.prepare('SELECT count(*) AS n FROM documents_fts').get() as { n: number }).n).toBe(0);
    expect(db.getIncludedFolders()).toEqual([docs]);
    expect(db.getAppSetting('theme')).toBe('dark');

    // And the next update reads everything again.
    expect((await indexFolders([docs], db)).indexed).toBe(5);
    expect(search('tazminat', db)).toHaveLength(5);
  });
});
