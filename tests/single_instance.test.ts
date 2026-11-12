import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// Electron's app lifecycle cannot be exercised in-process under vitest, and
// nothing else in this suite boots Electron. These are deliberately
// source-level guards: MetinBul now stays resident after its window closes,
// so silently losing the single-instance lock would let a second process
// open the same SQLite profile and steal the Option+Space registration --
// a failure that only shows up as "the shortcut stopped working". The real
// runtime behaviour is verified against the packaged .app during release
// smoke testing.
const MAIN_TS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main/main.ts'),
  'utf-8'
);

describe('Single-instance ownership (required by background residency)', () => {
  it('acquires the single-instance lock', () => {
    expect(MAIN_TS).toMatch(/requestSingleInstanceLock\s*\(\s*\)/);
  });

  it('quits the losing instance instead of letting it run', () => {
    expect(MAIN_TS).toMatch(/if\s*\(\s*!\s*gotSingleInstanceLock\s*\)\s*\{[\s\S]{0,120}?app\.quit\s*\(\s*\)/);
  });

  it('bails out of whenReady without the lock, before opening the DB or shortcut', () => {
    // The guard must sit at the top of whenReady: a losing instance that got
    // as far as getDb() would open the real profile it must never touch.
    const whenReadyIndex = MAIN_TS.indexOf('app.whenReady()');
    const guardIndex = MAIN_TS.indexOf('if (!gotSingleInstanceLock) return;');
    // The first getDb() inside whenReady -- helpers defined above it may
    // also call getDb(), but they only ever run after this point.
    const getDbIndex = MAIN_TS.indexOf('const appDb = getDb();', whenReadyIndex);

    expect(whenReadyIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(whenReadyIndex);
    expect(getDbIndex).toBeGreaterThan(guardIndex);
  });

  it('brings MetinBul up in the running process when the user relaunches it', () => {
    expect(MAIN_TS).toMatch(/app\.on\(\s*['"]second-instance['"]/);
    const handlerIndex = MAIN_TS.indexOf("app.on('second-instance'");
    const handlerBody = MAIN_TS.slice(handlerIndex, handlerIndex + 700);
    expect(handlerBody).toContain('handleReopen(false)');
    // A relaunch while the index is still being prepared (encrypted after an
    // update) is held and answered once it is ready.
    expect(handlerBody).toMatch(/if \(!indexReady\) \{\s*reopenRequested = true;\s*return;/);
    expect(MAIN_TS).toContain('if (reopenRequested) handleReopen(false);');

    // handleReopen keeps the old main-window restore on Windows/Linux and
    // shows the search panel (or setup) on macOS -- never a second process.
    const reopenIndex = MAIN_TS.indexOf('function handleReopen(');
    const reopenBody = MAIN_TS.slice(reopenIndex, reopenIndex + 900);
    expect(reopenBody).toMatch(/if \(!usesUtilityShell\) \{\s*restoreMainWindow\(\);/);
    expect(reopenBody).toContain("openSettingsWindow('onboarding')");
    expect(reopenBody).toContain('showQuickSearch()');
  });

  it('restoreMainWindow handles closed, hidden and minimized windows alike', () => {
    const fnIndex = MAIN_TS.indexOf('function restoreMainWindow()');
    expect(fnIndex).toBeGreaterThan(-1);
    const body = MAIN_TS.slice(fnIndex, fnIndex + 500);
    expect(body).toContain('createWindow()');
    expect(body).toContain('isMinimized()');
    expect(body).toContain('.show()');
    expect(body).toContain('.focus()');
  });
});

describe('Background residency lifecycle', () => {
  it('gates the quit on the user\'s opt-in rather than on the platform', () => {
    const idx = MAIN_TS.indexOf("app.on('window-all-closed'");
    expect(idx).toBeGreaterThan(-1);
    const body = MAIN_TS.slice(idx, idx + 1200);
    // Residency became opt-in ("Pencere kapandığında arka planda açık tut"):
    // the quit must stay behind shouldStayResident(), which is what keeps
    // closing the window from killing a resident Quick Search shortcut when
    // the user asked for one -- and what makes it quit when they did not.
    expect(body).toMatch(/if\s*\(\s*!\s*shouldStayResident\s*\(\s*\)\s*\)/);
    expect(body).toContain('app.quit()');
  });

  it('keeps Cmd+Q a real quit that releases the shortcut', () => {
    const idx = MAIN_TS.indexOf("app.on('before-quit'");
    expect(idx).toBeGreaterThan(-1);
    const body = MAIN_TS.slice(idx, idx + 600);
    expect(body).toContain('isQuitting = true');
    expect(body).toContain('globalShortcut.unregisterAll()');
  });

  it('never lets a Quick Search activation drag the main window back on screen', () => {
    const idx = MAIN_TS.indexOf("app.on('activate'");
    expect(idx).toBeGreaterThan(-1);
    const body = MAIN_TS.slice(idx, idx + 700);
    expect(body).toContain('quickSearchWindow');
    expect(body).toContain('isVisible()');
    expect(body).toContain('return;');
  });
});
