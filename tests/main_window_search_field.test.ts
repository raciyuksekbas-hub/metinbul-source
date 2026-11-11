// The Windows main window's search field showed two clear (×) buttons: the
// one MetinBul draws, and the one Chromium adds to every type="search" input
// (tester report, 2026-11-07).
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the main window search field', () => {
  it('shows one clear button: MetinBul\'s own, not Chromium\'s as well', () => {
    const html = read('src/renderer/index.html');
    expect(html).toMatch(/<input type="search" id="search-input"/);
    expect(html).toContain('id="btn-clear-search"');

    const css = read('src/renderer/style.css');
    expect(css).toMatch(/\.search-box input::-webkit-search-cancel-button\s*\{[^}]*display:\s*none/);
  });
});
