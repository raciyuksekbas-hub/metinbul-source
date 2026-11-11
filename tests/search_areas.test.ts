import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AppDatabase } from '../src/db/database.js';
import { indexFolders, indexAccessibleDocuments } from '../src/search/indexer.js';
import { search, isDocumentInScope } from '../src/search/search.js';
import {
  isPathOrSubpath,
  isPathExcluded,
  shouldSkipFile,
  shouldSkipDirectory,
  isDatalessPlaceholder,
  parseDarwinStatFlagsOutput,
  scanDirectory
} from '../src/scanner/scanner.js';
import { setupFixtures, FIXTURES_DIR } from './fixtures/create_fixtures.js';

describe('Search Areas (Arama Alanları) Scope & Mode Tests (v0.2.0)', () => {
  let db: AppDatabase;
  const tempDbPath = path.join(FIXTURES_DIR, 'search_areas_test.db');
  const testBaseDir = path.join(FIXTURES_DIR, 'test_areas_ws');

  beforeAll(() => {
    setupFixtures();
  });

  beforeEach(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
    fs.mkdirSync(testBaseDir, { recursive: true });
    db = new AppDatabase(tempDbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  });

  describe('Core Scope & User Acceptance Scenarios (TEST A - TEST I)', () => {
    // Helper to create test files
    function createDoc(folder: string, filename: string) {
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, filename);
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), target);
      return target;
    }

    it('TEST A — Bilgisayarın Tümü: Desktop ve Documents içindeki belgeler genel aramada bulunmalı', async () => {
      const desktopDir = path.join(testBaseDir, 'Desktop');
      const docsDir = path.join(testBaseDir, 'Documents');
      createDoc(desktopDir, 'desktop_karar.docx');
      createDoc(docsDir, 'docs_karar.docx');

      db.setSearchScopeMode('all');
      await indexFolders([desktopDir, docsDir], db);

      const results = search('tazminatı', db);
      expect(results.length).toBe(2);
      const names = results.map(r => r.filename);
      expect(names).toContain('desktop_karar.docx');
      expect(names).toContain('docs_karar.docx');
    });

    it('TEST B — Sadece Desktop: Selected-only modunda yalnız Desktop include edilsin, yalnız Desktop dönmeli', async () => {
      const desktopDir = path.join(testBaseDir, 'Desktop');
      const docsDir = path.join(testBaseDir, 'Documents');
      createDoc(desktopDir, 'desktop_karar.docx');
      createDoc(docsDir, 'docs_karar.docx');

      // Both indexed in DB
      await indexFolders([desktopDir, docsDir], db);

      // Set mode to selected and include ONLY Desktop
      db.setSearchScopeMode('selected');
      db.addSearchArea(desktopDir, 'include');

      const results = search('tazminatı', db);
      expect(results.length).toBe(1);
      expect(results[0].filename).toBe('desktop_karar.docx');
      expect(results.map(r => r.filename)).not.toContain('docs_karar.docx');
    });

    it('TEST C — Sadece Downloads: Belge Desktop ve Documents’ta varken yalnız Downloads include edilirse sonuç 0 olmalı', async () => {
      const desktopDir = path.join(testBaseDir, 'Desktop');
      const docsDir = path.join(testBaseDir, 'Documents');
      const downloadsDir = path.join(testBaseDir, 'Downloads');
      fs.mkdirSync(downloadsDir, { recursive: true });

      createDoc(desktopDir, 'desktop_karar.docx');
      createDoc(docsDir, 'docs_karar.docx');

      // Index both into DB
      await indexFolders([desktopDir, docsDir], db);

      // User selects selected-mode with only Downloads
      db.setSearchScopeMode('selected');
      db.addSearchArea(downloadsDir, 'include');

      const results = search('tazminatı', db);
      expect(results.length).toBe(0);
    });

    it('TEST D — Çoklu Include: Desktop + Documents include edilirse ikisi bulunmalı, Downloads bulunmamalı', async () => {
      const desktopDir = path.join(testBaseDir, 'Desktop');
      const docsDir = path.join(testBaseDir, 'Documents');
      const downloadsDir = path.join(testBaseDir, 'Downloads');

      createDoc(desktopDir, 'desktop_karar.docx');
      createDoc(docsDir, 'docs_karar.docx');
      createDoc(downloadsDir, 'downloads_karar.docx');

      await indexFolders([desktopDir, docsDir, downloadsDir], db);

      db.setSearchScopeMode('selected');
      db.addSearchArea(desktopDir, 'include');
      db.addSearchArea(docsDir, 'include');

      const results = search('tazminatı', db);
      expect(results.length).toBe(2);
      const names = results.map(r => r.filename);
      expect(names).toContain('desktop_karar.docx');
      expect(names).toContain('docs_karar.docx');
      expect(names).not.toContain('downloads_karar.docx');
    });

    it('TEST E — Include + Exclude: Documents include, Documents/Private exclude -> Documents/Public bulunmalı, Private bulunmamalı', async () => {
      const docsDir = path.join(testBaseDir, 'Documents');
      const publicDir = path.join(docsDir, 'Public');
      const privateDir = path.join(docsDir, 'Private');

      createDoc(publicDir, 'public_doc.docx');
      createDoc(privateDir, 'private_doc.docx');

      await indexFolders([docsDir], db);

      db.setSearchScopeMode('selected');
      db.addSearchArea(docsDir, 'include');
      db.addSearchArea(privateDir, 'exclude');

      const results = search('tazminatı', db);
      expect(results.length).toBe(1);
      expect(results[0].filename).toBe('public_doc.docx');
      expect(results.map(r => r.filename)).not.toContain('private_doc.docx');
    });

    it('TEST F — Mode Switch: All → Selected → All geçişlerinde sonuç kapsamı doğru değişmeli', async () => {
      const desktopDir = path.join(testBaseDir, 'Desktop');
      const docsDir = path.join(testBaseDir, 'Documents');

      createDoc(desktopDir, 'desktop_doc.docx');
      createDoc(docsDir, 'docs_doc.docx');

      await indexFolders([desktopDir, docsDir], db);

      // 1. In 'all' mode: both returned
      db.setSearchScopeMode('all');
      expect(search('tazminatı', db).length).toBe(2);

      // 2. Switch to 'selected' mode with only Desktop
      db.setSearchScopeMode('selected');
      db.addSearchArea(desktopDir, 'include');
      const selResults = search('tazminatı', db);
      expect(selResults.length).toBe(1);
      expect(selResults[0].filename).toBe('desktop_doc.docx');

      // 3. Switch back to 'all' mode: both returned again
      db.setSearchScopeMode('all');
      expect(search('tazminatı', db).length).toBe(2);
    });

    it('TEST G — Persistence: Selected mode + include/exclude ayarları app/database reopen sonrasında korunmalı', () => {
      const desktopDir = path.join(testBaseDir, 'Desktop');
      const privateDir = path.join(testBaseDir, 'Desktop', 'Private');

      db.setSearchScopeMode('selected');
      db.addSearchArea(desktopDir, 'include');
      db.addSearchArea(privateDir, 'exclude');

      expect(db.getSearchScopeMode()).toBe('selected');
      expect(db.getIncludedFolders()).toContain(path.resolve(desktopDir));
      expect(db.getExcludedFolders()).toContain(path.resolve(privateDir));

      // Close and reopen
      db.close();
      const reopenedDb = new AppDatabase(tempDbPath);

      expect(reopenedDb.getSearchScopeMode()).toBe('selected');
      expect(reopenedDb.getIncludedFolders()).toContain(path.resolve(desktopDir));
      expect(reopenedDb.getExcludedFolders()).toContain(path.resolve(privateDir));

      reopenedDb.close();
      db = new AppDatabase(tempDbPath);
    });

    it('TEST H — External Drive: Selected-only modunda harici disk klasörü eklendiğinde aranabilmeli ve offline olunca crash etmemeli', async () => {
      const usbDir = path.join(testBaseDir, 'ExternalUSB');
      createDoc(usbDir, 'usb_karar.docx');

      db.setSearchScopeMode('selected');
      db.addSearchArea(usbDir, 'include');

      // 1. Index while connected
      await indexFolders(db.getIncludedFolders(), db, undefined, db.getExcludedFolders());
      expect(search('tazminatı', db).length).toBe(1);

      // 2. Simulate USB unmounted
      fs.rmSync(usbDir, { recursive: true, force: true });
      expect(fs.existsSync(usbDir)).toBe(false);

      // 3. Index run while offline
      const summary = await indexFolders(db.getIncludedFolders(), db, undefined, db.getExcludedFolders());
      expect(summary.removed).toBe(0); // Preserves offline drive index!

      // 4. Searching offline works without throwing
      const results = search('tazminatı', db);
      expect(results.length).toBe(1);
      expect(results[0].filename).toBe('usb_karar.docx');
    });

    it('TEST I — Existing Index Leakage: DB’de kayıtlı olsa bile selected modda include edilmeyen klasör KESİNLİKLE görünmemeli', async () => {
      const dirA = path.join(testBaseDir, 'DirA');
      const dirB = path.join(testBaseDir, 'DirB');
      const dirC = path.join(testBaseDir, 'DirC');

      createDoc(dirA, 'doc_a.docx');
      createDoc(dirB, 'doc_b.docx');
      createDoc(dirC, 'doc_c.docx');

      // Full index into database
      await indexFolders([dirA, dirB, dirC], db);
      expect(db.getAllDocuments().length).toBe(3);

      // Set selected mode to ONLY DirA
      db.setSearchScopeMode('selected');
      db.addSearchArea(dirA, 'include');

      const results = search('tazminatı', db);
      expect(results.length).toBe(1);
      expect(results[0].filename).toBe('doc_a.docx');

      // Even if query matches all 3 in DB, only DirA is returned
      expect(results.map(r => r.filename)).not.toContain('doc_b.docx');
      expect(results.map(r => r.filename)).not.toContain('doc_c.docx');
    });
  });

  describe('Index Hygiene (Lock Files, Temp Files, Exclusions)', () => {
    it('should skip ~$* Office lock files, *.tmp files, and ._* system metadata', () => {
      expect(shouldSkipFile('~$WordDocument.docx')).toBe(true);
      expect(shouldSkipFile('~$Sample.doc')).toBe(true);
      expect(shouldSkipFile('~$Excel.xlsx')).toBe(true);
      expect(shouldSkipFile('document.tmp')).toBe(true);
      expect(shouldSkipFile('temp_data.TMP')).toBe(true);
      expect(shouldSkipFile('._sample.pdf')).toBe(true);
      expect(shouldSkipFile('.DS_Store')).toBe(true);
      expect(shouldSkipFile('Thumbs.db')).toBe(true);

      expect(shouldSkipFile('sample.docx')).toBe(false);
      expect(shouldSkipFile('karar.pdf')).toBe(false);
      expect(shouldSkipFile('dava.udf')).toBe(false);
      expect(shouldSkipFile('tazminat.doc')).toBe(false);
    });

    it('should not scan or index lock or temp files when crawling directories', async () => {
      const testDir = path.join(testBaseDir, 'hygiene_docs');
      fs.mkdirSync(testDir, { recursive: true });

      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(testDir, 'valid.docx'));
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(testDir, '~$valid.docx'));
      fs.writeFileSync(path.join(testDir, 'test.tmp'), 'Temporary binary cache');
      fs.writeFileSync(path.join(testDir, '._valid.docx'), 'Mac resource fork');

      const scanned = await scanDirectory(testDir);
      const names = scanned.map(f => f.filename);

      expect(names).toContain('valid.docx');
      expect(names).not.toContain('~$valid.docx');
      expect(names).not.toContain('test.tmp');
      expect(names).not.toContain('._valid.docx');
      expect(scanned.length).toBe(1);
    });
  });

  describe('Path Matching & Normalization (Windows & macOS)', () => {
    it('should match subpaths correctly regardless of trailing slashes', () => {
      expect(isPathOrSubpath('/Users/test/Documents', '/Users/test/Documents/sub/file.docx')).toBe(true);
      expect(isPathOrSubpath('/Users/test/Documents/', '/Users/test/Documents/sub/file.docx')).toBe(true);
      expect(isPathOrSubpath('/Users/test/Documents', '/Users/test/Documents')).toBe(true);
      expect(isPathOrSubpath('/Users/test/Documents', '/Users/test/Other/file.docx')).toBe(false);
      expect(isPathOrSubpath('/Users/test/Doc', '/Users/test/Documents/file.docx')).toBe(false);
    });

    it('should correctly check excluded path list', () => {
      const excluded = ['/Users/test/Private', '/Users/test/Downloads/Temp'];
      expect(isPathExcluded('/Users/test/Private/document.pdf', excluded)).toBe(true);
      expect(isPathExcluded('/Users/test/Downloads/Temp/file.udf', excluded)).toBe(true);
      expect(isPathExcluded('/Users/test/Documents/file.docx', excluded)).toBe(false);
    });

    it('should handle Windows backslashes and case-insensitive paths when run on Windows platform', () => {
      const norm1 = isPathOrSubpath('C:\\Users\\John\\Documents', 'C:\\Users\\John\\Documents\\report.docx');
      expect(norm1).toBe(true);

      const norm2 = isPathOrSubpath('C:/Users/John/Documents', 'C:/Users/John/Documents/sub/report.docx');
      expect(norm2).toBe(true);
    });
  });

  describe('Permission Denied & Robust Error Recovery', () => {
    it('should continue indexing other folders if one folder is unreadable', async () => {
      const rootDir = path.join(testBaseDir, 'PermRoot');
      const validFolder = path.join(rootDir, 'Valid');
      fs.mkdirSync(validFolder, { recursive: true });
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(validFolder, 'valid.docx'));

      const nonExistent = path.join(rootDir, 'DoesNotExist');

      const summary = await indexFolders([nonExistent, validFolder], db);
      expect(summary.scanned).toBe(1);
      expect(summary.indexed).toBe(1);
      expect(search('tazminatı', db).length).toBe(1);
    });

    it('should return the standard graceful Turkish error message for inaccessible files', () => {
      const INACCESSIBLE_FILE_ERROR = 'Bu dosyaya şu anda erişilemiyor. Dosya taşınmış, silinmiş veya ilgili sürücü bağlı olmayabilir.';
      const nonExistentPath = '/path/to/missing/file.docx';
      expect(fs.existsSync(nonExistentPath)).toBe(false);
      expect(INACCESSIBLE_FILE_ERROR).toBe('Bu dosyaya şu anda erişilemiyor. Dosya taşınmış, silinmiş veya ilgili sürücü bağlı olmayabilir.');
    });
  });

  describe('Path Precedence & Cloud/Dataless Invariants (USER EXCLUDE > USER EXPLICIT INCLUDE > SYSTEM EXCLUDE)', () => {
    it('should allow explicitly included folders inside system-skipped areas (e.g. CloudStorage inside Library)', () => {
      const home = os.homedir();
      const libraryPath = path.join(home, 'Library');
      const cloudDrivePath = path.join(libraryPath, 'CloudStorage', 'GoogleDrive-XYZ');

      // 1. Without explicit include: general Library folder is skipped
      expect(shouldSkipDirectory('Library', libraryPath, [], [])).toBe(true);

      // 2. With explicit include: Library path is recognized as an ancestor/container and not skipped
      expect(shouldSkipDirectory('Library', libraryPath, [], [cloudDrivePath])).toBe(false);
      expect(shouldSkipDirectory('CloudStorage', path.join(libraryPath, 'CloudStorage'), [], [cloudDrivePath])).toBe(false);
      expect(shouldSkipDirectory('GoogleDrive-XYZ', cloudDrivePath, [], [cloudDrivePath])).toBe(false);
    });

    it('should uphold USER EXCLUDE as strictly higher priority than USER EXPLICIT INCLUDE', () => {
      const customFolder = path.join(testBaseDir, 'MyWork');
      const privateSubFolder = path.join(customFolder, 'Confidential');

      const explicitIncludes = [customFolder];
      const explicitExcludes = [privateSubFolder];

      // Parent folder is included
      expect(shouldSkipDirectory('MyWork', customFolder, explicitExcludes, explicitIncludes)).toBe(false);

      // Private subfolder is explicitly excluded -> MUST BE SKIPPED
      expect(shouldSkipDirectory('Confidential', privateSubFolder, explicitExcludes, explicitIncludes)).toBe(true);
    });

    it('should identify and skip dataless / online-only placeholder files from native stats flags', () => {
      // Mock stats object with macOS SF_DATALESS flag (0x40000000)
      const mockDatalessStats = {
        flags: 0x40000000,
        size: 0,
        isFile: () => true,
        isDirectory: () => false
      } as any;

      const mockLocalStats = {
        flags: 0,
        size: 1024,
        isFile: () => true,
        isDirectory: () => false
      } as any;

      expect(isDatalessPlaceholder(mockDatalessStats)).toBe(true);
      expect(shouldSkipFile('online_only.pdf', mockDatalessStats)).toBe(true);
      expect(isDatalessPlaceholder(mockLocalStats)).toBe(false);
      expect(shouldSkipFile('local.pdf', mockLocalStats)).toBe(false);
    });

    it('should identify dataless placeholders from the macOS stat fallback when Node Stats has no flags', () => {
      const nodeStatsWithoutFlags = {
        size: 42,
        isFile: () => true,
        isDirectory: () => false
      } as any;

      expect(isDatalessPlaceholder(nodeStatsWithoutFlags, 0x40000060)).toBe(true);
      expect(shouldSkipFile('remote-only.udf', nodeStatsWithoutFlags, 0x40000060)).toBe(true);
      expect(isDatalessPlaceholder(nodeStatsWithoutFlags, 0x40)).toBe(false);
      expect(shouldSkipFile('downloaded.udf', nodeStatsWithoutFlags, 0x40)).toBe(false);
    });

    it('should map batched macOS stat flags by argument index without parsing file paths', () => {
      const filePaths = [
        '/tmp/first:document.udf',
        '/tmp/a filename with spaces.pdf',
        '/tmp/missing.docx'
      ];

      const flags = parseDarwinStatFlagsOutput(
        '1:0x40000060\n2:0\nstat: /tmp/missing.docx: stat: No such file or directory\n',
        filePaths
      );

      expect(flags.get(filePaths[0])).toBe(0x40000060);
      expect(flags.get(filePaths[1])).toBe(0);
      expect(flags.has(filePaths[2])).toBe(false);
    });
  });

  describe('v0.2.1 Zero-Scope & Stale Count Regression (spec §2, §3)', () => {
    function createDoc(folder: string, filename: string) {
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, filename);
      fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), target);
      return target;
    }

    it('selected mode with zero included folders reports zero in-scope count without falling back to "all"', async () => {
      const folderA = path.join(testBaseDir, 'FolderA');
      createDoc(folderA, 'a.docx');
      db.setSearchScopeMode('all');
      await indexFolders([folderA], db);

      // Real DB total is 1, but scope is now "selected" with nothing chosen.
      db.setSearchScopeMode('selected');
      expect(db.getInScopeDocumentCount('selected', db.getIncludedFolders(), db.getExcludedFolders())).toBe(0);
      // The raw DB total must be unaffected — this is a display/count fix, not a purge.
      expect(db.getAllDocuments().length).toBe(1);
    });

    it('in-scope count matches what search() actually returns for the same scope', async () => {
      const folderA = path.join(testBaseDir, 'FolderA');
      const folderB = path.join(testBaseDir, 'FolderB');
      createDoc(folderA, 'a.docx');
      createDoc(folderB, 'b.docx');
      db.setSearchScopeMode('all');
      await indexFolders([folderA, folderB], db);

      db.setSearchScopeMode('selected');
      db.addSearchArea(folderA, 'include');

      const inScopeCount = db.getInScopeDocumentCount('selected', db.getIncludedFolders(), db.getExcludedFolders());
      const results = search('tazminatı', db);

      expect(inScopeCount).toBe(1);
      expect(results.length).toBe(1);
      expect(results[0].path).toBe(path.join(folderA, 'a.docx'));
    });

    it('removing search areas down to zero does not resurrect a stale total, and re-adding restores visibility without a purge', async () => {
      const folderA = path.join(testBaseDir, 'FolderA');
      createDoc(folderA, 'a.docx');
      db.setSearchScopeMode('selected');
      db.addSearchArea(folderA, 'include');
      await indexFolders([folderA], db, undefined, db.getExcludedFolders(), db.getIncludedFolders());

      expect(db.getInScopeDocumentCount('selected', db.getIncludedFolders(), db.getExcludedFolders())).toBe(1);

      // Remove the only included folder -> zero scope.
      db.removeSearchArea(folderA);
      expect(db.getIncludedFolders().length).toBe(0);
      expect(db.getInScopeDocumentCount('selected', db.getIncludedFolders(), db.getExcludedFolders())).toBe(0);
      expect(search('tazminatı', db).length).toBe(0);
      // The document itself is untouched (fast re-toggle without a re-scan, matching existing behavior).
      expect(db.getAllDocuments().length).toBe(1);

      // Re-adding the same folder immediately restores visibility, no re-scan needed.
      db.addSearchArea(folderA, 'include');
      expect(db.getInScopeDocumentCount('selected', db.getIncludedFolders(), db.getExcludedFolders())).toBe(1);
      expect(search('tazminatı', db).length).toBe(1);
    });

    it('indexAccessibleDocuments short-circuits cleanly at zero folders: single completed(0) event, no scan', async () => {
      const folderA = path.join(testBaseDir, 'FolderA');
      createDoc(folderA, 'a.docx');
      db.setSearchScopeMode('all');
      await indexFolders([folderA], db);

      db.setSearchScopeMode('selected'); // zero included folders

      const events: any[] = [];
      const summary = await indexAccessibleDocuments(db, (p) => events.push(p));

      expect(summary).toEqual({ scanned: 0, indexed: 0, skipped: 0, failed: 0, removed: 0, skippedDataless: 0, keptCloudOnly: 0, ocrRecognized: 0, ocrPending: 0 });
      expect(events).toEqual([{ total: 0, current: 0, status: 'completed' }]);
      // Pre-existing indexed doc from the earlier "all" scan is still in the DB
      // (no accidental purge/rescan), but out of scope.
      expect(db.getAllDocuments().length).toBe(1);
      expect(db.getInScopeDocumentCount('selected', [], [])).toBe(0);
    });

    it('getAllDocumentPaths returns exactly the same path set as getAllDocuments (path-only projection correctness)', async () => {
      const folderA = path.join(testBaseDir, 'FolderA');
      createDoc(folderA, 'a.docx');
      createDoc(folderA, 'b.docx');
      db.setSearchScopeMode('all');
      await indexFolders([folderA], db);

      const full = db.getAllDocuments().map(d => d.path).sort();
      const pathsOnly = db.getAllDocumentPaths().map(d => d.path).sort();
      expect(pathsOnly).toEqual(full);
    });
  });
});
