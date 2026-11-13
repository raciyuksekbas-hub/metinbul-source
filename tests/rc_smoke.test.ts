import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { search } from '../src/search/search.js';

// A real file system, but a home folder of the test's own: this test used to
// write into the developer's -- or a reviewer's office computer's -- real
// Desktop and Documents, crawl both from end to end (and hang when iCloud
// stalled), and create and remove a "Documents/Private" folder there.
describe('Release Candidate Real Filesystem Smoke Tests (v0.2.0 Section 1)', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbrc-home-')));
  const desktopDir = path.join(home, 'Desktop');
  const docsDir = path.join(home, 'Documents');
  const downloadsDir = path.join(home, 'Downloads');

  const fileDesktop = path.join(desktopDir, 'MetinBulScopeTest.udf');
  const fileDocs = path.join(docsDir, 'MetinBulScopeTest.udf');
  const filePublic = path.join(docsDir, 'PublicSmoke.udf');
  const privateDir = path.join(docsDir, 'Private');
  const filePrivate = path.join(privateDir, 'PrivateSmoke.udf');
  const snippetDoc = path.join(desktopDir, 'MetinBulSnippetTest.udf');

  let db: AppDatabase;
  const tempDbPath = path.join(home, 'metinbul_rc_smoke_real.db');

  beforeAll(async () => {
    // 1. The home folder's usual folders
    for (const dir of [desktopDir, docsDir, downloadsDir]) fs.mkdirSync(dir, { recursive: true });

    // 2. Write real smoke files
    fs.writeFileSync(fileDesktop, '<udf>METINBUL_SCOPE_SMOKE_847261</udf>');
    fs.writeFileSync(fileDocs, '<udf>METINBUL_SCOPE_SMOKE_847261</udf>');
    fs.writeFileSync(filePublic, '<udf>METINBUL_EXCLUDE_SMOKE_928351</udf>');
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(filePrivate, '<udf>METINBUL_EXCLUDE_SMOKE_928351</udf>');
    fs.writeFileSync(snippetDoc, '<udf>Başvurucu tarafın belirtmiş olduğu aşağıdaki taşınmazlar hakkında ortaklığın giderilmesi talepli uyuşmazlık konusunda; karşı tarafların iletişim bilgileri başvurucudan ve bürodan istenmiş olup iletişime geçilmiştir.</udf>');

    // 3. Init Database
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    db = new AppDatabase(tempDbPath);

    // 4. Index Desktop and Documents (Real crawler with filtered list)
    await indexFolders([desktopDir, docsDir], db);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('TEST A — Desktop Only: should return only Desktop result', () => {
    db.setSearchScopeMode('selected');
    db.addSearchArea(desktopDir, 'include');

    const res = search('METINBUL_SCOPE_SMOKE_847261', db);
    expect(res.length).toBe(1);
    expect(res[0].path).toBe(fileDesktop);
  });

  it('TEST B — Downloads Only: should return exactly 0 results', () => {
    db.removeSearchArea(desktopDir);
    db.addSearchArea(downloadsDir, 'include');

    const res = search('METINBUL_SCOPE_SMOKE_847261', db);
    expect(res.length).toBe(0);
  });

  it('TEST C — Desktop + Documents: should return both results', () => {
    db.addSearchArea(desktopDir, 'include');
    db.addSearchArea(docsDir, 'include');

    const res = search('METINBUL_SCOPE_SMOKE_847261', db);
    expect(res.length).toBe(2);
    const paths = res.map(r => r.path);
    expect(paths).toContain(fileDesktop);
    expect(paths).toContain(fileDocs);
  });

  it('TEST D — Include + Exclude: should skip Private subfolder and return only Public', () => {
    db.removeSearchArea(desktopDir);
    db.removeSearchArea(docsDir);
    db.removeSearchArea(downloadsDir);

    db.addSearchArea(docsDir, 'include');
    db.addSearchArea(privateDir, 'exclude');

    const res = search('METINBUL_EXCLUDE_SMOKE_928351', db);
    expect(res.length).toBe(1);
    expect(res[0].path).toBe(filePublic);
  });

  it('TEST E — Snippet Visual Quality: should preserve matching and align context near center/left', () => {
    db.setSearchScopeMode('all');
    const res = search('ortaklığın giderilmesi', db);

    expect(res.length).toBeGreaterThan(0);
    const snip = res[0].snippet;
    expect(snip).toContain('<mark>ortaklığın giderilmesi</mark>');
    expect(snip.startsWith('…')).toBe(false);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('aşağıdaki taşınmazlar hakkında <mark>ortaklığın giderilmesi</mark> talepli uyuşmazlık');
  });

  it('TEST F — Turkish Case-Insensitive Highlight: should match dotted/dotless I', () => {
    db.setSearchScopeMode('all');
    const sampleText = 'İSTANBUL BÖLGE ADLİYE MAHKEMESİ';
    db.upsertDocument({
      path: '/test/istanbul_smk.udf',
      filename: 'istanbul_smk.udf',
      extension: '.udf',
      mtime: Date.now(),
      size: sampleText.length,
      content: sampleText,
      index_status: 'indexed'
    });

    const res = search('istanbul bölge', db);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].snippet).toContain('<mark>İSTANBUL BÖLGE</mark>');
  });

  it('TEST G — Query Privacy: confidential queries must never persist in database or settings', () => {
    search('METINBUL_SECRET_QUERY_817261', db);
    search('12345678901', db);
    search('Ahmet Yılmaz', db);

    const settings = db.db.prepare('SELECT * FROM app_settings').all();
    for (const s of settings as any[]) {
      expect(s.key).not.toContain('query');
      expect(s.value).not.toContain('Ahmet');
      expect(s.value).not.toContain('817261');
    }
  });
});
