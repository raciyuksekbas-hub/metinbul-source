import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// Source-level guards over the Quick Search panel's window lifecycle in
// main.ts. Electron cannot run under vitest, so -- like
// startup_background_lifecycle.test.ts -- these pin the wiring whose
// regressions would otherwise only show up as "⌥ Space opened a second
// window", "Esc quit the app" or "my Settings window vanished". The real
// behaviour is exercised against the packaged app.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_TS = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf-8');
const QUICK_TS = fs.readFileSync(path.join(ROOT, 'src/renderer/quick-search.ts'), 'utf-8');

function sliceFrom(needle: string, length: number): string {
  const idx = MAIN_TS.indexOf(needle);
  expect(idx, `expected to find ${needle} in main.ts`).toBeGreaterThan(-1);
  return MAIN_TS.slice(idx, idx + length);
}

describe('One panel, toggled -- never a second window or instance', () => {
  it('builds the panel in exactly two places: at startup and when it is gone', () => {
    const calls = MAIN_TS.match(/createQuickSearchWindow\(\)/g) || [];
    // definition, startup, ensureQuickSearchWindow
    expect(calls.length).toBe(3);
    expect(sliceFrom('function ensureQuickSearchWindow()', 200))
      .toMatch(/if \(quickSearchWindow && !quickSearchWindow\.isDestroyed\(\)\) return quickSearchWindow;/);
  });

  it('hides on the second press of the shortcut instead of showing again', () => {
    const body = sliceFrom('function toggleQuickSearch()', 600);
    expect(body).toMatch(/win\.isVisible\(\)[\s\S]*?hideQuickSearch\('toggle'\)/);
    expect(sliceFrom('function registerQuickSearchShortcut(', 400)).toContain('globalShortcut.register(accelerator, toggleQuickSearch)');
  });

  it('rebuilds the panel after a renderer crash rather than pointing at a dead window', () => {
    const body = sliceFrom('function createQuickSearchWindow()', 4000);
    expect(body).toMatch(/'render-process-gone'[\s\S]{0,160}?quickSearchWindow = null/);
  });
});

