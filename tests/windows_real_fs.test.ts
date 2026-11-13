// Real-Windows validation of the cloud placeholder guard.
//
// Everything here runs against the actual filesystem and the actual PowerShell
// attribute reader -- no mocked attributes, no faked process.platform. These
// tests are skipped everywhere except Windows, and are the automated half of
// the acceptance gate: they prove the reader, the scanner boundary and the
// extractor boundary behave correctly on the real OS.
//
// What they still do NOT prove: that OneDrive's Files On-Demand specifically
// sets FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS on a dehydrated file and clears it
// on hydration. That bit is settable only by kernel-mode callers, so it cannot
// be produced from a test process. See the CFAPI capability probe in
// .github/workflows/windows-placeholder-acceptance.yml.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import {
  readWindowsFileAttributes,
  isWindowsOnlineOnlyPlaceholder,
  FILE_ATTRIBUTE_OFFLINE
} from '../src/scanner/windows-availability.js';
import { setupFixtures, FIXTURES_DIR } from './fixtures/create_fixtures.js';

const onWindows = process.platform === 'win32';

/** Sets real NTFS attributes through the OS, not through our own code. */
function setRealAttributes(filePath: string, attributesExpression: string): void {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[System.IO.File]::SetAttributes('${filePath.replace(/'/g, "''")}', ${attributesExpression})`
    ],
    { stdio: 'ignore' }
  );
}

/** Reads real NTFS attributes through the OS, independently of our reader. */
function getRealAttributes(filePath: string): number {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[int][System.IO.File]::GetAttributes('${filePath.replace(/'/g, "''")}')`
    ],
    { encoding: 'utf8' }
  );
  return Number(out.trim());
}

