// A search used to read the full text of every match -- up to a thousand
// documents -- before it could answer, which took seconds on a large index.
// Finding and ordering the matches must not touch their text; only the
// documents actually shown are read, one at a time.
import { describe, it, expect } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { search } from '../src/search/search.js';
import { runSearch } from '../src/search/search-outcome.js';

function indexWith(paths: string[]): AppDatabase {
  const db = new AppDatabase(':memory:');
  paths.forEach((path, i) => db.upsertDocument({
    path,
    filename: `belge ${i}.docx`,
    extension: '.docx',
    mtime: i + 1,
    size: 1,
    content: `Bu dosyada hukuki mücadele anlatılmaktadır, sıra ${i}.`,
    index_status: 'indexed'
  }));
  return db;
}

// Records every statement the search prepares, and which documents' text it
// reads. `hide` makes a document look deleted by the time its text is read.
function watch(db: AppDatabase, hide: (id: number) => boolean = () => false) {
  const statements: string[] = [];
  const textOf: number[] = [];
  const prepare = db.db.prepare.bind(db.db);
  db.db.prepare = ((sql: string) => {
    statements.push(sql);
    const statement = prepare(sql);
    if (!/\bcontent\b/.test(sql) || /MATCH/.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== 'get') return Reflect.get(target, property);
        return (id: number) => {
          textOf.push(id);
          return hide(id) ? undefined : target.get(id);
        };
      }
    });
  }) as typeof db.db.prepare;
  return { statements, textOf };
}

const inFolder = (folder: string, count: number) => Array.from({ length: count }, (_, i) => `/${folder}/belge-${i}.docx`);

describe('what a search reads', () => {
  it('finds and orders the matches without reading their text', () => {
    const db = indexWith(inFolder('a', 40));
    const { statements } = watch(db);
    expect(search('mücadele', db, 10)).toHaveLength(10);
    expect(search('mücadele', db, 10, undefined, 'relevance')).toHaveLength(10);
    expect(search('mücadele', db, 10, undefined, 'oldest')).toHaveLength(10);
    const matching = statements.filter(sql => /MATCH/.test(sql));
    expect(matching).toHaveLength(3);
    for (const sql of matching) {
      expect(sql).not.toMatch(/\bcontent\b/);
      // These sit after the text in the row: reading them walks through it.
      expect(sql).not.toMatch(/\b(index_status|indexed_at|ocr)\b/);
    }
  });

  it('reads the text only of the documents it shows', () => {
    const db = indexWith(inFolder('a', 40));
    const { textOf } = watch(db);
    const results = search('mücadele', db, 10);
    expect(results.map(r => r.filename)).toEqual(Array.from({ length: 10 }, (_, i) => `belge ${39 - i}.docx`));
    expect(textOf).toHaveLength(10);
    expect(results[0].snippet).toContain('<mark>mücadele</mark>');
    expect(results[0].index_status).toBe('indexed');
  });

  it('does not read the text of documents outside the search area', () => {
    const db = indexWith([...inFolder('a', 5), ...inFolder('b', 30)]);
    const { textOf } = watch(db);
    const results = search('mücadele', db, 100, { mode: 'selected', includedPaths: ['/a'], excludedPaths: [] });
    expect(results).toHaveLength(5);
    expect(textOf).toHaveLength(5);
  });

  it('skips a document that disappeared after it was found', () => {
    const db = indexWith(inFolder('a', 5));
    const gone = (db.db.prepare('SELECT id FROM documents ORDER BY mtime DESC LIMIT 1').get() as { id: number }).id;
    watch(db, id => id === gone);
    const results = search('mücadele', db, 100);
    expect(results.map(r => r.id)).not.toContain(gone);
    expect(results).toHaveLength(4);
  });
});

describe('stopping a search', () => {
  const stopAfter = (checks: number) => {
    let count = 0;
    return () => ++count > checks;
  };

  it('stops between documents', () => {
    const db = indexWith(inFolder('a', 40));
    const { textOf } = watch(db);
    expect(search('mücadele', db, 100, undefined, 'modified', stopAfter(3))).toHaveLength(3);
    expect(textOf).toHaveLength(3);
  });

  it('is reported as replaced, never as an answer', () => {
    const db = indexWith(inFolder('a', 40));
    expect(runSearch('mücadele', db, { shouldStop: stopAfter(3) })).toEqual({ state: 'superseded', results: [] });
    expect(runSearch('mücadele', db, { shouldStop: () => false }).state).toBe('success');
  });
});
