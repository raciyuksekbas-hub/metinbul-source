// Windows OneDrive "Files On-Demand" placeholder guard.
//
// SCOPE OF PROOF: these tests exercise the *decision logic* and the pipeline
// boundary using a deterministic stand-in for the OS attribute reader. They do
// NOT prove runtime behavior on a real Windows machine -- attributes here are
// supplied by the test, not by cldflt.sys. Proof that a real online-only file
// stays online-only belongs to the physical Windows 11 acceptance run.
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// Records which format extractors actually received a path. An online-only
// placeholder must never appear in these lists: every one of these functions
// opens file content, which is what makes Windows hydrate the file.
const extractorCalls: string[] = [];

vi.mock('../src/extractors/docx.js', () => ({
  extractDocx: async (filePath: string) => {
    extractorCalls.push(filePath);
    return 'yerel docx içeriği mahkeme';
  }
}));
vi.mock('../src/extractors/pdf.js', () => ({
  extractPdf: async (filePath: string) => {
    extractorCalls.push(filePath);
    return 'yerel pdf içeriği dilekçe';
  },
  extractPdfPages: async (filePath: string) => {
    extractorCalls.push(filePath);
    return ['yerel pdf içeriği dilekçe'];
  }
}));

// Stand-in for the OS metadata reader. Keyed by absolute path; a path that is
// absent models "attributes could not be read".
const fakeAttributes = new Map<string, number>();
// Every path the attribute reader was asked about, in order.
const attributeReads: string[] = [];

vi.mock('../src/scanner/windows-availability.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/scanner/windows-availability.js')>();
  return {
    ...actual,
    readWindowsFileAttributes: async (filePaths: string[]) => {
      attributeReads.push(...filePaths);
      const result = new Map<string, number>();
      for (const filePath of filePaths) {
        const attributes = fakeAttributes.get(filePath);
        if (attributes !== undefined) result.set(filePath, attributes);
      }
      return result;
    }
  };
});

import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import { filterLocallyAvailableFiles, isDatalessPlaceholder, ScannedFile } from '../src/scanner/scanner.js';
import {
  isWindowsOnlineOnlyPlaceholder,
  parseWindowsAttributeOutput,
  toExtendedLengthPath,
  buildAttributeReaderScript,
  WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_PINNED,
  FILE_ATTRIBUTE_UNPINNED,
  FILE_ATTRIBUTE_REPARSE_POINT,
  FILE_ATTRIBUTE_RECALL_ON_OPEN,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
} from '../src/scanner/windows-availability.js';
import { setupFixtures, FIXTURES_DIR } from './fixtures/create_fixtures.js';

const FILE_ATTRIBUTE_ARCHIVE = 0x20;
const FILE_ATTRIBUTE_SPARSE_FILE = 0x200;
/** Same bit as FILE_ATTRIBUTE_RECALL_ON_OPEN when read per-path. */
const FILE_ATTRIBUTE_EA = 0x00040000;

/** A plain local document: nothing cloud-related. */
const ATTR_ORDINARY_LOCAL = FILE_ATTRIBUTE_ARCHIVE;

/**
 * A OneDrive file whose content has been downloaded. It is still a reparse
 * point and still carries the user's pin intent, but no recall bit: reading it
 * costs nothing and downloads nothing.
 */
const ATTR_CLOUD_HYDRATED =
  FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_UNPINNED;

/** "Always keep on this device": pinned and hydrated. */
const ATTR_CLOUD_PINNED_HYDRATED =
  FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_PINNED;

/** An online-only placeholder: the sparse, recall-on-data-access shape. */
const ATTR_ONLINE_ONLY =
  FILE_ATTRIBUTE_ARCHIVE |
  FILE_ATTRIBUTE_SPARSE_FILE |
  FILE_ATTRIBUTE_REPARSE_POINT |
  FILE_ATTRIBUTE_UNPINNED |
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

let realPlatform: PropertyDescriptor | undefined;

function pretendWindows() {
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
}

function restorePlatform() {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  realPlatform = undefined;
}

function scannedFile(filePath: string): ScannedFile {
  return {
    path: filePath,
    filename: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    mtime: 1_700_000_000_000,
    size: 4096
  };
}

