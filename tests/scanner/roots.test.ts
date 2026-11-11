import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { discoverSearchRoots } from '../../src/scanner/roots.js';
import { scanDirectory, shouldSkipDirectory, EXCLUDED_DIR_NAMES } from '../../src/scanner/scanner.js';
import { FIXTURES_DIR, setupFixtures } from '../fixtures/create_fixtures.js';
import { beforeAll } from 'vitest';

describe('Search Roots Discovery & Scanner Scope', () => {
  const tempTestDir = path.join(FIXTURES_DIR, 'test_scope_ws');

  beforeAll(() => {
    setupFixtures();
  });

  it('should include home directory in discovered search roots', async () => {
    const roots = await discoverSearchRoots();
    const home = os.homedir();
    expect(roots).toContain(fs.realpathSync(home));
  });

  it('should not contain duplicate roots', async () => {
    const roots = await discoverSearchRoots();
    const unique = new Set(roots);
    expect(roots.length).toBe(unique.size);
  });

  it('should exclude standard noise directories (.git, node_modules, .Trash, caches, logs, .app)', () => {
    expect(shouldSkipDirectory('.git', '/path/.git')).toBe(true);
    expect(shouldSkipDirectory('node_modules', '/path/node_modules')).toBe(true);
    expect(shouldSkipDirectory('.Trash', '/path/.Trash')).toBe(true);
    expect(shouldSkipDirectory('Caches', '/path/Caches')).toBe(true);
    expect(shouldSkipDirectory('Application Support', '/path/Application Support')).toBe(true);
    expect(shouldSkipDirectory('Containers', '/path/Containers')).toBe(true);
    expect(shouldSkipDirectory('Logs', '/path/Logs')).toBe(true);
    expect(shouldSkipDirectory('Slack.app', '/Applications/Slack.app')).toBe(true);
    expect(shouldSkipDirectory('MyDoc.docx', '/path/MyDoc.docx')).toBe(false);
  });

  it('should skip ~/Library in general when scanning home', () => {
    const home = os.homedir();
    const libPath = path.join(home, 'Library');
    expect(shouldSkipDirectory('Library', libPath)).toBe(true);
  });

  it('should not scan inside excluded folders during directory walk', async () => {
    if (fs.existsSync(tempTestDir)) {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempTestDir, { recursive: true });

    // Valid folder with docx
    const validDir = path.join(tempTestDir, 'Documents');
    fs.mkdirSync(validDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(validDir, 'valid.docx'));

    // Excluded folder (.git) with docx
    const gitDir = path.join(tempTestDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(gitDir, 'ignored.docx'));

    // Excluded folder (node_modules) with docx
    const nodeModulesDir = path.join(tempTestDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(nodeModulesDir, 'ignored.docx'));

    // Excluded bundle (.app) with docx
    const appDir = path.join(tempTestDir, 'Calculator.app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(appDir, 'ignored.docx'));

    const scanned = await scanDirectory(tempTestDir);
    const filenames = scanned.map(s => s.filename);

    expect(filenames).toContain('valid.docx');
    expect(filenames).not.toContain('ignored.docx');
    expect(scanned.length).toBe(1);

    fs.rmSync(tempTestDir, { recursive: true, force: true });
  });

  it('should handle broken symlinks and unreadable directories without halting the scan', async () => {
    if (fs.existsSync(tempTestDir)) {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempTestDir, { recursive: true });

    // Valid file
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(tempTestDir, 'valid.docx'));

    // Broken symlink
    const brokenLink = path.join(tempTestDir, 'broken_link.docx');
    try {
      fs.symlinkSync(path.join(tempTestDir, 'non_existent_target.docx'), brokenLink);
    } catch {}

    const scanned = await scanDirectory(tempTestDir);
    expect(scanned.some(f => f.filename === 'valid.docx')).toBe(true);

    fs.rmSync(tempTestDir, { recursive: true, force: true });
  });
});
