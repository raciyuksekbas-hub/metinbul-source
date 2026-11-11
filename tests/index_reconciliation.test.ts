// What an index update does with documents it can no longer read or find.
//
// Two real-profile failures (2026-10-17) are locked here:
//   1. A document whose content iCloud moved to the cloud ("Optimize Mac
//      Storage") was deleted from the index on the next update, although its
//      text had already been read. 620 of 622 documents in one real folder
//      were lost this way.
//   2. A folder that was deleted or moved left its entries behind for ever,
//      because a missing parent folder was treated like a disk that is not
//      connected. 1,117 real entries pointed at paths that no longer existed.
//
// Real files in a temp folder go through the real scanner and indexer. Only two
// things are stand-ins: the macOS file flags (the cloud-only bit cannot be set
// on a test file), and the UDF extractor, which records every file it opens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const SF_DATALESS = 0x40000000;
// Paths the fake `/usr/bin/stat` reports as cloud-only, or cannot report at all.
const cloudOnly = new Set<string>();
const flagsUnreadable = new Set<string>();
// Every file whose content an extractor opened.
const opened: string[] = [];
// How many times the scanner started `/usr/bin/stat`.
let statCalls = 0;

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = ((file: string, args: string[], options: unknown, callback: (...a: unknown[]) => void) => {
    if (file !== '/usr/bin/stat') {
      return (actual.execFile as any)(file, args, options, callback);
    }
    statCalls++;
    // Same output shape as `stat -L -f '%@:%#Xf' -- <paths>`: one line per
    // readable path, keyed by its 1-based position in the argument list.
    const paths = args.slice(args.indexOf('--') + 1);
    const lines = paths.flatMap((p, i) => {
      if (flagsUnreadable.has(p) || !fs.existsSync(p)) return [];
      return [`${i + 1}:${cloudOnly.has(p) ? '0x' + SF_DATALESS.toString(16) : '0'}`];
    });
    setImmediate(() => callback(null, lines.join('\n'), ''));
    return {} as any;
  }) as typeof actual.execFile;
  return { ...actual, execFile, default: { ...actual, execFile } };
});

vi.mock('../src/extractors/udf.js', () => ({
  extractUdf: async (filePath: string) => {
    opened.push(filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    // Stands in for a corrupt or encrypted document.
    if (text.includes('BOZUK')) throw new Error('unreadable test document');
    return text;
  }
}));

import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import { directoryReadLimits } from '../src/scanner/scanner.js';

let base: string;
let root: string;
let dbPath: string;
let db: AppDatabase;

function write(relativePath: string, text: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `<udf>${text}</udf>`);
  return filePath;
}

function foundPaths(query: string): string[] {
  return search(query, db).map(r => r.path);
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-reconcile-'));
  root = path.join(base, 'home');
  fs.mkdirSync(root);
  dbPath = path.join(base, 'index.db');
  db = new AppDatabase(dbPath);
  cloudOnly.clear();
  flagsUnreadable.clear();
  opened.length = 0;
  statCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(base, { recursive: true, force: true });
});

// Every folder the scanner read, and every path the indexer looked up to
// decide whether a missing document was deleted.
function watchFilesystem() {
  const read = vi.spyOn(fs.promises, 'readdir');
  const lookedUp = vi.spyOn(fs.realpathSync, 'native');
  return {
    readUnder: (dir: string) => read.mock.calls.map(c => String(c[0])).filter(p => p.startsWith(dir)),
    lookedUpUnder: (dir: string) => lookedUp.mock.calls.map(c => String(c[0])).filter(p => p.startsWith(dir))
  };
}