describe('macOS panel behaviour (spec §10, §11, §31)', () => {
  const create = () => sliceFrom('function createQuickSearchWindow()', 4000);

  it('is a frameless NSPanel that stays out of Mission Control', () => {
    expect(create()).toContain("frame: !isMac");
    expect(create()).toContain("type: 'panel', hiddenInMissionControl: true");
  });

  it('joins the current Space and floats over full-screen apps', () => {
    expect(create()).toContain('setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })');
  });

  it('opens on the display under the pointer', () => {
    expect(sliceFrom('function placeQuickSearchWindow(', 600)).toContain('screen.getDisplayNearestPoint(screen.getCursorScreenPoint())');
  });

  it('dismisses itself when the user clicks into another app, but not for its own context menu', () => {
    expect(create()).toMatch(/win\.on\('blur', \(\) => \{\s*if \(!quickSearchMenuOpen\) hideQuickSearch\('blur'\);/);
    expect(sliceFrom("ipcMain.handle('quick-search:showResultMenu'", 1200)).toMatch(/quickSearchMenuOpen = true;[\s\S]*?callback: \(\) => \{\s*quickSearchMenuOpen = false;/);
  });
});

describe('Dismissing the panel never quits, and hands focus back', () => {
  it('turns Cmd+W / the close button into a hide while the app is running', () => {
    expect(create()).toMatch(/win\.on\('close', \(e\) => \{[\s\S]*?if \(!isQuitting\) \{\s*e\.preventDefault\(\);\s*hideQuickSearch\('dismiss'\);/);
    function create() { return sliceFrom('function createQuickSearchWindow()', 4000); }
  });

  it('never quits from the hide path', () => {
    const body = sliceFrom('function hideQuickSearch(', 1200);
    expect(body).not.toContain('app.quit');
    // Cleared while hidden: the next ⌥ Space never flashes the last query.
    expect(body).toContain("win.webContents.send('quick-search:reset')");
  });

  it('only hides the whole app when MetinBul is active and nothing else of it is on screen', () => {
    const body = sliceFrom('function returnFocusAfterQuickSearch()', 600);
    expect(body).toMatch(/if \(target && !target\.isDestroyed\(\) && target\.isVisible\(\)\) \{\s*target\.focus\(\);/);
    expect(body).toMatch(/appIsActive && !hasVisibleWindowOtherThanQuickSearch\(\)\) \{\s*app\.hide\(\);/);
  });

  it('remembers which MetinBul window had focus when the panel was summoned', () => {
    expect(sliceFrom('function showQuickSearch()', 1400)).toMatch(/quickSearchReturnTarget = focused && focused !== win \? focused : null;/);
  });

  it('opening a document lets that document take focus instead', () => {
    expect(sliceFrom("ipcMain.handle('app:hideQuickSearch'", 300)).toContain("hideQuickSearch(reason === 'open' ? 'open' : 'dismiss')");
  });
});

describe('Panel sizing', () => {
  it('grows with its content up to a per-display maximum, without jitter', () => {
    const body = sliceFrom("ipcMain.handle('quick-search:setHeight'", 900);
    expect(body).toContain('nextPanelHeight(');
    expect(body).toContain('contentHeight * win.webContents.getZoomFactor()');
    expect(body).toContain('{ min: QUICK_SEARCH_COMPACT_HEIGHT, max: quickSearchMaxHeight }');
  });

  it('keeps the compact height in step with the stylesheet', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf-8');
    const compact = /const QUICK_SEARCH_COMPACT_HEIGHT = (\d+);/.exec(MAIN_TS)?.[1];
    expect(css).toMatch(new RegExp(`\\.qs-field \\{[^}]*height: ${compact}px`));
  });
});

describe('Settings window and residency', () => {
  it('quits on closing Settings only when the user turned residency off (macOS)', () => {
    const body = sliceFrom('function openSettingsWindow(', 2600);
    expect(body).toMatch(/win\.on\('closed', \(\) => \{[\s\S]*?if \(usesUtilityShell && !isQuitting && !shouldStayResident\(\)\) \{\s*app\.quit\(\);/);
  });

  it('parents the folder picker to whichever window asked for it', () => {
    expect(sliceFrom("ipcMain.handle('app:selectFolder'", 700)).toContain('BrowserWindow.fromWebContents(event.sender)');
  });

  it('persists the theme in the main process so a windowless login launch keeps it', () => {
    expect(sliceFrom('function setAppTheme(', 800)).toContain("getDb().setAppSetting('theme', theme)");
    expect(MAIN_TS).toMatch(/const savedTheme = appDb\.getAppSetting\('theme'\);/);
  });
});

describe('Start at login is never registered behind the user’s back', () => {
  it('writes the login item only from the Settings toggle or the visible setup choice', () => {
    const writes = MAIN_TS.match(/app\.setLoginItemSettings\(/g) || [];
    expect(writes.length).toBe(2);
    expect(sliceFrom("ipcMain.handle('app:setStartAtLogin'", 900)).toContain('app.setLoginItemSettings(');
    expect(sliceFrom("ipcMain.handle('app:completeOnboarding'", 1600)).toMatch(/options && typeof options\.startAtLogin === 'boolean'/);
  });
});

describe('Quick Search renderer starts clean and keeps nothing', () => {
  it('clears the query and results whenever the panel is hidden', () => {
    expect(QUICK_TS).toMatch(/onQuickSearchReset\?\.\(\(\) => \{[\s\S]*?qsInput\.value = '';[\s\S]*?renderIdle\(\);/);
  });

  it('shows a failure as a failure, never as an empty result list', () => {
    // The panel acts on the explicit outcome; a failed IPC call becomes a
    // search_error too, and search_error shows the failure message.
    expect(QUICK_TS).toMatch(/catch \{[\s\S]{0,120}?outcome = \{ state: 'search_error', results: \[\] \};/);
    expect(QUICK_TS).toMatch(/case 'search_error':[\s\S]{0,400}?showMessage\(ERROR_MESSAGES\.searchFailed/);
    // "no results" is only ever reached through no_matches / index_not_ready.
    expect(QUICK_TS).toMatch(/case 'no_matches':\s*case 'index_not_ready':\s*await explainEmptyResult/);
  });
});

describe('Showing the panel before its page has loaded', () => {
  it('waits on a load flag set from a listener attached before loading starts', () => {
    const create = MAIN_TS.slice(MAIN_TS.indexOf('function createQuickSearchWindow()'));
    const listenerAt = create.indexOf("win.webContents.on('did-finish-load'");
    const loadAt = create.indexOf("win.loadFile(path.join(__dirname, 'renderer/quick-search.html'))");
    expect(listenerAt).toBeGreaterThan(-1);
    expect(listenerAt).toBeLessThan(loadAt);
    expect(MAIN_TS.slice(MAIN_TS.indexOf('function showQuickSearch()'), MAIN_TS.indexOf('function showQuickSearch()') + 600))
      .toMatch(/if \(!quickSearchLoaded\) \{\s*quickSearchShowPending = true;/);
  });

  it('never defers on webContents.isLoading(), which is still true inside did-finish-load', () => {
    const show = MAIN_TS.slice(MAIN_TS.indexOf('function showQuickSearch()'), MAIN_TS.indexOf('function showQuickSearch()') + 1500);
    expect(show).not.toContain('isLoading()');
  });
});

describe('An idle panel costs nothing', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/quick-search.html'), 'utf-8');

  it('does not take focus while it loads hidden', () => {
    expect(html).not.toMatch(/id="qs-input"[^>]*autofocus/);
    expect(QUICK_TS).not.toMatch(/\nqsInput\.focus\(\);\s*$/);
  });

  it('gives up focus when hidden, so no caret keeps repainting in the background', () => {
    expect(QUICK_TS).toMatch(/onQuickSearchReset\?\.\(\(\) => \{[\s\S]*?qsInput\.blur\(\);\s*\}\);/);
  });

  it('takes focus only when the panel is shown', () => {
    expect(QUICK_TS).toMatch(/onQuickSearchShown\?\.\(\(info\) => \{[\s\S]*?qsInput\.focus\(\);/);
  });
});
