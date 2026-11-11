import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { search } from '../src/search/search.js';

describe('Result Sorting — Modified Date (spec §7)', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, mtime: number, content: string = 'tazminat davası açıldı') {
    db.upsertDocument({
      path,
      filename: path.split('/').pop() || path,
      extension: '.docx',
      mtime,
      size: content.length,
      content,
      index_status: 'indexed'
    });
  }

  it('defaults to newest-first (mtime DESC) when no sort is specified', () => {
    seed('/docs/oldest.docx', 1000);
    seed('/docs/newest.docx', 3000);
    seed('/docs/middle.docx', 2000);

    const results = search('tazminat', db);
    expect(results.map(r => r.path)).toEqual(['/docs/newest.docx', '/docs/middle.docx', '/docs/oldest.docx']);
    expect(results.map(r => r.mtime)).toEqual([3000, 2000, 1000]);
  });

  it('"modified" sort explicitly returns newest first', () => {
    seed('/docs/a.docx', 500);
    seed('/docs/b.docx', 1500);

    const results = search('tazminat', db, 100, undefined, 'modified');
    expect(results.map(r => r.path)).toEqual(['/docs/b.docx', '/docs/a.docx']);
  });

  it('"oldest" sort returns oldest first', () => {
    seed('/docs/a.docx', 500);
    seed('/docs/b.docx', 1500);
    seed('/docs/c.docx', 1000);

    const results = search('tazminat', db, 100, undefined, 'oldest');
    expect(results.map(r => r.path)).toEqual(['/docs/a.docx', '/docs/c.docx', '/docs/b.docx']);
  });

  it('"relevance" sort uses FTS5 rank rather than mtime', () => {
    // A document repeating the query term is a stronger relevance match
    // than one mentioning it once, regardless of which is newer.
    seed('/docs/weak.docx', 5000, 'tazminat bir kez geçiyor burada.');
    seed('/docs/strong.docx', 1000, 'tazminat tazminat tazminat tazminat davası tazminat.');

    const relevance = search('tazminat', db, 100, undefined, 'relevance');
    const modified = search('tazminat', db, 100, undefined, 'modified');

    expect(relevance.map(r => r.path)[0]).toBe('/docs/strong.docx');
    expect(modified.map(r => r.path)[0]).toBe('/docs/weak.docx'); // newer, despite weaker relevance
  });

  it('ties (identical mtime) resolve in a stable, deterministic order (by document id)', () => {
    const sameMtime = 42000;
    seed('/docs/first.docx', sameMtime);
    seed('/docs/second.docx', sameMtime);
    seed('/docs/third.docx', sameMtime);

    const run1 = search('tazminat', db, 100, undefined, 'modified').map(r => r.path);
    const run2 = search('tazminat', db, 100, undefined, 'modified').map(r => r.path);
    const run3 = search('tazminat', db, 100, undefined, 'oldest').map(r => r.path);

    expect(run1).toEqual(run2);
    expect(run1).toEqual(run3); // same tie-break order regardless of DESC/ASC on the tied field
  });

  it('does not confuse "indexed_at" (DB write time) with the document\'s own mtime for sorting', () => {
    // Index an old file (small mtime) after a recently-modified one
    // (larger mtime) -- write order into the DB must not affect sort order.
    seed('/docs/recently_modified.docx', 9000);
    seed('/docs/old_file_indexed_later.docx', 1000);

    const results = search('tazminat', db, 100, undefined, 'modified');
    expect(results[0].path).toBe('/docs/recently_modified.docx');
  });
});