describe.skipIf(process.platform !== 'darwin')('a document whose content went to the cloud', () => {
  it('stays searchable with the text read while it was local, and is not opened again', async () => {
    const offloaded = write('Belgeler/Hukuk Arsivi/dilekce.udf', 'ortaklığın giderilmesi davası');
    write('Belgeler/kira.udf', 'kira tespiti');
    await indexFolders([root], db);
    expect(foundPaths('ortaklığın giderilmesi')).toEqual([offloaded]);

    cloudOnly.add(offloaded);
    opened.length = 0;
    const update = await indexFolders([root], db);

    expect(opened).not.toContain(offloaded);
    expect(update.removed).toBe(0);
    expect(update.keptCloudOnly).toBe(1);
    // Counted as searchable, so not in the "yalnızca bulutta" figure.
    expect(update.skippedDataless).toBe(0);
    expect(foundPaths('ortaklığın giderilmesi')).toEqual([offloaded]);
  });

  it('still counts a cloud-only document that was never read as not searchable', async () => {
    write('a.udf', 'yerel belge');
    const neverLocal = write('b.udf', 'buluttaki belge');
    cloudOnly.add(neverLocal);

    const first = await indexFolders([root], db);
    expect(opened).not.toContain(neverLocal);
    expect(db.getDocumentByPath(neverLocal)).toBeFalsy();
    expect(first.skippedDataless).toBe(1);
    expect(first.keptCloudOnly).toBe(0);

    // Downloaded by the user: indexed on the next update.
    cloudOnly.delete(neverLocal);
    const second = await indexFolders([root], db);
    expect(second.skippedDataless).toBe(0);
    expect(foundPaths('buluttaki belge')).toEqual([neverLocal]);
  });

  it('keeps the entry when the file flags cannot be read', async () => {
    const file = write('Belgeler/sozlesme.udf', 'gizlilik sözleşmesi');
    await indexFolders([root], db);

    flagsUnreadable.add(file);
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(0);
    expect(update.keptCloudOnly).toBe(1);
    expect(foundPaths('gizlilik sözleşmesi')).toEqual([file]);
  });

  it('drops the entry once the cloud-only file is really deleted', async () => {
    const file = write('Belgeler/ihtarname.udf', 'değer kaybı ihtarnamesi');
    await indexFolders([root], db);
    cloudOnly.add(file);
    await indexFolders([root], db);
    expect(foundPaths('değer kaybı')).toEqual([file]);

    fs.rmSync(file);
    cloudOnly.delete(file);
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(1);
    expect(foundPaths('değer kaybı')).toEqual([]);
  });

  it('reads the document again when it comes back with new content', async () => {
    const file = write('Belgeler/karar.udf', 'ilk taslak metni');
    await indexFolders([root], db);
    cloudOnly.add(file);
    await indexFolders([root], db);

    // Edited on another device, then downloaded again.
    fs.writeFileSync(file, '<udf>kesinleşmiş karar metni ve gerekçesi</udf>');
    cloudOnly.delete(file);
    await indexFolders([root], db);

    expect(foundPaths('kesinleşmiş karar')).toEqual([file]);
    expect(foundPaths('ilk taslak')).toEqual([]);
  });
});

