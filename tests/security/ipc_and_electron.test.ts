// What a renderer can make the main process do, and the Electron settings the
// shipped app runs with. The rules are pure functions (src/main/security.ts);
// the wiring in main.ts, the pages and the packaging config are checked from
// their source, since Electron itself does not run under vitest.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  absolutePath,
  boundedString,
  findForbiddenSwitch,
  hasOpenableExtension,
  isAllowedExternalUrl,
  isNetworkPath,
  isOpenableDocument,
  isSearchAreaType,
  isSearchScopeMode,
  isTrustedRendererUrl,
  MAX_PATH_LENGTH
} from '../../src/main/security.js';

const ROOT = path.resolve(__dirname, '../..');
// Git on the Windows runner checks files out with CRLF line endings.
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
const FEEDBACK = 'raci@yuksekbas.av.tr';

describe('which pages may talk to the main process', () => {
  const macDir = '/Applications/MetinBul.app/Contents/Resources/app.asar/dist/renderer';
  const winDir = 'C:\\Program Files\\MetinBul\\resources\\app.asar\\dist\\renderer';
  // POSIX file URLs written out, so the test reads the same on a Windows
  // host (pathToFileURL would put a drive letter in front there).
  const macUrl = (posixPath: string) => `file://${encodeURI(posixPath)}`;

  it('accepts MetinBul\'s own three pages, with or without a query string', () => {
    for (const page of ['index.html', 'quick-search.html', 'settings.html']) {
      expect(isTrustedRendererUrl(macUrl(`${macDir}/${page}`), macDir, 'darwin')).toBe(true);
    }
    expect(isTrustedRendererUrl(`${macUrl(`${macDir}/settings.html`)}?section=about&checkUpdates=1`, macDir, 'darwin')).toBe(true);
    expect(isTrustedRendererUrl('file:///C:/Program%20Files/MetinBul/resources/app.asar/dist/renderer/index.html', winDir, 'win32')).toBe(true);
    expect(isTrustedRendererUrl('file:///c:/program files/metinbul/resources/app.asar/dist/renderer/SETTINGS.html', winDir, 'win32')).toBe(true);
  });

  it('refuses any other page: remote sites, other local files, look-alike folders', () => {
    const refused = [
      'https://example.com/index.html',
      'http://localhost/index.html',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'javascript:alert(1)',
      'devtools://devtools/bundled/inspector.html',
      macUrl(`${macDir}/../../../../../evil/index.html`),
      macUrl('/tmp/index.html'),
      macUrl(`${macDir}-evil/index.html`),
      macUrl(`${macDir}/sub/index.html`),
      macUrl(`${macDir}/other.html`),
      `file://attacker-host${macDir}/index.html`,
      'not a url'
    ];
    for (const url of refused) {
      expect(isTrustedRendererUrl(url, macDir, 'darwin'), url).toBe(false);
    }
    expect(isTrustedRendererUrl('file://server/share/dist/renderer/index.html', winDir, 'win32')).toBe(false);
  });

  it('still works when MetinBul is installed in an awkward place', () => {
    // A '%' in a folder name, left as it is by Electron's loadFile.
    expect(isTrustedRendererUrl('file:///Users/a%b/MetinBul.app/r/index.html', '/Users/a%b/MetinBul.app/r', 'darwin')).toBe(true);
    expect(isTrustedRendererUrl('file:///C:/Users/a%b/MetinBul/r/index.html', 'C:\\Users\\a%b\\MetinBul\\r', 'win32')).toBe(true);
    // A Windows network share.
    expect(isTrustedRendererUrl('file://server/share/MetinBul/r/index.html', '\\\\server\\share\\MetinBul\\r', 'win32')).toBe(true);
    expect(isTrustedRendererUrl('file://other/share/MetinBul/r/index.html', '\\\\server\\share\\MetinBul\\r', 'win32')).toBe(false);
  });
});