describe.skipIf(!onWindows)('Windows attribute reader against the real filesystem', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-realfs-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('reads attributes of an ordinary local file and calls it locally available', async () => {
    const filePath = path.join(workDir, 'yerel.docx');
    fs.writeFileSync(filePath, 'content');

    const attributes = (await readWindowsFileAttributes([filePath])).get(filePath);

    expect(attributes).toBeTypeOf('number');
    expect(attributes).toBe(getRealAttributes(filePath));
    expect(isWindowsOnlineOnlyPlaceholder(attributes)).toBe(false);
  });

  it('handles Turkish characters in paths', async () => {
    // The reader passes paths through a UTF-8 file rather than stdin precisely
    // so these survive; a code-page round trip would corrupt them and the
    // fail-closed rule would then skip perfectly local documents.
    const turkishDir = path.join(workDir, 'Çalışma Klasörü');
    fs.mkdirSync(turkishDir);
    const filePath = path.join(turkishDir, 'İstanbul şubesi görüşü ğüıöç.docx');
    fs.writeFileSync(filePath, 'content');

    const attributes = (await readWindowsFileAttributes([filePath])).get(filePath);

    expect(attributes).toBeTypeOf('number');
    expect(isWindowsOnlineOnlyPlaceholder(attributes)).toBe(false);
  });

  it("handles an apostrophe in a path", async () => {
    const filePath = path.join(workDir, "O'Brien'in dosyası.pdf");
    fs.writeFileSync(filePath, 'content');

    const attributes = (await readWindowsFileAttributes([filePath])).get(filePath);
    expect(isWindowsOnlineOnlyPlaceholder(attributes)).toBe(false);
  });

  it('reads attributes of a path longer than MAX_PATH', async () => {
    // Without the extended-length prefix this comes back unreadable, and the
    // fail-closed rule would skip a local file.
    let deepDir = workDir;
    while (deepDir.length < 300) {
      deepDir = path.join(deepDir, 'klasor');
      fs.mkdirSync(deepDir, { recursive: true });
    }
    const filePath = path.join(deepDir, 'derin.docx');
    fs.writeFileSync(filePath, 'content');
    expect(filePath.length).toBeGreaterThan(260);

    const attributes = (await readWindowsFileAttributes([filePath])).get(filePath);

    expect(attributes).toBeTypeOf('number');
    expect(isWindowsOnlineOnlyPlaceholder(attributes)).toBe(false);
  });

  it('keeps batch indexes aligned when some entries cannot be read', async () => {
    const present1 = path.join(workDir, 'bir.docx');
    const missing = path.join(workDir, 'yok.docx');
    const present2 = path.join(workDir, 'uc.pdf');
    fs.writeFileSync(present1, 'a');
    fs.writeFileSync(present2, 'c');

    const attributes = await readWindowsFileAttributes([present1, missing, present2]);

    // The unreadable entry must not shift the others onto the wrong paths.
    expect(attributes.get(present1)).toBe(getRealAttributes(present1));
    expect(attributes.get(present2)).toBe(getRealAttributes(present2));
    expect(attributes.has(missing)).toBe(false);
    expect(isWindowsOnlineOnlyPlaceholder(attributes.get(missing))).toBe(true);
  });

  it('reads a batch larger than one process invocation', async () => {
    const filePaths = Array.from({ length: 1200 }, (_, i) => {
      const filePath = path.join(workDir, `belge-${i}.pdf`);
      fs.writeFileSync(filePath, 'x');
      return filePath;
    });

    const attributes = await readWindowsFileAttributes(filePaths);

    expect(attributes.size).toBe(filePaths.length);
    for (const filePath of filePaths) {
      expect(isWindowsOnlineOnlyPlaceholder(attributes.get(filePath))).toBe(false);
    }
    // About 3.5 ms a file in PowerShell: 4 s alone and 6 s under load on a
    // real office computer (a review of 0.4.3), past the default 5 s.
  }, 30_000);

  it('surfaces a real FILE_ATTRIBUTE_OFFLINE bit set by the OS', async () => {
    const filePath = path.join(workDir, 'arsivlenmis.pdf');
    fs.writeFileSync(filePath, 'content');
    setRealAttributes(filePath, '[System.IO.FileAttributes]::Offline');

    expect(getRealAttributes(filePath) & FILE_ATTRIBUTE_OFFLINE).toBe(FILE_ATTRIBUTE_OFFLINE);

    const attributes = (await readWindowsFileAttributes([filePath])).get(filePath);
    expect(attributes! & FILE_ATTRIBUTE_OFFLINE).toBe(FILE_ATTRIBUTE_OFFLINE);
    expect(isWindowsOnlineOnlyPlaceholder(attributes)).toBe(true);
  });
});

