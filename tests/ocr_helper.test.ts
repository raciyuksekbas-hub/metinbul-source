// The real macOS text recognition helper (native/macos/metinbul-ocr.swift),
// compiled here and run on image-only PDFs this test writes. macOS only, and
// only where the Swift compiler is installed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { createMacosOcrEngine, isMacosOcrAvailable } from '../src/ocr/ocr.js';
import { extractPdf } from '../src/extractors/pdf.js';
import { AppDatabase, normalizeForSearch } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import { writeScannedPdf } from './fixtures/scanned-pdf.js';

function hasSwiftCompiler(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const LINES = [
  'İSTANBUL 3. ASLİYE HUKUK MAHKEMESİ',
  'Ortaklığın giderilmesi davası hakkında',
  'bilirkişi raporu ve ek beyan dilekçesi.',
  'Davacı vekili: Av. Örnek Şükrü Çağlayan'
];

describe.skipIf(!hasSwiftCompiler())('macOS text recognition helper', () => {
  let dir: string;
  let helper: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-ocr-helper-'));
    helper = path.join(dir, 'metinbul-ocr');
    execFileSync('xcrun', [
      'swiftc', '-O', '-target', 'arm64-apple-macos12', '-o', helper,
      path.join(__dirname, '..', 'native', 'macos', 'metinbul-ocr.swift')
    ]);
    await writeScannedPdf(path.join(dir, 'tarama.pdf'), LINES);
    await writeScannedPdf(path.join(dir, 'yan.pdf'), LINES, { rotated: true });
  }, 240_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports Turkish recognition as available', async () => {
    expect(await isMacosOcrAvailable(helper)).toBe(true);
  });

  it('works on a real scan stand-in: a PDF with no text layer', async () => {
    expect(await extractPdf(path.join(dir, 'tarama.pdf'))).toBe('');
  });

  it('reads the Turkish text of a scanned page, and of one stored sideways', async () => {
    const engine = createMacosOcrEngine(helper);
    for (const file of ['tarama.pdf', 'yan.pdf']) {
      const [page] = await engine.recognizePdfPages(path.join(dir, file), [1]);
      const text = normalizeForSearch(page);
      expect(text, file).toContain('ortaklığın giderilmesi');
      expect(text, file).toContain('asliye hukuk mahkemesi');
      expect(text, file).toContain('şükrü çağlayan');
    }
  }, 120_000);

  it('answers page by page, with nothing for a page that does not exist', async () => {
    const pages = await createMacosOcrEngine(helper).recognizePdfPages(path.join(dir, 'tarama.pdf'), [2, 1]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toBe('');
    expect(normalizeForSearch(pages[1])).toContain('ortaklığın giderilmesi');
  }, 60_000);

  it('fails on a file that is not a PDF', async () => {
    const notPdf = path.join(dir, 'not.pdf');
    fs.writeFileSync(notPdf, 'not a pdf');
    await expect(createMacosOcrEngine(helper).recognizePdfPages(notPdf, [1])).rejects.toThrow(/Text recognition failed/);
  }, 60_000);

  it('makes a scanned PDF searchable through an index update', async () => {
    const root = path.join(dir, 'Belgeler');
    fs.mkdirSync(root);
    fs.copyFileSync(path.join(dir, 'tarama.pdf'), path.join(root, 'bilirkisi-raporu.pdf'));
    const db = new AppDatabase(path.join(dir, 'index.db'));
    try {
      const summary = await indexFolders([root], db, undefined, [], [], {
        ocr: { engine: createMacosOcrEngine(helper), budgetMs: 60_000 }
      });
      expect(summary.ocrRecognized).toBe(1);
      expect(search('ortaklığın giderilmesi', db).map(r => r.path)).toEqual([path.join(root, 'bilirkisi-raporu.pdf')]);
    } finally {
      db.close();
    }
  }, 120_000);
});