describe('which links MetinBul hands to the operating system', () => {
  it('opens its releases page and a mail to the feedback address', () => {
    for (const url of [
      'https://github.com/raciyuksekbas-hub/metinbul-releases',
      'https://github.com/raciyuksekbas-hub/metinbul-releases/releases',
      'https://github.com/raciyuksekbas-hub/metinbul-releases/releases/tag/v0.4.2',
      `mailto:${FEEDBACK}?subject=MetinBul%20Geribildirim&body=x`,
      'mailto:RACI@YUKSEKBAS.AV.TR'
    ]) {
      expect(isAllowedExternalUrl(url, FEEDBACK), url).toBe(true);
    }
  });

  it('refuses everything else, including look-alikes and other programs\' protocols', () => {
    for (const url of [
      'http://github.com/raciyuksekbas-hub/metinbul-releases',
      'https://github.com.evil.example/raciyuksekbas-hub/metinbul-releases',
      'https://evil.example/https://github.com/raciyuksekbas-hub/metinbul-releases',
      'https://github.com/raciyuksekbas-hub/metinbul-releases-evil',
      'https://github.com/raciyuksekbas-hub/metinbul',
      'https://github.com/attacker/repo',
      'https://user:pass@github.com/raciyuksekbas-hub/metinbul-releases',
      'https://github.com:8443/raciyuksekbas-hub/metinbul-releases',
      'https://github.com/raciyuksekbas-hub/metinbul-releases/../../attacker',
      'mailto:attacker@example.com',
      `mailto:attacker@example.com,${FEEDBACK}`,
      `mailto:${FEEDBACK}?cc=attacker@example.com&body=x`,
      `mailto:${FEEDBACK}?subject=a&BCC=attacker@example.com`,
      `mailto:${FEEDBACK}?to=attacker@example.com`,
      'file:///Applications/Calculator.app',
      'smb://attacker/share',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'javascript:alert(1)',
      'x'.repeat(10_000),
      42,
      null
    ]) {
      expect(isAllowedExternalUrl(url, FEEDBACK), String(url).slice(0, 80)).toBe(false);
    }
  });
});

describe('what a renderer may have opened', () => {
  const index = new Set(['/Users/av/Belgeler/dilekce.udf', '/Users/av/Belgeler/karar.pdf', 'C:\\Belgeler\\sozlesme.docx']);
  const isIndexed = (p: string) => index.has(p);

  it('opens an indexed document of a supported type', () => {
    expect(isOpenableDocument('/Users/av/Belgeler/dilekce.udf', isIndexed, 'darwin')).toBe(true);
    expect(isOpenableDocument('/Users/av/Belgeler/karar.pdf', isIndexed, 'darwin')).toBe(true);
    expect(isOpenableDocument('C:\\Belgeler\\sozlesme.docx', isIndexed, 'win32')).toBe(true);
  });

  it('refuses programs, scripts and anything not in the index', () => {
    for (const value of [
      '/Applications/Calculator.app',
      '/Users/av/Downloads/kurulum.command',
      '/bin/sh',
      'C:\\Windows\\System32\\cmd.exe',
      '/Users/av/Belgeler/baska.pdf',
      'Belgeler/dilekce.udf',
      '/Users/av/Belgeler/dilekce.udf\0.app',
      '',
      undefined,
      { path: '/Users/av/Belgeler/dilekce.udf' }
    ]) {
      expect(isOpenableDocument(value, isIndexed, 'darwin'), String(value)).toBe(false);
    }
  });

  it('judges the file a link really leads to', () => {
    expect(hasOpenableExtension('/Users/av/Belgeler/dilekce.PDF', 'darwin')).toBe(true);
    expect(hasOpenableExtension('/Users/av/Downloads/payload', 'darwin')).toBe(false);
    expect(hasOpenableExtension('/System/Applications/Calculator.app', 'darwin')).toBe(false);
  });

  it('validates the plain values of the other channels', () => {
    expect(boundedString('abc', 3)).toBe('abc');
    expect(boundedString('abcd', 3)).toBeNull();
    expect(boundedString(5, 3)).toBeNull();
    expect(absolutePath('/Users/av', 'darwin')).toBe('/Users/av');
    expect(absolutePath('C:\\Users\\av', 'win32')).toBe('C:\\Users\\av');
    expect(absolutePath('göreli/yol', 'darwin')).toBeNull();
    expect(absolutePath('/a\0b', 'darwin')).toBeNull();
    expect(absolutePath(`/${'a'.repeat(MAX_PATH_LENGTH)}`, 'darwin')).toBeNull();
    expect(isSearchAreaType('include') && isSearchAreaType('exclude')).toBe(true);
    expect(isSearchAreaType('INCLUDE') || isSearchAreaType('')).toBe(false);
    expect(isSearchScopeMode('all') && isSearchScopeMode('selected')).toBe(true);
    expect(isSearchScopeMode('everything')).toBe(false);
  });
});

