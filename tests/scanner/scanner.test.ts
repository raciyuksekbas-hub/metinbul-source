import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { scanDirectory, scanDirectories, shouldSkipDirectory, ScanStats } from '../../src/scanner/scanner.js';
import { setupFixtures, FIXTURES_DIR } from '../fixtures/create_fixtures.js';

describe('Scanner Core (Phase 2)', () => {
  beforeAll(() => {
    setupFixtures();
  });

  it('should recursively find only supported extensions (.doc, .docx, .pdf, .udf)', async () => {
    const files = await scanDirectory(FIXTURES_DIR);
    const extensions = files.map(f => f.extension.toLowerCase());
    
    expect(extensions).toContain('.docx');
    expect(extensions).toContain('.pdf');
    expect(extensions).toContain('.udf');
    expect(extensions).not.toContain('.txt');
    expect(extensions.every(ext => ['.doc', '.docx', '.pdf', '.udf'].includes(ext))).toBe(true);
  });

  it('should extract correct metadata for scanned files', async () => {
    const files = await scanDirectory(FIXTURES_DIR);
    const docx = files.find(f => f.filename === 'sample.docx');

    expect(docx).toBeDefined();
    expect(docx?.filename).toBe('sample.docx');
    expect(docx?.extension).toBe('.docx');
    expect(docx?.size).toBeGreaterThan(0);
    expect(docx?.mtime).toBeGreaterThan(0);
  });

  it('should handle multiple directory scanning without duplicates', async () => {
    const files = await scanDirectories([FIXTURES_DIR, FIXTURES_DIR]);
    const paths = files.map(f => f.path);
    const uniquePaths = new Set(paths);
    expect(paths.length).toBe(uniquePaths.size);
  });

  it('should handle non-existent directories gracefully', async () => {
    const nonExistent = path.join(FIXTURES_DIR, 'no_such_folder_xyz');
    const files = await scanDirectory(nonExistent);
    expect(files).toEqual([]);
  });
});

describe('Dataless Skip Counting (spec §5) — generic, provider-agnostic', () => {
  const SF_DATALESS = 0x40000000;
  const testDir = path.join(FIXTURES_DIR, 'test_dataless_count_ws');
  const datalessFile = path.join(testDir, 'online_only.pdf');
  const localFile = path.join(testDir, 'local.pdf');
  const unsupportedDatalessFile = path.join(testDir, 'online_only_unsupported.txt');

  beforeAll(() => {
    setupFixtures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  function seedFiles() {
    fs.mkdirSync(testDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), datalessFile);
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), localFile);
    fs.writeFileSync(unsupportedDatalessFile, 'not a supported extension');
  }

  // Simulates a real macOS SF_DATALESS cloud placeholder by making
  // fs.promises.stat report the kernel flag for one specific path, while
  // passing every other call through to the real implementation -- avoids
  // depending on real FileProvider/chflags semantics, which aren't
  // settable from an unprivileged test process.
  function mockDatalessFlagFor(targetPaths: string[]) {
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (p: any, ...rest: any[]) => {
      const real = await (realStat as any)(p, ...rest);
      if (targetPaths.includes(String(p))) {
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'flags') return SF_DATALESS;
            const value = (target as any)[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      return real;
    });
  }

  it('counts a skipped dataless supported file without counting a normal local file', async () => {
    seedFiles();
    mockDatalessFlagFor([datalessFile]);

    const scanStats: ScanStats = { skippedDatalessSupportedCount: 0 };
    const files = await scanDirectory(testDir, new Set(), [], [], scanStats);

    const paths = files.map(f => f.path);
    expect(paths).toContain(localFile);
    expect(paths).not.toContain(datalessFile);
    expect(scanStats.skippedDatalessSupportedCount).toBe(1);
  });

  it('does not count a skipped dataless file whose extension is unsupported', async () => {
    seedFiles();
    mockDatalessFlagFor([unsupportedDatalessFile]);

    const scanStats: ScanStats = { skippedDatalessSupportedCount: 0 };
    await scanDirectory(testDir, new Set(), [], [], scanStats);

    // .txt was never a scan candidate in the first place (SUPPORTED_EXTENSIONS
    // filter runs before the dataless check), so nothing should be counted.
    expect(scanStats.skippedDatalessSupportedCount).toBe(0);
  });

  it('is purely additive: omitting the ScanStats argument changes nothing about the returned files', async () => {
    seedFiles();
    mockDatalessFlagFor([datalessFile]);

    const files = await scanDirectory(testDir, new Set(), [], []);
    const paths = files.map(f => f.path);
    expect(paths).toContain(localFile);
    expect(paths).not.toContain(datalessFile);
  });

  it('accumulates across multiple folders via scanDirectories', async () => {
    seedFiles();
    const secondDir = path.join(FIXTURES_DIR, 'test_dataless_count_ws_2');
    fs.mkdirSync(secondDir, { recursive: true });
    const secondDataless = path.join(secondDir, 'also_online_only.pdf');
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.pdf'), secondDataless);
    mockDatalessFlagFor([datalessFile, secondDataless]);

    const scanStats: ScanStats = { skippedDatalessSupportedCount: 0 };
    await scanDirectories([testDir, secondDir], [], [], scanStats);

    expect(scanStats.skippedDatalessSupportedCount).toBe(2);
    fs.rmSync(secondDir, { recursive: true, force: true });
  });

  it('does not special-case any cloud provider by matching its name in a path (generic SF_DATALESS mechanism only)', () => {
    // Forbids the exact anti-pattern the spec calls out (e.g.
    // path.includes("GoogleDrive")) -- a provider name may legitimately
    // appear in an illustrative comment (e.g. ~/Library/CloudStorage/GoogleDrive-X
    // as an example include path), so this checks for actual string-matching
    // code, not just the word's presence anywhere in the file.
    const scannerSrc = fs.readFileSync(path.join(FIXTURES_DIR, '..', '..', 'src/scanner/scanner.ts'), 'utf8');
    const providerNames = ['GoogleDrive', 'iCloud', 'Dropbox', 'OneDrive'];
    for (const name of providerNames) {
      const pattern = new RegExp(`\\.(includes|startsWith|endsWith)\\s*\\(\\s*['"\`][^'"\`]*${name}`, 'i');
      expect(scannerSrc).not.toMatch(pattern);
    }
  });

  it('user-facing dataless copy avoids the misleading "online" framing and any provider name (v0.2.1 acceptance fix)', () => {
    // A real user misread the earlier "N çevrimiçi belge indekslenmedi"
    // wording as "aren't these already online?" -- the corrected primary
    // message must say the content isn't present on the device, not that
    // the file is "online". Tooltip stays generic (no provider hardcode).
    const rendererSrc = fs.readFileSync(path.join(FIXTURES_DIR, '..', '..', 'src/renderer/renderer.ts'), 'utf8');
    const indexHtmlSrc = fs.readFileSync(path.join(FIXTURES_DIR, '..', '..', 'src/renderer/index.html'), 'utf8');

    expect(rendererSrc).toContain('bu bilgisayarda bulunmadığı için indekslenmedi');
    expect(rendererSrc).not.toContain('çevrimiçi belge indekslenmedi');

    for (const src of [rendererSrc, indexHtmlSrc]) {
      expect(src.toLowerCase()).not.toContain('googledrive');
      expect(src.toLowerCase()).not.toContain('google drive');
    }
  });
});