// iCloud "Optimize Mac Storage" offloads whole folders too. Reading such a
// folder's listing makes iCloud fetch it, and the read hangs for as long as
// iCloud does: on the real profile (2026-10-29) one offloaded folder held up
// an update for 80 minutes.
describe.skipIf(process.platform !== 'darwin')('a folder whose content went to the cloud', () => {
  it('is not read, and the documents in it stay searchable', async () => {
    const archive = path.join(root, 'Belgeler', 'Arsiv');
    const petition = write('Belgeler/Arsiv/dilekce.udf', 'eski dilekçe metni');
    const annex = write('Belgeler/Arsiv/Ekler/ek.udf', 'bilirkişi ek raporu');
    cloudOnly.add(write('Belgeler/bulutta.udf', 'hiç inmemiş belge'));
    write('notlar.udf', 'yerel not');
    await indexFolders([root], db);

    cloudOnly.add(archive);
    const fsWatch = watchFilesystem();
    const update = await indexFolders([root], db);

    expect(fsWatch.readUnder(archive)).toEqual([]);
    expect(fsWatch.lookedUpUnder(archive)).toEqual([]);
    expect(update.removed).toBe(0);
    expect(update.keptCloudOnly).toBe(2);
    // The archive's documents are searchable: only the file that was never
    // read counts in the "yalnızca bulutta" figure.
    expect(update.skippedDataless).toBe(1);
    expect(foundPaths('eski dilekçe')).toEqual([petition]);
    expect(foundPaths('bilirkişi ek raporu')).toEqual([annex]);
  });

  it('keeps everything when the whole selected folder went to the cloud', async () => {
    const file = write('Belgeler/kira.udf', 'kira tespiti');
    await indexFolders([root], db);

    cloudOnly.add(root);
    const fsWatch = watchFilesystem();
    const update = await indexFolders([root], db);

    expect(fsWatch.readUnder(root)).toEqual([]);
    expect(update.removed).toBe(0);
    expect(update.keptCloudOnly).toBe(1);
    expect(foundPaths('kira tespiti')).toEqual([file]);
  });

  // Every folder has to be checked before it is read, and each `stat` is a
  // process: one per folder made an update every ten minutes cost 3,000+
  // processes on the real profile. A whole level of folders goes in one call.
  it('checks a whole level of folders in one call', async () => {
    for (let i = 0; i < 25; i++) write(`Davalar/${i}/Ekler/dilekce.udf`, `dilekçe ${i}`);
    await indexFolders([root], db);

    // The root, each of the three levels of folders, and the documents.
    expect(statCalls).toBeLessThanOrEqual(5);
  });

  it('is read again once its content is back on the Mac', async () => {
    write('Belgeler/Arsiv/dilekce.udf', 'eski dilekçe metni');
    cloudOnly.add(path.join(root, 'Belgeler', 'Arsiv'));
    await indexFolders([root], db);
    expect(foundPaths('eski dilekçe')).toEqual([]);

    cloudOnly.clear();
    await indexFolders([root], db);
    expect(foundPaths('eski dilekçe')).toEqual([path.join(root, 'Belgeler', 'Arsiv', 'dilekce.udf')]);
  });
});

describe('a folder that was deleted, moved or is out of reach', () => {
  it('removes the entries of a deleted folder, so no result points at a missing file', async () => {
    write('Documents/Davalar/2000-11/dilekce.udf', 'istinaf dilekçesi');
    write('Documents/Davalar/2000-12/karar.udf', 'gerekçeli karar');
    const kept = write('Documents/Belgeler/vekaletname.udf', 'vekaletname örneği');
    await indexFolders([root], db);
    expect(foundPaths('istinaf dilekçesi')).toHaveLength(1);

    fs.rmSync(path.join(root, 'Documents/Davalar'), { recursive: true });
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(2);
    expect(foundPaths('istinaf dilekçesi')).toEqual([]);
    expect(foundPaths('gerekçeli karar')).toEqual([]);
    expect(foundPaths('vekaletname örneği')).toEqual([kept]);
  });

  it('follows a moved folder: the old paths go, the new ones are indexed', async () => {
    write('Documents/Davalar/dilekce.udf', 'tazminat dilekçesi');
    await indexFolders([root], db);

    fs.mkdirSync(path.join(root, 'Documents/Arsiv'), { recursive: true });
    fs.renameSync(path.join(root, 'Documents/Davalar'), path.join(root, 'Documents/Arsiv/Davalar'));
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(1);
    expect(foundPaths('tazminat dilekçesi')).toEqual([path.join(root, 'Documents/Arsiv/Davalar/dilekce.udf')]);
  });

  it('keeps the entries of a selected folder that is not connected', async () => {
    const usb = path.join(root, 'USB');
    const file = write('USB/Dosyalar/karar.udf', 'icra takibi');
    await indexFolders([usb], db);

    fs.rmSync(usb, { recursive: true });
    const update = await indexFolders([usb], db);

    expect(update.removed).toBe(0);
    expect(foundPaths('icra takibi')).toEqual([file]);
  });

  it.skipIf(process.platform === 'win32')('keeps the entries behind a link to a disk that is not connected', async () => {
    const disk = path.join(base, 'disk');
    fs.mkdirSync(path.join(disk, 'Davalar'), { recursive: true });
    fs.writeFileSync(path.join(disk, 'Davalar/dilekce.udf'), '<udf>harici diskteki dilekçe</udf>');
    write('notlar.udf', 'yerel not');
    fs.symlinkSync(disk, path.join(root, 'Disk'));
    await indexFolders([root], db);
    const viaLink = path.join(root, 'Disk/Davalar/dilekce.udf');
    expect(foundPaths('harici diskteki')).toEqual([viaLink]);

    fs.rmSync(disk, { recursive: true });
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(0);
    expect(foundPaths('harici diskteki')).toEqual([viaLink]);
  });

  it('does not take an empty folder as proof that its contents were deleted', async () => {
    // What an unmounted mount point or a signed-out cloud folder looks like.
    const file = write('Drive/Davalar/dilekce.udf', 'bulut klasöründeki dilekçe');
    write('notlar.udf', 'yerel not');
    await indexFolders([root], db);

    fs.rmSync(path.join(root, 'Drive/Davalar'), { recursive: true });
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(0);
    expect(foundPaths('bulut klasöründeki')).toEqual([file]);
  });
});

