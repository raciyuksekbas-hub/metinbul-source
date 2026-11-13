// pdf.js would load @napi-rs/canvas, a native Skia module, the moment it is
// imported; on Windows that module crashed MetinBul after the indexer thread
// that loaded it ended (0xc0000005 in skia.win32-x64-msvc.node, unloaded).
// MetinBul reads text only, so the module must never be loaded, and the text
// must come out exactly as it did with it (compared on 1,037 real PDFs on the
// developer's Mac when this changed: identical).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextOnlyDOMMatrix } from '../../src/extractors/pdfjs-env.js';
import { writeScannedPdf } from '../fixtures/scanned-pdf.js';
import { setupFixtures, FIXTURES_DIR } from '../fixtures/create_fixtures.js';

const ROOT = path.resolve(__dirname, '../..');

function runNode(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

describe('reading PDF text without the native canvas module', () => {
  let dir: string;
  let bundle: string;
  let scanned: string;

  beforeAll(async () => {
    setupFixtures();
    dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.pdf-text-only-'));
    bundle = path.join(dir, 'pdf.mjs');
    // The extractor as the indexer bundles it: pdf-parse stays a package.
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'src/extractors/pdf.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20',
      outfile: bundle, external: ['pdf-parse'], logLevel: 'silent'
    });
    scanned = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbpdf-')), 'tarama.pdf');
    await writeScannedPdf(scanned, ['Sayın Mahkeme', 'Ortaklığın giderilmesi'], { pages: 3 });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(scanned), { recursive: true, force: true });
  });

  it('reads the same text and never loads the module (in a fresh process)', async () => {
    const files = [path.join(FIXTURES_DIR, 'sample.pdf'), scanned];
    const { code, stdout, stderr } = await runNode(`
      console.log = () => {}; console.warn = () => {};
      const { extractPdfPages } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      const pages = [];
      for (const file of ${JSON.stringify(files)}) pages.push(await extractPdfPages(file));
      const native = process.report.getReport().sharedObjects.filter(lib => /skia|napi-rs|canvas/i.test(lib));
      process.stdout.write(JSON.stringify({ pages, native }));
    `);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout) as { pages: string[][]; native: string[] };
    expect(result.native).toEqual([]);
    expect(result.pages[0].join('\n')).toContain('Kidem tazminati');
    // A scanned page has no text layer: empty, for text recognition to read.
    expect(result.pages[1]).toEqual(['', '', '']);
  }, 60_000);

  it('the stand-in matrix does the 2D arithmetic pdf.js expects', () => {
    const m = new TextOnlyDOMMatrix([2, 0, 0, 3, 10, 20]);
    expect(m.transformPoint({ x: 1, y: 1 })).toMatchObject({ x: 12, y: 23 });
    const back = m.inverse().transformPoint({ x: 12, y: 23 });
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(1);
    expect(new TextOnlyDOMMatrix().translate(5, 6).scale(2).transformPoint({ x: 1, y: 1 })).toMatchObject({ x: 7, y: 8 });
    expect(new TextOnlyDOMMatrix().isIdentity).toBe(true);
  });

  it('the packaged app leaves the module out', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.build.files).toContain('!node_modules/@napi-rs/**');
  });
});
