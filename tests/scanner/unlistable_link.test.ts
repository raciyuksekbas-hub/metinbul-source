// A link to a folder that cannot itself be listed must not hide the folder.
//
// Turkish Windows keeps an old "Belgelerim" junction in the user folder: it
// leads to Documents, but Everyone is denied listing it. The scanner used to
// mark Documents as visited when it met the junction, before trying to read
// it; the read failed, and when it came to the real Documents folder it took
// it for done. Nothing in Documents was indexed in "Bilgisayarın Tümü".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectories } from '../../src/scanner/scanner.js';

const isWindows = process.platform === 'win32';
let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbhome-')));
  fs.mkdirSync(path.join(home, 'Documents'));
  fs.writeFileSync(path.join(home, 'Documents', 'dilekçe.udf'), '<udf>dava</udf>');
  fs.symlinkSync(path.join(home, 'Documents'), path.join(home, 'Belgelerim'), isWindows ? 'junction' : 'dir');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (isWindows) {
    try {
      execFileSync('icacls', [path.join(home, 'Belgelerim'), '/remove:d', '*S-1-1-0', '/L'], { stdio: 'ignore' });
    } catch {
      // Not denied in this test.
    }
  }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a link to a folder that cannot be listed', () => {
  it('does not stop the folder itself from being read', async () => {
    const realReaddir = fs.promises.readdir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      if (path.basename(String(dir)) === 'Belgelerim') {
        return Promise.reject(Object.assign(new Error('EPERM: operation not permitted, scandir'), { code: 'EPERM' }));
      }
      return (realReaddir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fs.promises.readdir);

    const files = await scanDirectories([home]);
    expect(files.map(file => path.relative(home, file.path))).toEqual([path.join('Documents', 'dilekçe.udf')]);
  });

  it('a readable link and its folder give the document once, under the folder\'s own name', async () => {
    const files = await scanDirectories([home]);
    expect(files.map(file => path.relative(home, file.path))).toEqual([path.join('Documents', 'dilekçe.udf')]);
  });

  it.skipIf(!isWindows)('on a real Windows junction that Everyone may not list', async () => {
    // As Windows sets up "Belgelerim" / "My Documents": deny list folder on the
    // junction itself (/L), not on its target. *S-1-1-0 is Everyone in any language.
    execFileSync('icacls', [path.join(home, 'Belgelerim'), '/deny', '*S-1-1-0:(RD)', '/L'], { stdio: 'ignore' });
    expect(() => fs.readdirSync(path.join(home, 'Belgelerim'))).toThrow();

    const files = await scanDirectories([home]);
    expect(files.map(file => path.relative(home, file.path))).toEqual([path.join('Documents', 'dilekçe.udf')]);
  });
});