describe('Windows cloud placeholder guard -- decision logic', () => {
  it('indexes an ordinary local file', () => {
    expect(isWindowsOnlineOnlyPlaceholder(ATTR_ORDINARY_LOCAL)).toBe(false);
  });

  it('indexes a cloud file whose content is already on this device', () => {
    // Hydrated cloud files must NOT be skipped just for being cloud files.
    expect(isWindowsOnlineOnlyPlaceholder(ATTR_CLOUD_HYDRATED)).toBe(false);
    expect(isWindowsOnlineOnlyPlaceholder(ATTR_CLOUD_PINNED_HYDRATED)).toBe(false);
  });

  it('skips a positively identified online-only placeholder', () => {
    expect(isWindowsOnlineOnlyPlaceholder(ATTR_ONLINE_ONLY)).toBe(true);
  });

  it('skips files whose data has been moved to offline storage by an HSM provider', () => {
    expect(isWindowsOnlineOnlyPlaceholder(FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_OFFLINE)).toBe(true);
  });

  it('fails closed when attributes cannot be read', () => {
    // Reading the file to find out is precisely what must not happen.
    expect(isWindowsOnlineOnlyPlaceholder(undefined)).toBe(true);
    expect(isWindowsOnlineOnlyPlaceholder(Number.NaN)).toBe(true);
  });

  it('does not treat pin intent as hydration state', () => {
    // Microsoft maps "online-only" to `attrib +u`, but unpinning only permits
    // the system to reclaim space later -- an unpinned file stays readable
    // locally until it actually does. UNPINNED alone must not cause a skip.
    expect(isWindowsOnlineOnlyPlaceholder(FILE_ATTRIBUTE_UNPINNED | FILE_ATTRIBUTE_ARCHIVE)).toBe(false);
    expect(isWindowsOnlineOnlyPlaceholder(FILE_ATTRIBUTE_PINNED | FILE_ATTRIBUTE_ARCHIVE)).toBe(false);
    expect(WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK & FILE_ATTRIBUTE_PINNED).toBe(0);
    expect(WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK & FILE_ATTRIBUTE_UNPINNED).toBe(0);
  });

  it('does not treat every reparse point or sparse file as a placeholder', () => {
    // Junctions, symlinks and hydrated cloud files are all reparse points.
    expect(isWindowsOnlineOnlyPlaceholder(FILE_ATTRIBUTE_REPARSE_POINT)).toBe(false);
    expect(isWindowsOnlineOnlyPlaceholder(FILE_ATTRIBUTE_SPARSE_FILE)).toBe(false);
    expect(WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK & FILE_ATTRIBUTE_REPARSE_POINT).toBe(0);
  });

  it('ignores the EA / RECALL_ON_OPEN bit, which is ambiguous per-path', () => {
    // 0x40000 means RECALL_ON_OPEN only in directory enumeration classes; from
    // a per-path attribute query the same bit means "has extended attributes".
    // Acting on it would skip ordinary local files that merely carry EAs.
    expect(FILE_ATTRIBUTE_RECALL_ON_OPEN).toBe(FILE_ATTRIBUTE_EA);
    expect(isWindowsOnlineOnlyPlaceholder(FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_EA)).toBe(false);
    expect(WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK & FILE_ATTRIBUTE_RECALL_ON_OPEN).toBe(0);
  });

  it('maps batched reader output by request index, never by parsing paths back', () => {
    const filePaths = [
      'C:\\Users\\a\\Belgeler\\rapor: taslak.docx',
      'C:\\Users\\a\\Belgeler\\çevrimiçi.pdf',
      'C:\\Users\\a\\Belgeler\\yerel.udf'
    ];
    const output = `1:${ATTR_ORDINARY_LOCAL}\r\n2:${ATTR_ONLINE_ONLY}\r\n3:${ATTR_CLOUD_HYDRATED}\r\n`;

    const parsed = parseWindowsAttributeOutput(output, filePaths);
    expect(parsed.get(filePaths[0])).toBe(ATTR_ORDINARY_LOCAL);
    expect(parsed.get(filePaths[1])).toBe(ATTR_ONLINE_ONLY);
    expect(parsed.get(filePaths[2])).toBe(ATTR_CLOUD_HYDRATED);
  });

  it('drops unparseable or out-of-range reader lines instead of guessing', () => {
    const filePaths = ['C:\\a.docx'];
    const parsed = parseWindowsAttributeOutput('garbage\n2:32\n1:\n', filePaths);
    expect(parsed.size).toBe(0);
    // ...which the caller then treats as online-only.
    expect(isWindowsOnlineOnlyPlaceholder(parsed.get('C:\\a.docx'))).toBe(true);
  });

  it('lifts the MAX_PATH limit only for paths that actually need it', () => {
    const shortPath = 'C:\\docs\\dava.docx';
    expect(toExtendedLengthPath(shortPath)).toBe(shortPath);

    // A long but perfectly local document must stay readable, otherwise the
    // fail-closed rule would silently skip it.
    const longPath = 'C:\\Users\\ayse\\' + 'klasor\\'.repeat(40) + 'dava.docx';
    expect(longPath.length).toBeGreaterThan(260);
    expect(toExtendedLengthPath(longPath)).toBe('\\\\?\\' + longPath);

    const longUnc = '\\\\sunucu\\pay\\' + 'klasor\\'.repeat(40) + 'dava.docx';
    expect(toExtendedLengthPath(longUnc)).toBe('\\\\?\\UNC\\sunucu\\pay\\' + 'klasor\\'.repeat(40) + 'dava.docx');

    // Already-extended paths are left alone.
    const already = '\\\\?\\C:\\' + 'k\\'.repeat(200) + 'a.pdf';
    expect(toExtendedLengthPath(already)).toBe(already);
  });

  it('escapes the temp list path so an apostrophe in a user name cannot break the script', () => {
    const script = buildAttributeReaderScript("C:\\Users\\O'Brien\\AppData\\Local\\Temp\\list.txt");
    expect(script).toContain("'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\list.txt'");
    // Reads metadata only -- nothing in the script opens file content.
    expect(script).toContain('Get-Item -LiteralPath $_ -Force');
    expect(script).toContain('-Encoding UTF8');
    expect(script).not.toMatch(/Get-Content -LiteralPath \$_|ReadAllBytes|\[IO\.File\]/);
  });

  it('is provider-agnostic: identical paths decide differently on attributes alone', () => {
    const oneDrivePath = 'C:\\Users\\a\\OneDrive - Contoso\\dava.docx';
    expect(isWindowsOnlineOnlyPlaceholder(ATTR_CLOUD_HYDRATED)).toBe(false);
    expect(isWindowsOnlineOnlyPlaceholder(ATTR_ONLINE_ONLY)).toBe(true);
    // The decision function never receives the path at all.
    expect(isWindowsOnlineOnlyPlaceholder.length).toBe(1);
    expect(oneDrivePath).toContain('OneDrive');
  });
});