describe('a folder that does not answer', () => {
  const defaultTimeout = directoryReadLimits.timeoutMs;
  afterEach(() => {
    directoryReadLimits.timeoutMs = defaultTimeout;
  });

  it('is left out of the update, which still goes through everywhere else', async () => {
    const share = path.join(root, 'Ortak');
    const report = write('Ortak/rapor.udf', 'bilirkişi raporu');
    write('notlar.udf', 'yerel not');
    await indexFolders([root], db);

    // A read that never returns, as one stuck in a hung cloud provider does.
    const realReaddir = fs.promises.readdir;
    const fsWatch = watchFilesystem();
    vi.mocked(fs.promises.readdir).mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) =>
      String(dir) === share ? new Promise(() => {}) : (realReaddir as any).call(fs.promises, dir, ...rest)) as any);
    directoryReadLimits.timeoutMs = 50;
    const added = write('yeni.udf', 'yeni dilekçe');
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(0);
    expect(foundPaths('bilirkişi raporu')).toEqual([report]);
    expect(foundPaths('yeni dilekçe')).toEqual([added]);
    // Looking a name up in it could hang just the same.
    expect(fsWatch.lookedUpUnder(share)).toEqual([]);
  });
});

describe('an update that runs on its own every ten minutes', () => {
  it('leaves an unchanged unreadable file alone, while "Belgeleri Güncelle" still retries it', async () => {
    const broken = write('Belgeler/bozuk.udf', 'BOZUK');
    const first = await indexFolders([root], db);
    expect(first.failed).toBe(1);

    opened.length = 0;
    await indexFolders([root], db, undefined, [], [], { retryFailed: false });
    expect(opened).not.toContain(broken);

    await indexFolders([root], db);
    expect(opened).toContain(broken);

    // Once the file changes, even an automatic update reads it again.
    fs.writeFileSync(broken, '<udf>onarılmış dilekçe metni</udf>');
    opened.length = 0;
    await indexFolders([root], db, undefined, [], [], { retryFailed: false });
    expect(opened).toContain(broken);
    expect(foundPaths('onarılmış dilekçe')).toEqual([broken]);
  });

  it('removes a deleted file even when it leaves its folder empty', async () => {
    const file = write('Belgeler/tek-belge.udf', 'tek kalan dilekçe');
    write('notlar.udf', 'yerel not');
    await indexFolders([root], db);

    fs.rmSync(file);
    const update = await indexFolders([root], db);

    expect(update.removed).toBe(1);
    expect(foundPaths('tek kalan dilekçe')).toEqual([]);
  });

  // A folder this update could not read proves nothing about what is in it:
  // with an update every ten minutes, a permission hiccup or a cloud folder
  // that failed to load would otherwise empty its entries.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the entries of a folder it could not read', async () => {
      const locked = path.join(root, 'Gizli');
      const file = write('Gizli/sozlesme.udf', 'gizli sözleşme metni');
      write('notlar.udf', 'yerel not');
      await indexFolders([root], db);

      fs.chmodSync(locked, 0o000);
      try {
        const update = await indexFolders([root], db);
        expect(update.removed).toBe(0);
        expect(foundPaths('gizli sözleşme')).toEqual([file]);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    });
});
