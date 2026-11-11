// On Windows, closing the window used to quit MetinBul, so the global shortcut,
// the ten-minute updates and text recognition all stopped (user reports,
// 2026-11-08). A windowless app needs a way back and a way out: on Windows, the
// notification area icon. scripts/windows/tray-smoke.mjs runs the packaged app
// on a Windows machine in CI; this guards the wiring on every platform.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN_TS = read('src/main/main.ts');

function functionBody(name: string): string {
  const start = MAIN_TS.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return MAIN_TS.slice(start, MAIN_TS.indexOf('\n}\n', start));
}

describe('the Windows notification area icon', () => {
  it('exists on Windows only, before any window can be closed', () => {
    expect(functionBody('createTray')).toContain("if (process.platform !== 'win32') return;");
    const whenReady = MAIN_TS.slice(MAIN_TS.indexOf('app.whenReady()'));
    expect(whenReady.indexOf('createTray();')).toBeGreaterThan(-1);
    expect(whenReady.indexOf('createTray();')).toBeLessThan(whenReady.indexOf('createWindow({ startMinimized'));
  });

  it('brings the window back and is a real way out', () => {
    const body = functionBody('createTray');
    expect(body).toContain("tray.on('click', () => restoreMainWindow());");
    expect(body).toContain("{ label: 'MetinBul’u Aç', click: () => restoreMainWindow() }");
    expect(body).toContain("{ label: 'MetinBul’dan Çık', click: () => app.quit() }");
  });

  it('lets closing the window quit when the icon could not be created', () => {
    expect(functionBody('createTray')).toMatch(/try \{\s*tray = new Tray\([\s\S]*?\} catch \(err\) \{[\s\S]*?return;\s*\}/);
    expect(functionBody('canStayResident')).toContain("process.platform !== 'win32' || tray !== null");
    expect(functionBody('shouldStayResident')).toContain('keepRunningInBackground && canStayResident()');
  });

  it('only offers the setting where MetinBul can really stay resident', () => {
    expect(functionBody('getStartupSettingsPayload')).toContain('backgroundSupported: canStayResident()');
    const handler = MAIN_TS.slice(MAIN_TS.indexOf("ipcMain.handle('app:setKeepRunningInBackground'"));
    expect(handler.slice(0, 200)).toContain('if (!canStayResident())');
  });

  it('says once where MetinBul went, and not while quitting', () => {
    const closed = MAIN_TS.slice(MAIN_TS.indexOf("mainWindow.on('closed'"));
    expect(closed.slice(0, 700)).toMatch(/\} else if \(!isQuitting\) \{\s*showTrayHintOnce\(\);/);
    const body = functionBody('showTrayHintOnce');
    expect(body).toContain("appDb.getAppSetting('tray_hint_shown')");
    expect(body).toContain("appDb.setAppSetting('tray_hint_shown'");
    expect(body.indexOf('setAppSetting')).toBeLessThan(body.indexOf('displayBalloon'));
  });

  it('opens no window at login only when the icon can bring one back', () => {
    expect(MAIN_TS).toMatch(
      /if \(!launchedAtLogin \|\| !shouldStayResident\(\) \|\| pendingOnboarding\) \{\s*createWindow\(\{ startMinimized: launchedAtLogin \}\);/
    );
  });

  it('checks for updates when the window is first opened from the icon', () => {
    expect(functionBody('restoreMainWindow')).toContain('noteSurfaceOpened();');
  });

  it('removes the icon when MetinBul quits', () => {
    const beforeQuit = MAIN_TS.slice(MAIN_TS.indexOf("app.on('before-quit'"));
    expect(beforeQuit.slice(0, 200)).toContain('tray?.destroy();');
  });

  it('ships the icon file it needs', () => {
    expect(read('scripts/build.mjs')).toMatch(/\['icon-1024\.png', 'icon\.icns', 'icon\.ico'\]/);
    expect(fs.existsSync(path.join(__dirname, '..', 'assets', 'icon.ico'))).toBe(true);
  });

  it('describes background running as it is: updates go on, and how to quit', () => {
    const view = read('src/renderer/settings/general-view.ts');
    expect(view).not.toContain('indeksleme yapmaz');
    expect(view).toContain('belgelerinizi de');
    expect(view).toContain('bildirim alanındaki MetinBul simgesine sağ tıklayın');
  });
});