describe('Windows cloud placeholder guard -- scanner boundary', () => {
  it('keeps local and hydrated files, drops placeholders, and counts the drops', async () => {
    const files = [
      scannedFile('C:\\docs\\yerel.docx'),
      scannedFile('C:\\docs\\indirilmis-bulut.pdf'),
      scannedFile('C:\\docs\\cevrimici.docx'),
      scannedFile('C:\\docs\\okunamayan.udf')
    ];
    const attributes = new Map<string, number>([
      [files[0].path, ATTR_ORDINARY_LOCAL],
      [files[1].path, ATTR_CLOUD_HYDRATED],
      [files[2].path, ATTR_ONLINE_ONLY]
      // files[3] deliberately absent -> attributes unreadable -> fail closed
    ]);

    const scanStats = { skippedDatalessSupportedCount: 0, unverifiedPaths: new Set<string>() };
    const kept = await filterLocallyAvailableFiles(files, scanStats, async () => attributes);

    expect(kept.map(f => f.path)).toEqual([files[0].path, files[1].path]);
    // Only the placeholder counts as cloud-only. The file whose attributes
    // could not be read is not read either, but it is reported as unchecked:
    // a reader that timed out says nothing about where a file is (the review
    // of 0.4.3 saw a timeout report a whole update's documents as "in the cloud").
    expect(scanStats.skippedDatalessSupportedCount).toBe(1);
    expect([...scanStats.unverifiedPaths]).toEqual([files[3].path]);
  });

  it('reads attributes in bulk, not once per file', async () => {
    const files = Array.from({ length: 25 }, (_, i) => scannedFile(`C:\\docs\\f${i}.pdf`));
    let readerCalls = 0;

    await filterLocallyAvailableFiles(files, undefined, async paths => {
      readerCalls++;
      return new Map(paths.map(p => [p, ATTR_ORDINARY_LOCAL]));
    });

    expect(readerCalls).toBe(1);
  });
});

