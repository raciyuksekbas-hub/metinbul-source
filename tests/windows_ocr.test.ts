// Windows' own text recognition, driven through Windows PowerShell. The
// script-building tests run everywhere. The rest needs a real Windows with the
// Turkish OCR component: the CI installs it and sets
// METINBUL_EXPECT_WINDOWS_OCR, so there a missing component fails instead of
// skipping quietly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  buildWindowsOcrScript, checkWindowsOcr, createWindowsOcrEngine
} from '../src/ocr/windows-ocr.js';
import { AppDatabase, normalizeForSearch } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';
import { writeScannedPdf } from './fixtures/scanned-pdf.js';

describe('the Windows text recognition script', () => {
  it('asks for the Turkish recognizer and never falls back to another language', () => {
    for (const script of [buildWindowsOcrScript(), buildWindowsOcrScript('C:\\Temp\\job.json')]) {
      expect(script).toContain("TryCreateFromLanguage([Windows.Globalization.Language]::new('tr'))");
      expect(script).not.toContain('TryCreateFromUserProfileLanguages');
    }
  });

  it('says so when PowerShell is locked down, and releases each page once read', () => {
    for (const script of [buildWindowsOcrScript(), buildWindowsOcrScript('C:\\Temp\\job.json')]) {
      // Before anything a locked-down PowerShell would refuse.
      expect(script.split('\n')[1]).toBe("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 5 }");
    }
    expect(buildWindowsOcrScript('C:\\Temp\\job.json')).toMatch(/RecognizeAsync[\s\S]*\$bitmap\.Dispose\(\); \$stream\.Dispose\(\); \$page\.Dispose\(\)/);
  });

  it('only checks when it has no job', () => {
    const check = buildWindowsOcrScript();
    expect(check).not.toContain('RecognizeAsync');
    expect(check.trim().endsWith('exit 0')).toBe(true);
  });

  it('quotes a job path with an apostrophe in it', () => {
    expect(buildWindowsOcrScript("C:\\Users\\O'Brien\\job.json")).toContain("'C:\\Users\\O''Brien\\job.json'");
  });

  it('writes its result as UTF-8, never through the console', () => {
    const script = buildWindowsOcrScript('C:\\Temp\\job.json');
    expect(script).toContain('-Encoding UTF8');
    expect(script).toContain('[System.Text.UTF8Encoding]::new($false)');
    expect(script).not.toMatch(/Write-Output|Write-Host/);
  });
});

const LINES = [
  'İSTANBUL 3. ASLİYE HUKUK MAHKEMESİ',
  'Ortaklığın giderilmesi davası hakkında',
  'bilirkişi raporu ve ek beyan dilekçesi.',
  'Davacı vekili: Av. Örnek Şükrü Çağlayan'
];

describe.skipIf(process.platform !== 'win32')('Windows text recognition on a real Windows', () => {
  let dir: string;
  let ready = false;

  beforeAll(async () => {
    // Turkish characters in the path too: they must survive the trip to PowerShell.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-ocr-şğı-'));
    await writeScannedPdf(path.join(dir, 'tarama.pdf'), LINES);
    await writeScannedPdf(path.join(dir, 'yan.pdf'), LINES, { rotated: true });
    const status = await checkWindowsOcr();
    ready = status === 'ready';
    if (process.env.METINBUL_EXPECT_WINDOWS_OCR) expect(status).toBe('ready');
  }, 120_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the Turkish text of a scanned page, and of one stored sideways', async ctx => {
    if (!ready) ctx.skip();
    const engine = createWindowsOcrEngine();
    for (const file of ['tarama.pdf', 'yan.pdf']) {
      const [page] = await engine.recognizePdfPages(path.join(dir, file), [1]);
      const text = normalizeForSearch(page);
      expect(text, file).toContain('ortaklığın giderilmesi');
      expect(text, file).toContain('asliye hukuk mahkemesi');
      expect(text, file).toContain('şükrü çağlayan');
    }
  }, 120_000);

  it('answers page by page, with nothing for a page that does not exist', async ctx => {
    if (!ready) ctx.skip();
    const pages = await createWindowsOcrEngine().recognizePdfPages(path.join(dir, 'tarama.pdf'), [2, 1]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toBe('');
    expect(normalizeForSearch(pages[1])).toContain('ortaklığın giderilmesi');
  }, 120_000);

  it('fails on a file that is not a PDF', async ctx => {
    if (!ready) ctx.skip();
    const notPdf = path.join(dir, 'not.pdf');
    fs.writeFileSync(notPdf, 'not a pdf');
    await expect(createWindowsOcrEngine().recognizePdfPages(notPdf, [1])).rejects.toThrow(/Text recognition failed/);
  }, 120_000);

  it('makes a scanned PDF searchable through an index update', async ctx => {
    if (!ready) ctx.skip();
    const root = path.join(dir, 'Belgeler');
    fs.mkdirSync(root);
    fs.copyFileSync(path.join(dir, 'tarama.pdf'), path.join(root, 'bilirkişi raporu.pdf'));
    const db = new AppDatabase(path.join(dir, 'index.db'));
    try {
      const summary = await indexFolders([root], db, undefined, [], [], {
        ocr: { engine: createWindowsOcrEngine(), budgetMs: 60_000 }
      });
      expect(summary.ocrRecognized).toBe(1);
      expect(search('ortaklığın giderilmesi', db).map(r => r.path)).toEqual([path.join(root, 'bilirkişi raporu.pdf')]);
    } finally {
      db.close();
    }
  }, 120_000);
});
