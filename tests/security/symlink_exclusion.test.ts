// A folder the user excluded must stay out of the index even when a symbolic
// link (or, on Windows, a junction) inside a searched folder leads into it.
// Before 0.4.3 the scanner judged a link by its own path, so the documents
// behind it were indexed and searchable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Every document the indexer actually opened.
const opened: string[] = [];

vi.mock('../../src/extractors/udf.js', () => ({
  extractUdf: async (filePath: string) => {
    opened.push(filePath);
    return fs.readFileSync(filePath, 'utf8');
  }
}));

import { AppDatabase } from '../../src/db/database.js';
import { indexFolders } from '../../src/search/indexer.js';
import { scanDirectories } from '../../src/scanner/scanner.js';

const isWindows = process.platform === 'win32';
// Folder links that need no administrator rights on Windows.
const dirLinkType = isWindows ? 'junction' : 'dir';

let base: string;
let searched: string;
let secret: string;
let db: AppDatabase;

function write(filePath: string, text: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `<udf>${text}</udf>`);
  return filePath;
}

function indexedPaths(): string[] {
  return db.getAllDocumentPaths().map(d => d.path).sort();
}

function indexedText(): string {
  return (db.db.prepare('SELECT group_concat(content, \' \') AS t FROM documents').get() as { t: string | null }).t ?? '';
}

beforeEach(() => {
  opened.length = 0;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-symlink-')));
  searched = path.join(base, 'Belgeler');
  secret = path.join(base, 'Gizli');
  write(path.join(searched, 'acik.udf'), 'açık dosya');
  write(path.join(secret, 'muvekkil.udf'), 'GİZLİ MÜVEKKİL BİLGİSİ');
  write(path.join(secret, 'alt', 'ek.udf'), 'GİZLİ EK');
  db = new AppDatabase(path.join(base, 'index.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a link from a searched folder into an excluded one', () => {
  it('indexes nothing behind a folder link into the excluded folder', async () => {
    fs.symlinkSync(secret, path.join(searched, 'kisayol'), dirLinkType);

    const summary = await indexFolders([searched], db, undefined, [secret]);

    expect(indexedPaths()).toEqual([path.join(searched, 'acik.udf')]);
    expect(indexedText()).not.toContain('GİZLİ');
    expect(opened.some(p => p.includes('kisayol'))).toBe(false);
    expect(summary.indexed).toBe(1);
  });

  it('also through a chain of links and a link to a subfolder', async () => {
    const hop = path.join(base, 'ara');
    fs.symlinkSync(secret, hop, dirLinkType);
    fs.symlinkSync(hop, path.join(searched, 'zincir'), dirLinkType);
    fs.symlinkSync(path.join(secret, 'alt'), path.join(searched, 'altklasor'), dirLinkType);

    await indexFolders([searched], db, undefined, [secret]);

    expect(indexedPaths()).toEqual([path.join(searched, 'acik.udf')]);
    expect(opened.every(p => !p.includes('zincir') && !p.includes('altklasor'))).toBe(true);
  });

  it.skipIf(isWindows)('indexes no file link that points into the excluded folder', async () => {
    fs.symlinkSync(path.join(secret, 'muvekkil.udf'), path.join(searched, 'kopya.udf'));

    await indexFolders([searched], db, undefined, [secret]);

    expect(indexedPaths()).toEqual([path.join(searched, 'acik.udf')]);
    expect(indexedText()).not.toContain('GİZLİ');
  });

  it.skipIf(isWindows)('indexes no link that is named like a document but leads to a program', async () => {
    const payload = path.join(base, 'payload');
    fs.writeFileSync(payload, '#!/bin/sh\necho calistirildi\n');
    fs.chmodSync(payload, 0o755);
    fs.symlinkSync(payload, path.join(searched, 'Dilekce.pdf'));
    fs.symlinkSync('/System/Applications/Calculator.app', path.join(searched, 'Karar.doc'));

    await indexFolders([searched], db, undefined, [secret]);

    expect(indexedPaths()).toEqual([path.join(searched, 'acik.udf')]);
  });

  it('recognises the exclusion however the user spelled it (through a link to it)', async () => {
    const spelledViaLink = path.join(base, 'gizli-baglanti');
    fs.symlinkSync(secret, spelledViaLink, dirLinkType);
    fs.symlinkSync(secret, path.join(searched, 'kisayol'), dirLinkType);

    await indexFolders([searched], db, undefined, [spelledViaLink]);

    expect(indexedText()).not.toContain('GİZLİ');
  });

  it('removes what an earlier version indexed behind such a link', async () => {
    const viaLink = path.join(searched, 'kisayol');
    fs.symlinkSync(secret, viaLink, dirLinkType);
    // What 0.4.2 left in the index: the secret document under the link's path.
    db.upsertDocument({
      path: path.join(viaLink, 'muvekkil.udf'),
      filename: 'muvekkil.udf',
      extension: '.udf',
      mtime: 1,
      size: 1,
      content: 'GİZLİ MÜVEKKİL BİLGİSİ',
      index_status: 'indexed'
    });
    expect(indexedText()).toContain('GİZLİ');

    const summary = await indexFolders([searched], db, undefined, [secret]);

    expect(summary.removed).toBe(1);
    expect(indexedPaths()).toEqual([path.join(searched, 'acik.udf')]);
    expect(indexedText()).not.toContain('GİZLİ');
  });

  it('still follows a link to a folder that is not excluded (an external disk, say)', async () => {
    const disk = path.join(base, 'HariciDisk');
    write(path.join(disk, 'arsiv.udf'), 'arşiv belgesi');
    fs.symlinkSync(disk, path.join(searched, 'Disk'), dirLinkType);

    await indexFolders([searched], db, undefined, [secret]);

    expect(indexedPaths()).toEqual([path.join(searched, 'Disk', 'arsiv.udf'), path.join(searched, 'acik.udf')]);
  });

  it('ends on a link loop', async () => {
    fs.symlinkSync(searched, path.join(searched, 'dongu'), dirLinkType);
    fs.mkdirSync(path.join(searched, 'a'));
    fs.symlinkSync(path.join(searched, 'a'), path.join(searched, 'a', 'geri'), dirLinkType);

    const files = await scanDirectories([searched], [secret]);

    expect(files.map(f => f.path)).toEqual([path.join(searched, 'acik.udf')]);
  });
});

describe('a file swapped for a link between the scan and the read', () => {
  it.skipIf(isWindows)('is not read', async () => {
    const swapped = write(path.join(searched, 'degisen.udf'), 'normal metin');

    await indexFolders([searched], db, progress => {
      // The moment the indexer announces this file, it becomes a link into
      // the excluded folder (the race a local attacker would try to win).
      if (progress.status === 'indexing' && progress.currentFile === 'degisen.udf') {
        fs.rmSync(swapped);
        fs.symlinkSync(path.join(secret, 'muvekkil.udf'), swapped);
      }
    }, [secret]);

    expect(opened).not.toContain(swapped);
    expect(indexedText()).not.toContain('GİZLİ');
  });
});