describe('Windows cloud placeholder guard -- indexing pipeline', () => {
  let db: AppDatabase;
  const tempDbPath = path.join(FIXTURES_DIR, 'windows_placeholder_test.db');
  const tempDocsDir = path.join(FIXTURES_DIR, 'windows_placeholder_docs');

  const localDocx = path.join(tempDocsDir, 'yerel_karar.docx');
  const hydratedPdf = path.join(tempDocsDir, 'indirilmis_bulut.pdf');
  const onlineOnlyDocx = path.join(tempDocsDir, 'cevrimici_dilekce.docx');
  const onlineOnlyPdf = path.join(tempDocsDir, 'cevrimici_rapor.pdf');

  beforeAll(() => {
    setupFixtures();
  });

  beforeEach(() => {
    extractorCalls.length = 0;
    fakeAttributes.clear();

    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDocsDir)) fs.rmSync(tempDocsDir, { recursive: true, force: true });
    fs.mkdirSync(tempDocsDir, { recursive: true });

    // Real files on disk. On a real Windows box the two "online-only" ones
    // would be dehydrated placeholders; here their state comes from the
    // attribute stand-in, which is the part the OS would supply.
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), localDocx);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), hydratedPdf);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), onlineOnlyDocx);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), onlineOnlyPdf);

    fakeAttributes.set(localDocx, ATTR_ORDINARY_LOCAL);
    fakeAttributes.set(hydratedPdf, ATTR_CLOUD_HYDRATED);
    fakeAttributes.set(onlineOnlyDocx, ATTR_ONLINE_ONLY);
    fakeAttributes.set(onlineOnlyPdf, ATTR_ONLINE_ONLY);

    db = new AppDatabase(tempDbPath);
    db.addFolder(tempDocsDir);
    pretendWindows();
  });

  afterEach(() => {
    restorePlatform();
    db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDocsDir)) fs.rmSync(tempDocsDir, { recursive: true, force: true });
  });

  it('never hands an online-only placeholder to any extractor, and indexes the rest', async () => {
    const summary = await indexFolders(db.getFolders(), db);

    expect(extractorCalls).toContain(localDocx);
    expect(extractorCalls).toContain(hydratedPdf);
    expect(extractorCalls).not.toContain(onlineOnlyDocx);
    expect(extractorCalls).not.toContain(onlineOnlyPdf);
    expect(extractorCalls).toHaveLength(2);

    expect(summary.indexed).toBe(2);
    expect(summary.failed).toBe(0);
    // Skipped placeholders are surfaced through the existing cloud-skip counter.
    expect(summary.skippedDataless).toBe(2);

    // ...and they are not in the index, while the local ones are searchable.
    expect(db.getDocumentByPath(onlineOnlyDocx)).toBeFalsy();
    expect(db.getDocumentByPath(onlineOnlyPdf)).toBeFalsy();
    expect(search('mahkeme', db).length).toBeGreaterThan(0);
    expect(search('dilekçe', db).length).toBeGreaterThan(0);
  });

  it('reports the skip count through the progress channel the UI already listens to', async () => {
    const completions: number[] = [];
    await indexFolders(db.getFolders(), db, progress => {
      if (progress.status === 'completed' && typeof progress.skippedDataless === 'number') {
        completions.push(progress.skippedDataless);
      }
    });
    expect(completions).toEqual([2]);
  });

  it('obeys the guard on rescan, including a file that went online-only since', async () => {
    await indexFolders(db.getFolders(), db);
    expect(extractorCalls).toHaveLength(2);

    // The user frees up space: the previously hydrated PDF is now online-only.
    fakeAttributes.set(hydratedPdf, ATTR_ONLINE_ONLY);
    extractorCalls.length = 0;

    const rescan = await indexFolders(db.getFolders(), db);

    expect(extractorCalls).toHaveLength(0);

    // Freeing up space does not delete the document: its text was read while
    // it was local, so the entry stays and it is still found -- without the
    // file being opened again. Only the two never-indexed placeholders count
    // as not searchable. (Until v0.3.0 the entry was dropped here, identically
    // on macOS, which silently emptied the index as iCloud offloaded files.)
    // An unchanged, indexed document is no longer even checked: it is
    // not read, so where its content lives does not matter, and checking every
    // document cost every automatic update a PowerShell per 1,000 of them.
    expect(rescan.removed).toBe(0);
    expect(rescan.keptCloudOnly).toBe(0);
    expect(rescan.skippedDataless).toBe(2);
    expect(db.getDocumentByPath(hydratedPdf)?.content).toBe('yerel pdf içeriği dilekçe');
    expect(search('dilekçe', db).map(r => r.path)).toContain(hydratedPdf);
  });

  it('checks only the files it will read: none at all when nothing changed', async () => {
    await indexFolders(db.getFolders(), db);
    attributeReads.length = 0;
    extractorCalls.length = 0;

    const rescan = await indexFolders(db.getFolders(), db);

    // The two indexed documents are unchanged: not read, not checked. The two
    // placeholders were never indexed, so they are looked at again.
    expect(extractorCalls).toHaveLength(0);
    expect(attributeReads.sort()).toEqual([onlineOnlyDocx, onlineOnlyPdf].sort());
    expect(rescan.skipped).toBe(2);

    // A changed document is checked (and read) again.
    fs.appendFileSync(localDocx, Buffer.alloc(16));
    attributeReads.length = 0;
    await indexFolders(db.getFolders(), db);
    expect(attributeReads).toContain(localDocx);
    expect(attributeReads).not.toContain(hydratedPdf);
  });

  it('indexes a placeholder once the user makes it locally available', async () => {
    await indexFolders(db.getFolders(), db);
    expect(extractorCalls).not.toContain(onlineOnlyDocx);

    // The user chooses "Always keep on this device".
    fakeAttributes.set(onlineOnlyDocx, ATTR_CLOUD_PINNED_HYDRATED);
    extractorCalls.length = 0;

    const rescan = await indexFolders(db.getFolders(), db);

    expect(extractorCalls).toContain(onlineOnlyDocx);
    expect(rescan.skippedDataless).toBe(1);
    expect(db.getDocumentByPath(onlineOnlyDocx)).toBeTruthy();
  });

  it('applies the same guard when indexing runs through the background worker path', async () => {
    // indexAccessibleDocuments is the entry point src/main/indexer-worker.ts
    // calls on its worker thread; it funnels into the same indexFolders.
    const { indexAccessibleDocuments } = await import('../src/search/indexer.js');
    db.setSearchScopeMode('selected');
    db.addSearchArea(tempDocsDir, 'include');

    const summary = await indexAccessibleDocuments(db);

    expect(extractorCalls).not.toContain(onlineOnlyDocx);
    expect(extractorCalls).not.toContain(onlineOnlyPdf);
    expect(summary.skippedDataless).toBe(2);
  });
});

describe('macOS dataless behavior is unchanged', () => {
  it('still detects SF_DATALESS from stats flags and from the stat fallback', () => {
    const datalessStats = { flags: 0x40000000, size: 0, isFile: () => true } as any;
    const localStats = { flags: 0, size: 1024, isFile: () => true } as any;
    const statsWithoutFlags = { size: 42, isFile: () => true } as any;

    expect(isDatalessPlaceholder(datalessStats)).toBe(true);
    expect(isDatalessPlaceholder(localStats)).toBe(false);
    expect(isDatalessPlaceholder(statsWithoutFlags, 0x40000060)).toBe(true);
    expect(isDatalessPlaceholder(statsWithoutFlags, 0x40)).toBe(false);
  });

  it('keeps the two platform signals independent', () => {
    // The macOS flag word and the Windows attribute word are different fields
    // from different syscalls; neither mask may be applied to the other.
    const SF_DATALESS = 0x40000000;
    expect(WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK & SF_DATALESS).toBe(0);
    expect(isWindowsOnlineOnlyPlaceholder(SF_DATALESS)).toBe(false);
    expect(isDatalessPlaceholder(undefined, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)).toBe(false);
  });
});