// A program bundle never holds the user's documents, and walking one is pure
// cost: on the real profile a Qt .framework in a build folder inside iCloud
// Documents is where an update hung (2026-10-29).
describe('Program bundles', () => {
  it('skips macOS bundles: apps, frameworks, plug-ins and the like', () => {
    const bundles = [
      'MetinBul.app', 'QtCore.framework', 'Resources.bundle', 'Codec.plugin',
      'Share.appex', 'Helper.xpc', 'Driver.kext', 'MetinBul.app.dSYM'
    ];
    for (const name of bundles) {
      expect(shouldSkipDirectory(name, path.join(os.tmpdir(), name)), name).toBe(true);
    }
    for (const name of ['Davalar', 'Dava.2024', 'Belgeler.yedek']) {
      expect(shouldSkipDirectory(name, path.join(os.tmpdir(), name)), name).toBe(false);
    }
  });

  it('finds no document inside a bundle, and the ones next to it as usual', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-bundle-'));
    try {
      const inside = path.join(dir, 'dist', 'QtCore.framework', 'Resources');
      fs.mkdirSync(inside, { recursive: true });
      fs.writeFileSync(path.join(inside, 'lisans.udf'), '<udf>lisans metni</udf>');
      fs.writeFileSync(path.join(dir, 'dist', 'notlar.udf'), '<udf>yerel not</udf>');

      const found = (await scanDirectory(dir)).map(f => path.relative(dir, f.path));
      expect(found).toEqual([path.join('dist', 'notlar.udf')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Walk order', () => {
  it('lists documents in depth-first order, as the walk always has', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-order-'));
    try {
      for (const rel of ['a.udf', 'b/c.udf', 'b/d/e.udf', 'f.udf', 'g/h.udf', 'g/i/j/k.udf', 'l.udf', 'm/n.udf']) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), '<udf>metin</udf>');
      }
      const depthFirst: string[] = [];
      const levelByLevel: string[] = [];
      (function walk(current: string) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else depthFirst.push(full);
        }
      })(dir);
      for (let level = [dir]; level.length > 0;) {
        const next: string[] = [];
        for (const current of level) {
          for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) next.push(full);
            else levelByLevel.push(full);
          }
        }
        level = next;
      }
      // The tree tells the two orders apart, so this test would notice.
      expect(levelByLevel).not.toEqual(depthFirst);

      expect((await scanDirectory(dir)).map(f => f.path)).toEqual(depthFirst);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
