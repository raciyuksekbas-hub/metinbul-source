import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// Electron's app lifecycle cannot be exercised in-process under vitest (no
// app.whenReady, no globalShortcut, no login-item registry), and nothing in
// this suite boots Electron. The decision logic that CAN be tested directly
// lives in src/main/startup-settings.ts and is covered by
// startup_settings.test.ts; what remains here are deliberate source-level
// guards over the wiring in main.ts, where a regression would only ever show
// up as "MetinBul started scanning my disk at boot" or "closing the window
// killed the shortcut". The runtime behaviour is verified against the
// packaged .app during release smoke testing.
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
// Normalised to LF: a Windows checkout (core.autocrlf) has CRLF line endings,
// and some needles below span two lines written with \n.
const MAIN_TS = fs.readFileSync(path.join(SRC_DIR, 'main/main.ts'), 'utf-8').replace(/\r\n/g, '\n');

function sliceFrom(needle: string, length: number): string {
  const idx = MAIN_TS.indexOf(needle);
  expect(idx, `expected to find ${needle} in main.ts`).toBeGreaterThan(-1);
  return MAIN_TS.slice(idx, idx + length);
}

describe('Startup preference wiring', () => {
  it('loads the background preference from app_settings, defaulting to on', () => {
    // Default ON since the Quick Search redesign: on macOS the Settings
    // window is MetinBul's only real window, and closing it must not take the
    // shortcut down unless the user said so. An explicit "0" still wins
    // (parseBooleanSetting is covered in startup_settings.test.ts).
    expect(MAIN_TS).toMatch(
      /keepRunningInBackground\s*=\s*parseBooleanSetting\(\s*[\s\S]{0,120}?'keep_running_in_background'[\s\S]{0,40}?true/
    );
  });

  it('derives residency from the preference AND platform support', () => {
    const body = sliceFrom('function shouldStayResident()', 220);
    expect(body).toContain('keepRunningInBackground');
    expect(body).toContain('canStayResident()');
    expect(sliceFrom('function canStayResident()', 220)).toContain('isBackgroundResidencySupported(process.platform)');
  });

  it('ends the process when the window closes and residency is off', () => {
    // The hidden Quick Search window keeps window-all-closed from firing,
    // so mainWindow's own 'closed' handler is the real last-window hook.
    const body = sliceFrom("mainWindow.on('closed'", 700);
    expect(body).toMatch(/if\s*\(\s*!\s*shouldStayResident\s*\(\s*\)\s*\)/);
    expect(body).toContain('app.quit()');
  });

  it('reads the login item from the OS instead of mirroring it in the DB', () => {
    const body = sliceFrom('function getStartupSettingsPayload()', 900);
    expect(body).toContain('app.getLoginItemSettings(');
    expect(body).toContain('buildLoginItemQueryOptions(process.platform, process.execPath)');
    // A second stored copy would drift when the user changes the setting in
    // System Settings / the Windows Startup pane.
    expect(MAIN_TS).not.toContain("'start_at_login'");
  });

  it('verifies the login item against the OS after writing it', () => {
    const body = sliceFrom("handle('app:setStartAtLogin'", 1600);
    expect(body).toContain('app.setLoginItemSettings(');
    expect(body).toContain('getStartupSettingsPayload()');
    // setLoginItemSettings returns nothing and can fail quietly, so the
    // handler must re-read and report a mismatch rather than claim success.
    expect(body).toMatch(/if\s*\(\s*settings\.startAtLogin\s*!==\s*wanted\s*\)/);
    expect(body).toMatch(/success:\s*false/);
  });

  it('persists the background preference so it survives a restart', () => {
    const body = sliceFrom("handle('app:setKeepRunningInBackground'", 900);
    expect(body).toContain("appDb.setAppSetting(");
    expect(body).toContain("'keep_running_in_background'");
  });
});

describe('Login launch stays out of the way', () => {
  it('shows nothing on a macOS login launch, and never a main window on macOS', () => {
    const body = sliceFrom('if (usesUtilityShell) {\n    // macOS. A login launch shows nothing at all', 900);
    // Setup first if it was never finished; otherwise the search field only
    // for a deliberate launch -- a login launch brings up nothing at all.
    expect(body).toMatch(/if \(pendingOnboarding\) \{\s*openSettingsWindow\('onboarding'\);\s*\} else if \(!launchedAtLogin\) \{\s*showQuickSearch\(\);/);
    // The main window belongs to the other branch only.
    const elseIndex = body.indexOf('} else {');
    expect(elseIndex).toBeGreaterThan(-1);
    expect(body.slice(0, elseIndex)).not.toContain('createWindow(');
    expect(body.slice(elseIndex)).toContain('createWindow({ startMinimized: launchedAtLogin })');
    expect(MAIN_TS).toContain("const usesUtilityShell = process.platform === 'darwin';");
  });

  it('starts minimized where a window has to exist for a quit affordance', () => {
    const body = sliceFrom('if (options.startMinimized)', 200);
    expect(body).toContain('minimize()');
  });
});

// The product boundary this feature must not cross: staying resident is
// permission to be *ready*, never permission to scan.
describe('Background work is limited to the automatic index update', () => {
  it('runs no index pass at startup -- not at login, not on a normal launch, not deferred', () => {
    // P0: every start used to re-scan the whole document set (and re-extract
    // every previously failed file) before the user had asked for anything.
    expect(MAIN_TS).not.toContain('deferredStartupIndex');
    expect(MAIN_TS).not.toContain('maybeRunStartupIndex');
    const whenReady = MAIN_TS.slice(MAIN_TS.indexOf('app.whenReady()'));
    const handlersEnd = whenReady.indexOf('// The panel is built hidden on every launch');
    expect(handlersEnd).toBeGreaterThan(-1);
    // After the IPC handlers, the startup sequence itself never indexes: it
    // only arms the automatic update, which waits one full interval.
    expect(whenReady.slice(handlersEnd)).not.toMatch(/triggerIndexing\(/);
    expect(whenReady.slice(handlersEnd)).toContain('scheduleAutoIndex();');
  });

  it('indexes when the user asks, and otherwise only from the automatic update timer', () => {
    const userCall = /triggerIndexing\((\)|'user', \{ (restart|rebuild): true \}\))/;
    const callers = [...MAIN_TS.matchAll(/\bhandle\('([^']+)'[\s\S]*?\n  \}\);/g)]
      .filter(m => userCall.test(m[0]))
      .map(m => m[1])
      .sort();
    expect(callers).toEqual([
      'app:addSearchArea',
      'app:completeOnboarding',
      'app:rebuildIndex',
      'app:removeSearchArea',
      'app:rescan',
      'app:setSearchScopeMode'
    ]);
    // ...and nowhere else: those six handlers, plus the timer, whose passes
    // are marked automatic (quiet, and no retry of unchanged unreadable files).
    // Two other calls continue an update that had to stop: past a document
    // the watchdog stopped on, under the same trigger, or with settings that
    // changed under it (the user's request, carried over); neither starts
    // work nobody asked for.
    expect((MAIN_TS.match(/triggerIndexing\(\)/g) || []).length).toBe(2);
    expect((MAIN_TS.match(/triggerIndexing\('user', \{ restart: true \}\)/g) || []).length).toBe(3);
    expect((MAIN_TS.match(/triggerIndexing\('user', \{ rebuild: true \}\)/g) || []).length).toBe(1);
    expect(sliceFrom('if (pending && !isQuitting)', 300)).toContain('triggerIndexing(pending.trigger, { rebuild: pending.rebuild })');
    expect((MAIN_TS.match(/triggerIndexing\('auto'\)/g) || []).length).toBe(1);
    expect(sliceFrom('function runAutoIndex()', 400)).toContain("triggerIndexing('auto')");
    expect(sliceFrom('if (quarantined && !isQuitting)', 1300)).toContain('triggerIndexing(trigger, { retryFailed: false })');
    expect(sliceFrom('function triggerIndexing(', 1600)).toContain("retryFailed: options.retryFailed ?? trigger === 'user'");
  });

  it('does no network work at login: the silent update check waits for the user', () => {
    // At launch only where a main window comes up, and never at login...
    expect(MAIN_TS).toMatch(/if \(!usesUtilityShell && !launchedAtLogin\) \{\s*scheduleUpdateCheck\(3000\);/);
    // ...otherwise only once a surface is actually opened.
    const calls = MAIN_TS.match(/scheduleUpdateCheck\(/g) || [];
    expect(calls.length).toBe(3); // definition, launch guard, noteSurfaceOpened
    expect(sliceFrom('function noteSurfaceOpened()', 80)).toContain('scheduleUpdateCheck()');
    // One request per session at most.
    expect(sliceFrom('function scheduleUpdateCheck(', 200)).toContain('if (updateCheckScheduled) return;');
  });

  it('introduces no filesystem watcher; the only recurring work is the automatic update', () => {
    // No watchers, no daemon, no free-running interval. The one recurring job
    // (asserted below) is the automatic index update the user can turn off.
    const forbidden = [
      /\bfs\.watch\b/, /\bwatchFile\b/, /\bchokidar\b/,
      /\bsetInterval\s*\(/, /\bnode-cron\b/, /\bsetImmediate\s*\(\s*function\s+loop/
    ];
    const sources = [
      'main/main.ts', 'main/startup-settings.ts', 'main/indexer-worker.ts', 'scanner/scanner.ts',
      'renderer/quick-search.ts', 'renderer/settings.ts', 'renderer/settings/index-view.ts',
      'shared/quick-search-model.ts', 'db/database.ts'
    ]
      .map(rel => ({ rel, text: fs.readFileSync(path.join(SRC_DIR, rel), 'utf-8') }))
      // The one interval allowed: the indexing watchdog's memory watch, armed
      // when a document starts being read and cleared when it is done (or
      // the update ends) -- never running while MetinBul is idle.
      .map(({ rel, text }) => ({ rel, text: rel === 'main/main.ts' ? text.replace('memoryWatch = setInterval(', 'memoryWatch = WATCH(') : text }));
    const watchdog = sliceFrom('const disarm = () => {', 200);
    expect(watchdog).toContain('if (memoryWatch) clearInterval(memoryWatch);');
    expect(MAIN_TS).toMatch(/if \(msg\.type === 'reading'\) \{[\s\S]{0,800}memoryWatch = setInterval\(/);
    for (const { rel, text } of sources) {
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${rel} must not contain ${pattern}`).toBe(false);
      }
    }
    // Re-armed only when an update ends, a full interval later; never armed
    // when the user turned it off; cleared on quit.
    const schedule = sliceFrom('function scheduleAutoIndex()', 400);
    expect(schedule).toContain('if (!autoIndexEnabled || isQuitting) return;');
    expect(schedule).toContain('setTimeout(runAutoIndex, AUTO_INDEX_INTERVAL_MS)');
    expect((MAIN_TS.match(/setTimeout\(runAutoIndex/g) || []).length).toBe(1);
    expect(sliceFrom("worker.on('exit'", 2500)).toContain('scheduleAutoIndex();');
    expect(sliceFrom("app.on('before-quit'", 400)).toContain('clearTimeout(autoIndexTimer)');
    expect(MAIN_TS).toContain("parseBooleanSetting(appDb.getAppSetting('auto_index_enabled'), true)");
  });
});

describe('Global shortcut failure is diagnosable, never silent', () => {
  it('records a user-facing reason and logs the accelerator on failure', () => {
    const body = sliceFrom('function registerQuickSearchShortcut(', 1200);
    expect(body).toContain('quickSearchShortcutError =');
    expect(body).toContain('console.error(');
    expect(body).toMatch(/registration FAILED/i);
  });

  it('reports the failure back to the renderer with the shortcut state', () => {
    const body = sliceFrom("handle('app:getQuickSearchShortcut'", 700);
    expect(body).toContain('registered');
    expect(body).toContain('quickSearchShortcutError');
  });

  it('clears the recorded error once a shortcut registers successfully', () => {
    const body = sliceFrom('function registerQuickSearchShortcut(', 1200);
    expect(body).toContain('quickSearchShortcutError = null;');
  });
});