describe('hiding MetinBul from screen sharing', () => {
  it('is applied to every window when made and when the setting changes', () => {
    const main = read('src/main/main.ts');
    expect(main).toContain("contentProtection = parseBooleanSetting(appDb.getAppSetting('content_protection'), false);");
    expect(main).toMatch(/quickSearchWindow = win;\s*win\.setContentProtection\(contentProtection\);/);
    expect(main).toMatch(/settingsWindow = win;\s*win\.setContentProtection\(contentProtection\);/);
    expect(main).toMatch(/mainWindow = new BrowserWindow\(\{[\s\S]*?\n  \}\);\s*mainWindow\.setContentProtection\(contentProtection\);/);
    expect(main).toMatch(/handle\('app:setContentProtection'[\s\S]{0,300}for \(const win of allWindows\(\)\) win\.setContentProtection\(contentProtection\);/);
  });
});

describe('network folders a page names', () => {
  it('are recognised in every Windows spelling, and only on Windows', () => {
    for (const p of ['\\\\sunucu\\pay', '\\\\?\\UNC\\sunucu\\pay', '//sunucu/pay', '\\\\192.168.1.5\\Belgeler']) {
      expect(isNetworkPath(p, 'win32'), p).toBe(true);
    }
    expect(isNetworkPath('C:\\Users\\Ali\\Belgeler', 'win32')).toBe(false);
    expect(isNetworkPath('//Volumes/Pay', 'darwin')).toBe(false);
  });

  it('are taken only when the folder picker returned them in this session', () => {
    const main = read('src/main/main.ts');
    expect(main).toMatch(/function isPickedOrLocal\(folderPath: string\): boolean \{\s*return !isNetworkPath\(folderPath\) \|\| pickedFolders\.has\(folderPath\);/);
    // Before anything looks the folder up.
    expect(main).toMatch(/handle\('app:addSearchArea'[\s\S]{0,400}if \(!isPickedOrLocal\(folderPath\)\) return false;\s*if \(!fs\.statSync/);
    expect(main).toMatch(/handle\('app:completeOnboarding'[\s\S]{0,700}if \(folderPath && isPickedOrLocal\(folderPath\)\)/);
    expect(main).toMatch(/pickedFolders\.add\(folder\);\s*return folder;/);
  });
});

describe('how main.ts wires it', () => {
  const main = read('src/main/main.ts');

  it('serves every channel through the sender check', () => {
    // The only direct registration is the one inside handle().
    expect(main.match(/ipcMain\.handle\(/g)?.length).toBe(1);
    expect(main.match(/ipcMain\.on\(/g)).toBeNull();
    expect(main).toMatch(/function handle\([\s\S]{0,300}if \(!isTrustedSender\(event\)\)/);
    expect(main).toMatch(/function isTrustedSender[\s\S]{0,300}frame\.parent !== null[\s\S]{0,200}isTrustedRendererUrl\(frame\.url, rendererDir\)/);
  });

  it('opens and reveals only indexed documents, and links only through the allowlist', () => {
    expect(main).toMatch(/handle\('app:openFile'[\s\S]{0,400}isOpenableIndexedDocument\(filePath\)[\s\S]{0,300}shell\.openPath/);
    expect(main).toMatch(/handle\('app:showInFolder'[\s\S]{0,300}isOpenableIndexedDocument\(filePath\)/);
    expect(main).toMatch(/handle\('quick-search:showResultMenu'[\s\S]{0,300}isOpenableIndexedDocument\(filePath\)/);
    expect(main).toMatch(/handle\('app:openExternal'[\s\S]{0,300}isAllowedExternalUrl\(url, FEEDBACK_EMAIL\)[\s\S]{0,100}shell\.openExternal/);
    expect(main.match(/shell\.openExternal\(/g)?.length).toBe(2); // the allowlisted one and the fixed feedback mail
    expect(main).toMatch(/handle\('app:addSearchArea'[\s\S]{0,400}absolutePath\(value\)[\s\S]{0,100}isSearchAreaType\(type\)/);
  });

  it('runs every window sandboxed, without Node, with isolation and without spellcheck', () => {
    const windows = main.match(/webPreferences: \{[\s\S]*?\n {4}\}/g) ?? [];
    expect(windows.length).toBe(3);
    for (const prefs of windows) {
      expect(prefs).toContain('nodeIntegration: false');
      expect(prefs).toContain('contextIsolation: true');
      expect(prefs).toContain('sandbox: true');
      expect(prefs).toContain('spellcheck: false');
    }
    expect(main).not.toMatch(/sandbox: false|nodeIntegration: true|contextIsolation: false|webSecurity: false|allowRunningInsecureContent/);
    // Not app.enableSandbox(): with --no-sandbox it crashes the app on Windows.
    expect(main).not.toMatch(/^app\.enableSandbox\(\)/m);
  });

  it('a packaged macOS app refuses switches that would let another program drive it', () => {
    for (const argv of [
      ['/A/MetinBul', '--remote-debugging-port=9222'],
      ['/A/MetinBul', '-remote-debugging-port=9222'],
      ['/A/MetinBul', '--remote-debugging-pipe'],
      ['/A/MetinBul', '--inspect-brk=9229'],
      ['/A/MetinBul', '--js-flags=--allow-natives-syntax'],
      ['/A/MetinBul', '--renderer-cmd-prefix=/tmp/x'],
      ['/A/MetinBul', '--gpu-launcher=/tmp/x'],
      ['/A/MetinBul', '--REMOTE-DEBUGGING-PORT=1']
    ]) {
      expect(findForbiddenSwitch(argv), argv[1]).not.toBeNull();
    }
    for (const argv of [
      ['/A/MetinBul'],
      ['/A/MetinBul', '--user-data-dir=/tmp/p', '--disable-gpu', '--no-sandbox'],
      ['/A/MetinBul', '--hidden', 'psn_0_123'],
      ['/A/MetinBul', '/Users/av/remote-debugging-port.pdf']
    ]) {
      expect(findForbiddenSwitch(argv), argv.join(' ')).toBeNull();
    }
    // Checked before anything else runs, in packaged macOS builds only.
    expect(main).toMatch(/if \(app\.isPackaged && process\.platform === 'darwin'\) \{\s*const forbidden = findForbiddenSwitch\(process\.argv\);\s*if \(forbidden\) \{[\s\S]{0,120}process\.exit\(1\)/);
    expect(main.indexOf('findForbiddenSwitch(process.argv)')).toBeLessThan(main.indexOf("app.on('web-contents-created'"));
  });

  it('opens a document only if the file it really is is a document', () => {
    expect(main).toMatch(/function isOpenableIndexedDocument[\s\S]{0,500}fs\.realpathSync\(value\)[\s\S]{0,120}isFile\(\) && hasOpenableExtension\(target\)/);
  });

  it('refuses navigation, new windows, webviews and every permission request', () => {
    expect(main).toMatch(/app\.on\('web-contents-created'[\s\S]{0,400}will-navigate', event => event\.preventDefault\(\)/);
    expect(main).toMatch(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
    expect(main).toMatch(/will-attach-webview', event => event\.preventDefault\(\)/);
    expect(main).toMatch(/setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/);
    expect(main).toMatch(/setPermissionCheckHandler\(\(\) => false\)/);
    expect(main).toMatch(/process\.umask\(0o077\)/);
  });
});

describe('the pages and the package', () => {
  it('every page carries a strict Content Security Policy', () => {
    for (const page of ['index.html', 'quick-search.html', 'settings.html']) {
      const html = read(`src/renderer/${page}`);
      const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
      expect(csp, page).toContain("default-src 'none'");
      expect(csp, page).toContain("script-src 'self'");
      expect(csp, page).toContain("connect-src 'none'");
      expect(csp, page).toContain("object-src 'none'");
      expect(csp, page).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
      // Nothing on the page that this policy would have to allow.
      expect(html).not.toMatch(/<script>|<style|\sstyle="|\son[a-z]+="/);
    }
  });

  it('the preload script needs nothing a sandboxed preload lacks', () => {
    const imports = [...read('src/main/preload.ts').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports).toEqual(['electron']);
  });

  it('the macOS app is packaged with the risky Electron fuses switched off', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.build.afterPack).toBe('scripts/electron-fuses.cjs');
    const hook = read('scripts/electron-fuses.cjs');
    for (const fuse of ['runAsNode: false', 'enableNodeOptionsEnvironmentVariable: false', 'enableNodeCliInspectArguments: false', 'onlyLoadAppFromAsar: true', 'enableEmbeddedAsarIntegrityValidation: true']) {
      expect(hook).toContain(fuse);
    }
    expect(pkg.build.mac.hardenedRuntime).toBe(true);
    // The only entitlement V8 needs; nothing that loosens the hardened runtime.
    const entitlements = read('build/entitlements.mac.plist');
    expect([...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1])).toEqual(['com.apple.security.cs.allow-jit']);
  });
});
