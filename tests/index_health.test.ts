import { describe, it, expect, beforeEach } from 'vitest';
import { AppDatabase, DocumentRecord } from '../src/db/database.js';

function doc(path: string, status: DocumentRecord['index_status']): DocumentRecord {
  const filename = path.split('/').pop() || path;
  return {
    path,
    filename,
    extension: '.' + (filename.split('.').pop() || ''),
    mtime: 1,
    size: 1,
    content: status === 'indexed' ? `içerik ${filename}` : '',
    index_status: status
  };
}

describe('Index health — read-only scope counts (Settings › İndeks)', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
    db.upsertDocument(doc('/Users/a/Dava/dilekce.docx', 'indexed'));
    db.upsertDocument(doc('/Users/a/Dava/rapor.pdf', 'indexed'));
    db.upsertDocument(doc('/Users/a/Dava/bozuk.docx', 'failed'));
    db.upsertDocument(doc('/Users/a/Dava/taranmis.pdf', 'no_text'));
    db.upsertDocument(doc('/Users/a/Arsiv/eski.udf', 'indexed'));
    db.upsertDocument(doc('/Users/a/Arsiv/kirik.pdf', 'failed'));
  });

  it('separates indexed, failed and text-less documents', () => {
    expect(db.getInScopeStatusCounts('all', [], [])).toEqual({ indexed: 3, failed: 2, noText: 1 });
  });

  it('agrees with the existing indexed-document count under every scope', () => {
    const scopes: ['all' | 'selected', string[], string[]][] = [
      ['all', [], []],
      ['all', [], ['/Users/a/Arsiv']],
      ['selected', ['/Users/a/Dava'], []],
      ['selected', ['/Users/a'], ['/Users/a/Dava']]
    ];
    for (const [mode, inc, exc] of scopes) {
      expect(db.getInScopeStatusCounts(mode, inc, exc).indexed).toBe(db.getInScopeDocumentCount(mode, inc, exc));
    }
  });

  it('honours exclusions for the unreadable counts too', () => {
    expect(db.getInScopeStatusCounts('all', [], ['/Users/a/Arsiv'])).toEqual({ indexed: 2, failed: 1, noText: 1 });
  });

  it('reports nothing for a selected scope with no folders', () => {
    expect(db.getInScopeStatusCounts('selected', [], [])).toEqual({ indexed: 0, failed: 0, noText: 0 });
    expect(db.getUnreadableDocuments('selected', [], [])).toEqual([]);
  });

  it('lists exactly the documents behind the unreadable count, in scope', () => {
    const list = db.getUnreadableDocuments('selected', ['/Users/a/Dava'], []);
    expect(list.map(d => [d.filename, d.status])).toEqual([
      ['bozuk.docx', 'failed'],
      ['taranmis.pdf', 'no_text']
    ]);
  });

  it('caps the list so a pathological corpus cannot flood the window', () => {
    expect(db.getUnreadableDocuments('all', [], [], 1)).toHaveLength(1);
  });

  it('never writes: counting leaves the table untouched', () => {
    const before = db.db.prepare('SELECT COUNT(*) c, MAX(indexed_at) m FROM documents').get();
    db.getInScopeStatusCounts('all', [], []);
    db.getUnreadableDocuments('all', [], []);
    expect(db.db.prepare('SELECT COUNT(*) c, MAX(indexed_at) m FROM documents').get()).toEqual(before);
  });
});