describe.skipIf(!onWindows)('Windows indexing pipeline against the real filesystem', () => {
  let db: AppDatabase;
  let docsDir: string;
  let dbPath: string;

  beforeAll(() => {
    setupFixtures();
  });

  beforeEach(() => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-realidx-'));
    dbPath = path.join(docsDir, 'index.db');
    db = new AppDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it('indexes ordinary local documents end to end', async () => {
    const docsSubdir = path.join(docsDir, 'belgeler');
    fs.mkdirSync(docsSubdir);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(docsSubdir, 'karar.docx'));
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), path.join(docsSubdir, 'dilekce.pdf'));
    db.addFolder(docsSubdir);

    const summary = await indexFolders(db.getFolders(), db);

    // The whole point of the fail-closed rule is that it must not fire here.
    expect(summary.skippedDataless).toBe(0);
    expect(summary.indexed).toBe(2);
    expect(search('mahkeme', db).length).toBeGreaterThan(0);
  });

  it('never opens a file the OS reports as not locally available', async () => {
    const docsSubdir = path.join(docsDir, 'belgeler');
    fs.mkdirSync(docsSubdir);

    const localDocx = path.join(docsSubdir, 'yerel.docx');
    const offlineDocx = path.join(docsSubdir, 'cevrimdisi.docx');
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), localDocx);
    // A deliberately unreadable payload: if the guard ever let an extractor
    // touch this file, extraction would throw and land in summary.failed.
    fs.copyFileSync(path.join(FIXTURES_DIR, 'corrupt.docx'), offlineDocx);
    setRealAttributes(offlineDocx, '[System.IO.FileAttributes]::Offline');

    const attributesBefore = getRealAttributes(offlineDocx);
    db.addFolder(docsSubdir);

    const summary = await indexFolders(db.getFolders(), db);

    expect(summary.skippedDataless).toBe(1);
    // Proof the extractor was never reached: a corrupt payload that is opened
    // always fails, and nothing failed.
    expect(summary.failed).toBe(0);
    expect(db.getDocumentByPath(offlineDocx)).toBeFalsy();

    // The locally available neighbour is unaffected.
    expect(summary.indexed).toBe(1);
    expect(db.getDocumentByPath(localDocx)).toBeTruthy();

    // HYDRATION_STATE_BEFORE == HYDRATION_STATE_AFTER
    expect(getRealAttributes(offlineDocx)).toBe(attributesBefore);
  });

  it('indexes the file once the OS reports it as locally available again', async () => {
    const docsSubdir = path.join(docsDir, 'belgeler');
    fs.mkdirSync(docsSubdir);
    const doc = path.join(docsSubdir, 'karar.docx');
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), doc);
    setRealAttributes(doc, '[System.IO.FileAttributes]::Offline');
    db.addFolder(docsSubdir);

    const first = await indexFolders(db.getFolders(), db);
    expect(first.skippedDataless).toBe(1);
    expect(first.indexed).toBe(0);

    // "Always keep on this device" -- content is local again.
    setRealAttributes(doc, '[System.IO.FileAttributes]::Archive');

    const second = await indexFolders(db.getFolders(), db);
    expect(second.skippedDataless).toBe(0);
    expect(second.indexed).toBe(1);
    expect(search('mahkeme', db).length).toBeGreaterThan(0);
  });
});

// Activated only by scripts/windows/cfapi-placeholder-probe.ps1, which registers
// a real Cloud Files API sync root and creates a genuinely dehydrated
// placeholder in it. This is the one block that exercises the actual
// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS bit, which no test process can fake.
const cfapiSyncRoot = process.env.METINBUL_CFAPI_SYNC_ROOT;

describe.skipIf(!onWindows || !cfapiSyncRoot)('Real CFAPI dehydrated placeholder', () => {
  const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000;

  it('leaves a real dehydrated placeholder untouched and reports it as skipped', async () => {
    const syncRoot = cfapiSyncRoot!;
    const placeholder = path.join(syncRoot, 'cevrimici_dilekce.docx');

    const attributesBefore = getRealAttributes(placeholder);
    expect(attributesBefore & FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS).toBe(
      FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
    );

    // Our own reader must see the same bit the OS reports.
    const readerAttributes = (await readWindowsFileAttributes([placeholder])).get(placeholder);
    expect(readerAttributes).toBe(attributesBefore);
    expect(isWindowsOnlineOnlyPlaceholder(readerAttributes)).toBe(true);

    // Also drop a genuinely local document beside it, so this proves
    // discrimination rather than "skips everything".
    const localDoc = path.join(syncRoot, 'yerel_karar.docx');
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), localDoc);

    const dbPath = path.join(os.tmpdir(), `metinbul-cfapi-${process.pid}.db`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const cfapiDb = new AppDatabase(dbPath);

    try {
      cfapiDb.addFolder(syncRoot);
      const summary = await indexFolders(cfapiDb.getFolders(), cfapiDb);

      expect(summary.skippedDataless).toBe(1);
      expect(summary.failed).toBe(0);
      expect(cfapiDb.getDocumentByPath(placeholder)).toBeFalsy();

      // The locally available document alongside it is indexed normally.
      expect(cfapiDb.getDocumentByPath(localDoc)).toBeTruthy();
      expect(search('mahkeme', cfapiDb).length).toBeGreaterThan(0);

      // HYDRATION_STATE_BEFORE == HYDRATION_STATE_AFTER
      expect(getRealAttributes(placeholder)).toBe(attributesBefore);
    } finally {
      cfapiDb.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  });
});
