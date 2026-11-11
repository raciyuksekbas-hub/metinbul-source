import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, nativeImage, nativeTheme, shell, clipboard, dialog, globalShortcut, screen, Tray } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { AppDatabase, OcrCounts, ScopeStatusCounts } from '../db/database.js';
import { isMacosOcrAvailable, OCR_BUDGET_MS } from '../ocr/ocr.js';
import { checkWindowsOcr, installWindowsTurkishOcr } from '../ocr/windows-ocr.js';
import { IndexProgress } from '../search/indexer.js';
import { IndexCounts, SearchService } from './search-service.js';
import { getAboutMetadata, getFeedbackMailto, getPackageVersion } from './about-info.js';
import { checkForUpdates, UpdateCheckResult } from './updater.js';
import { AppTheme, DEFAULT_THEME, getPanelBackgroundColor, getThemeBackgroundColor, isValidTheme } from '../shared/theme.js';
import { formatAcceleratorForDisplay, getDefaultAccelerator, isValidAccelerator, conflictsWithScreenReader, SCREEN_READER_CONFLICT_MESSAGE } from './quick-search-shortcut.js';
import {
  buildLoginItemConfig,
  buildLoginItemQueryOptions,
  isBackgroundResidencySupported,
  isStartAtLoginSupported,
  parseBooleanSetting,
  serializeBooleanSetting,
  shouldRunAutoIndex,
  wasLaunchedAtLogin,
  AUTO_INDEX_INTERVAL_MS
} from './startup-settings.js';
import { nextPanelHeight } from '../shared/quick-search-model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconPath = path.join(__dirname, 'assets/icon.icns');

app.name = 'MetinBul';

let mainWindow: BrowserWindow | null = null;
// Windows' notification area icon; see createTray.
let tray: Tray | null = null;
let quickSearchWindow: BrowserWindow | null = null;
let registeredQuickSearchAccelerator: string | null = null;
let db: AppDatabase | null = null;
let isIndexing = false;
let currentIndexingWorker: Worker | null = null;
let currentTheme: AppTheme = DEFAULT_THEME;
let pendingOnboarding = false;
let isQuitting = false;
// Opt-in, default off (see 'keep_running_in_background' in app_settings):
// with it off, closing the window ends the process exactly as it did before
// this setting existed.
let keepRunningInBackground = false;
// True only when the OS started MetinBul at sign-in rather than the user.
// Used only to decide whether to put a window on screen.
let launchedAtLogin = false;
// "Belgeleri otomatik güncelle" ('auto_index_enabled', default on): a single
// timer, re-armed whenever an update ends, that runs the same incremental
// pass as "Belgeleri Güncelle". There is no filesystem watcher.
let autoIndexEnabled = true;
let autoIndexTimer: ReturnType<typeof setTimeout> | null = null;
let autoIndexDueAt: number | null = null;
// "Taranmış PDF'lerde metin tanıma" ('ocr_enabled', default on). Uses the
// system's own recognition: on macOS through the helper in the app's
// Resources/bin, on Windows through Windows PowerShell. The system has to
// offer Turkish, which is checked once at launch; a Windows without its
// Turkish component can add it from Settings.
let ocrEnabled = true;
let ocrHelperPath: string | null = null;
let ocrAvailable = false;
let ocrNeedsTurkishComponent = false;
// Scope counts behind "N belge arandı · M belge işlenemedi". Cached: on the
// real 718 MB index the first read takes ~300 ms (cold pages), every later one
// ~4 ms. Dropped whenever the index or the scope changes.
let indexStatusCounts: ScopeStatusCounts | null = null;
let ocrCounts: OcrCounts | null = null;
let indexCountsGeneration = 0;
let searchService: SearchService | null = null;
// Kept for Settings › İndeks so a failed search is diagnosable without
// putting a SQLite message in the search panel. Never includes the query.
let lastSearchError: { at: number; message: string } | null = null;
let quickSearchShortcutError: string | null = null;

// macOS runs MetinBul as a resident search utility: no main window, just the
// Quick Search panel (summoned by the global shortcut) and a Settings window
// opened on demand. Windows/Linux keep the main window as their surface; on
// Windows the notification area icon (createTray) brings it back after it was
// closed.
const usesUtilityShell = process.platform === 'darwin';

let settingsWindow: BrowserWindow | null = null;
// Tracked from did-become-active/did-resign-active (macOS). The panel does not
// activate MetinBul, so most of the time this stays false while it is open.
let appIsActive = false;
// The MetinBul window that had focus when the panel was summoned, so that
// dismissing the panel hands focus back to it instead of to nothing.
let quickSearchReturnTarget: BrowserWindow | null = null;
// Set while a result's context menu is open: the menu takes key status for a
// moment, and that blur must not dismiss the panel underneath it.
let quickSearchMenuOpen = false;
// Whether the panel's page has finished loading, and whether a show was
// requested before it had (a shortcut pressed in the first instant after
// launch, or the launch itself).
let quickSearchLoaded = false;
let quickSearchShowPending = false;
let lastIndexProgress: IndexProgress | null = null;
let latestUpdateInfo: UpdateCheckResult | null = null;
let updateCheckScheduled = false;

const QUICK_SEARCH_WIDTH = 640;
// Must match the height of .qs-field in style.css: the panel's resting size
// is the search field and nothing else.
const QUICK_SEARCH_COMPACT_HEIGHT = 58;
const QUICK_SEARCH_MAX_HEIGHT = 520;
let quickSearchMaxHeight = QUICK_SEARCH_MAX_HEIGHT;

type SettingsSection = 'general' | 'locations' | 'index' | 'about' | 'onboarding';
const SETTINGS_SECTIONS: readonly SettingsSection[] = ['general', 'locations', 'index', 'about', 'onboarding'];

function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

// MetinBul can stay resident after its window is closed (opt-in, see
// shouldStayResident) and can be started at login, so a second launch is not
// harmless: two processes would open the same SQLite profile and fight over
// the single OS-level Option+Space registration, where whichever registered
// last wins and the other's window silently never appears. The first
// instance owns both; any later launch hands its intent over and exits
// immediately -- which is also what makes "login launch, then the user opens
// MetinBul from the Dock" reuse the resident process instead of starting a
// second one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Relaunching an already-running MetinBul (Dock, Spotlight, `open -a`)
    // is a deliberate request for the real UI -- not just the background
    // shortcut -- so something must appear rather than nothing.
    handleReopen(false);
  });
}

if (process.platform === 'darwin') {
  app.on('did-become-active', () => {
    appIsActive = true;
  });
  app.on('did-resign-active', () => {
    appIsActive = false;
  });
}

// Whether a windowless MetinBul has a visible way back and a way to quit:
// macOS keeps its Dock icon and menu bar, Windows has the notification area
// icon -- if it could be created.
function canStayResident(): boolean {
  return isBackgroundResidencySupported(process.platform) && (process.platform !== 'win32' || tray !== null);
}

// Whether closing the last window should leave MetinBul running. Both
// halves matter: the user's opt-in AND a platform where that is safe.
function shouldStayResident(): boolean {
  return keepRunningInBackground && canStayResident();
}

// Reads the live OS login-item state rather than a mirrored copy in
// app_settings: the user can also flip this in macOS System Settings >
// Login Items or the Windows Startup pane, and a second stored copy would
// silently drift out of sync with what actually happens at boot. macOS also
// reports 'requires-approval' here, which means registered-but-not-yet-
// allowed -- worth showing, since nothing would start at login in that state.
function getStartupSettingsPayload() {
  const startAtLoginSupported = isStartAtLoginSupported(process.platform);
  let startAtLogin = false;
  let startAtLoginStatus: string | undefined;

  if (startAtLoginSupported) {
    try {
      const state = app.getLoginItemSettings(
        buildLoginItemQueryOptions(process.platform, process.execPath)
      );
      startAtLogin = state.openAtLogin === true;
      if (process.platform === 'darwin') {
        startAtLoginStatus = state.status;
      }
    } catch (err) {
      console.error('[MetinBul] Failed to read login item settings:', err);
    }
  }

  return {
    startAtLogin,
    startAtLoginSupported,
    startAtLoginStatus,
    keepRunningInBackground,
    backgroundSupported: canStayResident()
  };
}

// Everything Settings › İndeks and the panel's no-results state need to say
// "found nothing" apart from "could not read". Read-only: counts come from the
// documents table, the two timestamps/counters from app_settings.
async function getIndexStatusPayload() {
  const appDb = getDb();
  const mode = appDb.getSearchScopeMode();
  const included = appDb.getIncludedFolders();
  const readInt = (key: string) => {
    const parsed = Number.parseInt(appDb.getAppSetting(key) ?? '0', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  // Taken before the wait, so that "no longer updating" never comes with
  // counts read before the update ended.
  const state = {
    dataless: readInt('last_skipped_dataless_count'),
    lastIndexedAt: readInt('last_index_completed_at'),
    isIndexing,
    progress: isIndexing ? lastIndexProgress : null,
    scopeMode: mode,
    hasIncludedFolders: included.length > 0,
    onboardingPending: pendingOnboarding,
    lastSearchError,
    autoIndexEnabled,
    autoIndexIntervalMinutes: AUTO_INDEX_INTERVAL_MS / 60_000,
    nextAutoIndexAt: autoIndexDueAt,
    ocrAvailable,
    ocrEnabled,
    ocrNeedsTurkishComponent,
    ocrSystemName: process.platform === 'win32' ? 'Windows' : 'macOS',
    ocrBudgetMinutes: OCR_BUDGET_MS / 60_000
  };
  const counts = await readIndexCounts();
  return {
    ...state,
    indexed: counts.status.indexed,
    failed: counts.status.failed,
    noText: counts.status.noText,
    ocrRecognized: counts.ocr?.recognized ?? 0,
    ocrPending: counts.ocr?.pending ?? 0
  };
}

// Kept until something changes them. A read overtaken by a change is still
// answered, but not kept.
async function readIndexCounts(): Promise<IndexCounts> {
  if (indexStatusCounts && (ocrCounts || !ocrAvailable)) {
    return { status: indexStatusCounts, ocr: ocrCounts };
  }
  const generation = indexCountsGeneration;
  const counts = await getSearchService().statusCounts(ocrAvailable);
  if (generation === indexCountsGeneration) {
    indexStatusCounts = counts.status;
    ocrCounts = counts.ocr;
  }
  return counts;
}

function invalidateIndexCounts() {
  indexCountsGeneration++;
  indexStatusCounts = null;
  ocrCounts = null;
}

// The text recognition helper: Resources/bin in the packaged app, dist/native
// next to main.js in a development build (see scripts/build.mjs).
function locateOcrHelper(): string | null {
  if (process.platform !== 'darwin') return null;
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'metinbul-ocr')
    : path.join(__dirname, 'native', 'metinbul-ocr');
  return fs.existsSync(helper) ? helper : null;
}

function ocrWorkerOptions(): { helperPath?: string; budgetMs: number } | undefined {
  if (!ocrAvailable || !ocrEnabled) return undefined;
  return { helperPath: ocrHelperPath ?? undefined, budgetMs: OCR_BUDGET_MS };
}

async function refreshOcrAvailability() {
  if (process.platform === 'win32') {
    const status = await checkWindowsOcr();
    ocrAvailable = status === 'ready';
    ocrNeedsTurkishComponent = status === 'no-turkish';
  } else if (ocrHelperPath) {
    ocrAvailable = await isMacosOcrAvailable(ocrHelperPath);
  }
  invalidateIndexCounts();
}

// Shared by the Dock-click ('activate') and relaunch ('second-instance')
// paths: the main window may be closed outright, merely hidden (Quick
// Search hides it on macOS), or minimized, and all three must come back.
function restoreMainWindow() {
  // Where a login launch opened no window, this is the first surface.
  noteSurfaceOpened();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  // Renderer moves focus to the search field and announces it (spec §16).
  mainWindow.webContents.send('app:windowRestored');
}

function getDbPath(): string {
  return path.join(app.getPath('userData'), 'metinbul.db');
}

function getDb(): AppDatabase {
  if (!db) {
    db = new AppDatabase(getDbPath());
  }
  return db;
}

function getSearchService(): SearchService {
  if (!searchService) {
    searchService = new SearchService(cancelledSearch => new Worker(path.join(__dirname, 'search-worker.js'), {
      workerData: { dbPath: getDbPath(), cancelledSearch }
    }));
  }
  return searchService;
}

// Decides once, at startup, whether the first-run scope-selection screen
// should appear. An upgrading v0.2.0 user already has search_areas rows
// and/or indexed documents even though the new 'onboarding_completed' flag
// has never been set for them -- that combination silently marks onboarding
// done without ever showing the dialog, so existing users see no change.
function resolveShouldShowOnboarding(appDb: AppDatabase): boolean {
  if (appDb.isOnboardingCompleted()) {
    return false;
  }
  const hasExistingUsage = appDb.getAllDocumentPaths().length > 0 || appDb.getSearchAreas().length > 0;
  if (hasExistingUsage) {
    appDb.setOnboardingCompleted();
    return false;
  }
  return true;
}

function allWindows(): BrowserWindow[] {
  return [mainWindow, quickSearchWindow, settingsWindow]
    .filter((win): win is BrowserWindow => !!win && !win.isDestroyed());
}

// State that every surface shows (theme, index progress, update availability)
// is pushed to all of them: the panel and the Settings window can both be
// open while it changes, and the Windows main window as well.
function broadcast(channel: string, ...args: unknown[]) {
  for (const win of allWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function setAppTheme(theme: AppTheme) {
  if (!isValidTheme(theme)) return;
  currentTheme = theme;
  nativeTheme.themeSource = theme;
  // Persisted in the main process now that the main window -- which used to
  // keep the choice in its own localStorage -- no longer exists on macOS.
  // Without this a login launch would always come up in the default theme.
  getDb().setAppSetting('theme', theme);
  for (const win of allWindows()) {
    win.setBackgroundColor(win === quickSearchWindow ? getPanelBackgroundColor(theme) : getThemeBackgroundColor(theme));
    win.webContents.send('app:themeChanged', theme);
  }
  setupAppMenu();
}

// Dock click, relaunch from Finder/Spotlight, `open -a MetinBul`: the user
// asked for MetinBul, so something must appear. On macOS that is the search
// panel -- or setup, if it was never finished, or the Settings window if it
// is merely hidden; elsewhere it is the main window, as before.
function handleReopen(hasVisibleWindows: boolean) {
  if (!usesUtilityShell) {
    restoreMainWindow();
    return;
  }
  if (pendingOnboarding) {
    openSettingsWindow('onboarding');
    return;
  }
  if (quickSearchWindow && !quickSearchWindow.isDestroyed() && quickSearchWindow.isVisible()) {
    return;
  }
  if (settingsWindow && !settingsWindow.isDestroyed() && !hasVisibleWindows) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  if (!hasVisibleWindows) {
    showQuickSearch();
  }
}

// The Settings window is created on demand and destroyed on close: it is
// visited rarely, so it costs nothing while MetinBul sits idle.
function openSettingsWindow(section: SettingsSection = 'general', options: { checkUpdates?: boolean } = {}) {
  const target: SettingsSection = pendingOnboarding ? 'onboarding' : section;

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:navigate', { section: target, checkUpdates: options.checkUpdates === true });
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 680,
    height: 600,
    minWidth: 560,
    minHeight: 460,
    title: 'MetinBul Ayarları',
    icon: iconPath,
    show: false,
    fullscreenable: false,
    backgroundColor: getThemeBackgroundColor(currentTheme),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });
  settingsWindow = win;

  const query: Record<string, string> = { section: target };
  if (options.checkUpdates) query.checkUpdates = '1';
  win.loadFile(path.join(__dirname, 'renderer/settings.html'), { query });
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
    // On macOS the Settings window is the only real window MetinBul has, so
    // closing it is what "Pencere kapandığında arka planda açık tut" is about.
    // Hiding the search panel never quits; it is not a window being closed.
    if (usesUtilityShell && !isQuitting && !shouldStayResident()) {
      app.quit();
    }
  });

  noteSurfaceOpened();
}

// One silent update check per session. It used to run three seconds after
// launch, but a login launch now brings up nothing at all, so on macOS it
// waits for the first time the user actually opens MetinBul.
function scheduleUpdateCheck(delayMs = 3000) {
  if (updateCheckScheduled) return;
  updateCheckScheduled = true;
  setTimeout(async () => {
    try {
      const result: UpdateCheckResult = await checkForUpdates(getPackageVersion());
      if (result.updateAvailable) {
        latestUpdateInfo = result;
        broadcast('app:updateAvailable', result);
      }
    } catch {
      // Silent: the manual check in Ayarlar › Hakkında reports failures.
    }
  }, delayMs);
}

function noteSurfaceOpened() {
  scheduleUpdateCheck();
}

function setupAppMenu() {
  const isMac = process.platform === 'darwin';
  // Shown next to "Hızlı Arama" so the shortcut can be discovered from the
  // menu bar. On Windows/Linux the item must not also register it as a
  // window-local accelerator; on macOS the global hotkey wins before the menu
  // ever sees the key, so the entry is display-only in practice there too.
  const quickSearchAccelerator = registeredQuickSearchAccelerator ?? undefined;

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        {
          label: 'MetinBul Hakkında',
          click: () => openSettingsWindow('about')
        },
        {
          label: 'Güncellemeleri Denetle…',
          click: () => openSettingsWindow('about', { checkUpdates: true })
        },
        { type: 'separator' as const },
        {
          label: 'Ayarlar…',
          accelerator: 'Cmd+,',
          click: () => openSettingsWindow('general')
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const, label: 'MetinBul’u Gizle' },
        { role: 'hideOthers' as const, label: 'Diğerlerini Gizle' },
        { role: 'unhide' as const, label: 'Tümünü Göster' },
        { type: 'separator' as const },
        { role: 'quit' as const, label: 'MetinBul’dan Çık' }
      ]
    }] : []),
    {
      label: 'Dosya',
      submenu: [
        {
          label: 'Hızlı Arama',
          accelerator: quickSearchAccelerator,
          registerAccelerator: false,
          click: () => toggleQuickSearch()
        },
        { type: 'separator' as const },
        {
          label: 'Arama Alanları…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => openSettingsWindow('locations')
        },
        ...(isMac ? [] : [{
          label: 'Ayarlar…',
          accelerator: 'Ctrl+,',
          click: () => openSettingsWindow('general')
        }]),
        { type: 'separator' as const },
        isMac ? { role: 'close' as const, label: 'Pencereyi Kapat' } : { role: 'quit' as const, label: 'Çıkış' }
      ]
    },
    {
      label: 'Düzen',
      submenu: [
        { role: 'undo' as const, label: 'Geri Al' },
        { role: 'redo' as const, label: 'Yinele' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: 'Kes' },
        { role: 'copy' as const, label: 'Kopyala' },
        { role: 'paste' as const, label: 'Yapıştır' },
        { role: 'selectAll' as const, label: 'Tümünü Seç' }
      ]
    },
    {
      label: 'Görünüm',
      submenu: [
        {
          label: 'Tema',
          submenu: [
            {
              label: 'Koyu',
              type: 'radio' as const,
              checked: currentTheme === 'dark',
              click: () => setAppTheme('dark')
            },
            {
              label: 'Açık',
              type: 'radio' as const,
              checked: currentTheme === 'light',
              click: () => setAppTheme('light')
            }
          ]
        },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: 'Gerçek Boyut' },
        { role: 'zoomIn' as const, label: 'Büyüt' },
        { role: 'zoomOut' as const, label: 'Küçült' }
      ]
    },
    {
      label: 'Pencere',
      submenu: [
        { role: 'minimize' as const, label: 'Simge Durumuna Küçült' },
        { role: 'zoom' as const, label: 'Büyüt' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const, label: 'Tümünü Öne Getir' }
        ] : [])
      ]
    },
    {
      label: 'Yardım',
      submenu: [
        {
          label: 'Güncellemeleri Denetle…',
          click: () => openSettingsWindow('about', { checkUpdates: true })
        },
        { type: 'separator' as const },
        {
          label: 'MetinBul Hakkında',
          click: () => openSettingsWindow('about')
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow(options: { startMinimized?: boolean } = {}) {
  nativeTheme.themeSource = currentTheme;
  const initialBg = getThemeBackgroundColor(currentTheme);

  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: 'MetinBul',
    icon: iconPath,
    backgroundColor: initialBg,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  // Login launch with no notification area icon to come back through: the
  // window has to exist, so it is created minimized -- present in the
  // taskbar, not in the user's way.
  if (options.startMinimized) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.minimize();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // The Quick Search window hides rather than closes (see
    // createQuickSearchWindow), so window-all-closed does not fire while it
    // exists -- this is the real "last window closed" hook. Unless the user
    // has opted into background residency, closing the window ends the
    // process, exactly as it did before that setting existed.
    if (!shouldStayResident()) {
      app.quit();
    } else if (!isQuitting) {
      showTrayHintOnce();
    }
  });
}

// The notification area icon: on Windows the way back to a MetinBul whose
// window was closed, and the way to quit it for good. If it cannot be created,
// MetinBul does not stay resident there (canStayResident), so closing the
// window still quits.
function createTray() {
  if (process.platform !== 'win32') return;
  try {
    tray = new Tray(path.join(__dirname, 'assets/icon.ico'));
  } catch (err) {
    console.error('[MetinBul] Failed to create the notification area icon:', err);
    return;
  }
  tray.setToolTip('MetinBul');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'MetinBul’u Aç', click: () => restoreMainWindow() },
    { type: 'separator' },
    { label: 'MetinBul’dan Çık', click: () => app.quit() }
  ]));
  tray.on('click', () => restoreMainWindow());
}

// Closing the window used to quit MetinBul on Windows, so the first time it
// does not, say where it went and how to really quit.
function showTrayHintOnce() {
  if (!tray) return;
  const appDb = getDb();
  if (parseBooleanSetting(appDb.getAppSetting('tray_hint_shown'))) return;
  appDb.setAppSetting('tray_hint_shown', serializeBooleanSetting(true));
  tray.displayBalloon({
    iconType: 'info',
    noSound: true,
    title: 'MetinBul çalışmaya devam ediyor',
    content: 'Arama kısayolu ve belge güncellemeleri arka planda sürüyor. Tamamen kapatmak için '
      + 'bildirim alanındaki MetinBul simgesine sağ tıklayıp “MetinBul’dan Çık”ı seçin.'
  });
}

// Created once at startup, hidden, and toggled by the global shortcut --
// never rebuilt per use, so the panel is on screen the moment the shortcut is
// pressed rather than after a page load.
//
// On macOS it is an NSPanel (`type: 'panel'`). Measured directly on macOS 27
// with Electron 43.4.1: the panel becomes the key window and receives typing
// while the app the user was working in stays frontmost -- MetinBul is never
// activated, so dismissing the panel needs no focus juggling and the user is
// simply back where they were, as with Spotlight. A panel also floats over
// full-screen apps and joins the current Space instead of dragging the user
// to another one. (An older note here said panels could not do this; that
// was measured on an earlier macOS and no longer holds.)
function createQuickSearchWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: QUICK_SEARCH_WIDTH,
    height: QUICK_SEARCH_COMPACT_HEIGHT,
    useContentSize: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: !isMac,
    ...(isMac ? { type: 'panel', hiddenInMissionControl: true } : {}),
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'MetinBul Hızlı Arama',
    backgroundColor: getPanelBackgroundColor(currentTheme),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Measured on macOS 27: a panel's page can report itself hidden
      // (document.visibilityState) while it is on screen and focused, and
      // Chromium then throttles its timers -- the typing debounce stalls for
      // up to a second. With throttling off the page is always "visible".
      // This costs nothing while idle: the panel runs no timers, intervals
      // or animations when it is not being used.
      backgroundThrottling: false
    }
  });
  quickSearchWindow = win;

  if (isMac) {
    // skipTransformProcessType: the default briefly turns MetinBul into a UI
    // element process to apply this, which makes the Dock icon flicker.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // Attached before loading starts, so it cannot miss the event. (Checking
  // webContents.isLoading() instead does not work: it is still true inside
  // 'did-finish-load', which made a deferred show defer itself forever.)
  quickSearchLoaded = false;
  win.webContents.on('did-finish-load', () => {
    if (quickSearchWindow !== win) return;
    quickSearchLoaded = true;
    if (quickSearchShowPending) {
      quickSearchShowPending = false;
      showQuickSearch();
    }
  });

  win.loadFile(path.join(__dirname, 'renderer/quick-search.html'));
  win.setMenuBarVisibility(false);

  win.on('close', (e) => {
    // Cmd+W ("Pencereyi Kapat") and the Windows title-bar button dismiss the
    // panel; only quitting the app destroys it (see before-quit).
    if (!isQuitting) {
      e.preventDefault();
      hideQuickSearch('dismiss');
    }
  });

  // A panel that stays on top after the user has clicked into another app is
  // a stuck overlay, not a search field: losing key status dismisses it, as
  // Spotlight does. macOS only -- the framed Windows window keeps its old
  // semantics.
  if (isMac) {
    win.on('blur', () => {
      if (!quickSearchMenuOpen) hideQuickSearch('blur');
    });
  }

  // A crashed renderer must not leave the shortcut pointing at a dead window:
  // drop it, and the next invocation builds a fresh one.
  win.webContents.on('render-process-gone', () => {
    if (quickSearchWindow === win) quickSearchWindow = null;
    if (!win.isDestroyed()) win.destroy();
  });
  win.on('closed', () => {
    if (quickSearchWindow === win) quickSearchWindow = null;
  });

  return win;
}

function ensureQuickSearchWindow(): BrowserWindow {
  if (quickSearchWindow && !quickSearchWindow.isDestroyed()) return quickSearchWindow;
  return createQuickSearchWindow();
}

// The panel opens on the display under the pointer -- the closest thing to
// "the screen the user is working on" that can be known about another app's
// window -- horizontally centred, a fifth of the way down, like Spotlight. The
// maximum height is fixed per display so a long result list scrolls inside
// the panel instead of pushing the window off screen.
function placeQuickSearchWindow(win: BrowserWindow) {
  const isMac = process.platform === 'darwin';
  const display = isMac
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : screen.getDisplayMatching(win.getBounds());
  const area = display.workArea;

  if (!isMac) {
    // Windows keeps its own placement; only the height budget is derived.
    const current = win.getContentBounds();
    quickSearchMaxHeight = Math.max(
      QUICK_SEARCH_COMPACT_HEIGHT,
      Math.min(QUICK_SEARCH_MAX_HEIGHT, area.y + area.height - current.y - 16)
    );
    win.setContentBounds({ ...current, height: QUICK_SEARCH_COMPACT_HEIGHT });
    return;
  }

  const x = Math.round(area.x + (area.width - QUICK_SEARCH_WIDTH) / 2);
  const y = Math.round(area.y + area.height * 0.2);
  quickSearchMaxHeight = Math.max(
    QUICK_SEARCH_COMPACT_HEIGHT,
    Math.min(QUICK_SEARCH_MAX_HEIGHT, area.y + area.height - y - 24)
  );
  win.setContentBounds({ x, y, width: QUICK_SEARCH_WIDTH, height: QUICK_SEARCH_COMPACT_HEIGHT });
}

function showQuickSearch() {
  const win = ensureQuickSearchWindow();

  // A shortcut pressed in the first instant after launch (or the launch
  // itself) can arrive before the page has loaded; showing an empty frame
  // would only flash, so the show waits for the load.
  if (!quickSearchLoaded) {
    quickSearchShowPending = true;
    return;
  }

  if (win.isVisible()) {
    win.focus();
    win.webContents.focus();
    return;
  }

  const focused = BrowserWindow.getFocusedWindow();
  quickSearchReturnTarget = focused && focused !== win ? focused : null;

  placeQuickSearchWindow(win);
  win.show();
  win.focus();
  win.webContents.focus();
  // Measured: the very first time a panel is ordered front it does not
  // always become key. One retry a moment later settles it, so typing
  // after ⌥ Space never goes nowhere.
  setTimeout(() => {
    if (!win.isDestroyed() && win.isVisible() && !win.isFocused()) {
      win.focus();
      win.webContents.focus();
    }
  }, 60);
  // The list scrolls inside this budget; sent in CSS pixels so the renderer
  // can apply it directly whatever the panel's zoom.
  win.webContents.send('quick-search:shown', {
    maxHeight: Math.floor(quickSearchMaxHeight / win.webContents.getZoomFactor())
  });
  noteSurfaceOpened();
  // Read the scope counts while the user is still typing, so the first "no
  // results" explanation does not wait on the cold ~300 ms read.
  if (!indexStatusCounts) {
    readIndexCounts().catch(err => console.error('[MetinBul] Could not read index counts:', err));
  }
}

type QuickSearchHideReason = 'dismiss' | 'toggle' | 'blur' | 'open';

function hideQuickSearch(reason: QuickSearchHideReason) {
  const win = quickSearchWindow;
  if (!win || win.isDestroyed() || !win.isVisible()) return;

  win.hide();
  // Cleared while hidden, so the next invocation never flashes the previous
  // query before resetting.
  win.webContents.send('quick-search:reset');

  if (reason === 'dismiss' || reason === 'toggle') {
    returnFocusAfterQuickSearch();
  } else {
    // 'blur': the user already went somewhere else. 'open': the document's
    // app is taking focus. Either way, nothing to hand back.
    quickSearchReturnTarget = null;
  }
}

function hasVisibleWindowOtherThanQuickSearch(): boolean {
  return allWindows().some(win => win !== quickSearchWindow && win.isVisible() && !win.isMinimized());
}

// Where keyboard focus goes when the panel is dismissed. Usually nowhere: the
// panel never activated MetinBul, so the app the user came from still has
// focus. Two cases need help -- the user came from a MetinBul window (focus
// goes back to it), or MetinBul is active with nothing else on screen (e.g.
// the panel was opened from the menu bar); hiding the app then hands focus to
// whatever was behind it. app.hide() is never used while another MetinBul
// window is visible, because it would hide that window too.
function returnFocusAfterQuickSearch() {
  const target = quickSearchReturnTarget;
  quickSearchReturnTarget = null;
  if (target && !target.isDestroyed() && target.isVisible()) {
    target.focus();
    return;
  }
  if (process.platform === 'darwin' && appIsActive && !hasVisibleWindowOtherThanQuickSearch()) {
    app.hide();
  }
}

function toggleQuickSearch() {
  const win = quickSearchWindow;
  if (win && !win.isDestroyed() && win.isVisible()) {
    // Windows: a visible-but-unfocused framed window is brought forward
    // rather than closed, as before.
    if (process.platform !== 'darwin' && !win.isFocused()) {
      win.focus();
      return;
    }
    hideQuickSearch('toggle');
    return;
  }
  showQuickSearch();
}

// globalShortcut.register never throws on failure -- it returns false, e.g.
// when another app already owns the combo. Callers must check the return
// value rather than assuming success.
function registerQuickSearchShortcut(accelerator: string): boolean {
  if (registeredQuickSearchAccelerator) {
    globalShortcut.unregister(registeredQuickSearchAccelerator);
    registeredQuickSearchAccelerator = null;
  }
  const ok = globalShortcut.register(accelerator, toggleQuickSearch);
  if (ok) {
    registeredQuickSearchAccelerator = accelerator;
    quickSearchShortcutError = null;
  } else {
    // Never swallowed: recorded for the settings UI to show, and logged with
    // enough context to diagnose from a terminal-launched build.
    quickSearchShortcutError =
      `"${formatAcceleratorForDisplay(accelerator, process.platform)}" kısayolu kaydedilemedi. ` +
      'Büyük olasılıkla başka bir uygulama bu kısayolu kullanıyor.';
    console.error(
      `[MetinBul] Global shortcut registration FAILED for accelerator "${accelerator}" ` +
      `(platform=${process.platform}). Quick Search cannot be invoked by keyboard until ` +
      'a different shortcut is chosen.'
    );
  }
  // The menu shows the live shortcut next to "Hızlı Arama", and every open
  // surface that displays it is told.
  setupAppMenu();
  broadcast('app:shortcutChanged');
  return ok;
}

// Runs the indexing pipeline (scan + extract + DB writes) on a worker thread
// rather than the Electron main process, which also owns every other IPC
// handler (search, open file, folder picker). indexAccessibleDocuments and
// AppDatabase have no Electron dependency, so the worker just re-runs the
// same pure functions the unit tests exercise directly, on its own SQLite
// connection to the same WAL-mode DB file.
// 'user': setup, "Belgeleri Güncelle" or a scope change. 'auto': the
// automatic update timer. Automatic passes are tagged on every progress event
// so the windows can keep them quiet.
type IndexTrigger = 'user' | 'auto';

function triggerIndexing(trigger: IndexTrigger = 'user') {
  if (isIndexing) return;
  isIndexing = true;
  invalidateIndexCounts();

  const dbPath = getDbPath();
  const worker = new Worker(path.join(__dirname, 'indexer-worker.js'), {
    // An automatic pass leaves unchanged unreadable files alone: re-reading
    // them every ten minutes would only fail again. A user's update still
    // retries them.
    workerData: { dbPath, retryFailed: trigger === 'user', ocr: ocrWorkerOptions() }
  });
  currentIndexingWorker = worker;

  worker.on('message', (msg: { type: 'progress'; progress: IndexProgress } | { type: 'done'; summary: { skippedDataless: number } } | { type: 'error'; message: string }) => {
    if (msg.type === 'progress') {
      if (msg.progress.status === 'completed') {
        // Recorded before the event goes out, so a surface that refreshes on
        // "completed" already reads the new "Son güncelleme" time.
        const appDb = getDb();
        appDb.setAppSetting('last_index_completed_at', String(Date.now()));
        if (typeof msg.progress.skippedDataless === 'number') {
          appDb.setAppSetting('last_skipped_dataless_count', String(msg.progress.skippedDataless));
        }
        lastIndexProgress = null;
        invalidateIndexCounts();
      } else {
        lastIndexProgress = msg.progress;
      }
      broadcast('index:progress', { ...msg.progress, trigger });
    } else if (msg.type === 'done') {
      // Persisted (not just relayed in the completed progress event) so the
      // hint survives an app restart without needing a fresh scan.
      getDb().setAppSetting('last_skipped_dataless_count', String(msg.summary.skippedDataless ?? 0));
    } else if (msg.type === 'error') {
      console.error('Indexing error:', msg.message);
      lastIndexProgress = null;
      broadcast('index:progress', {
        total: 0,
        current: 0,
        status: 'error',
        message: msg.message,
        trigger
      });
    }
  });

  worker.on('error', (error) => {
    console.error('Indexer worker crashed:', error);
    lastIndexProgress = null;
    broadcast('index:progress', {
      total: 0,
      current: 0,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      trigger
    });
  });

  worker.on('exit', () => {
    isIndexing = false;
    currentIndexingWorker = null;
    lastIndexProgress = null;
    invalidateIndexCounts();
    // Whoever started this update, the next automatic one is a full interval
    // away: never on top of a running pass, never right after a manual one.
    scheduleAutoIndex();
  });
}

function scheduleAutoIndex() {
  if (autoIndexTimer) clearTimeout(autoIndexTimer);
  autoIndexTimer = null;
  autoIndexDueAt = null;
  if (!autoIndexEnabled || isQuitting) return;
  autoIndexDueAt = Date.now() + AUTO_INDEX_INTERVAL_MS;
  autoIndexTimer = setTimeout(runAutoIndex, AUTO_INDEX_INTERVAL_MS);
}

function runAutoIndex() {
  autoIndexTimer = null;
  autoIndexDueAt = null;
  if (shouldRunAutoIndex({ enabled: autoIndexEnabled, isIndexing, onboardingPending: pendingOnboarding })) {
    triggerIndexing('auto');
  } else if (!isIndexing) {
    // Setup is not finished yet: look again an interval later. (A running
    // update re-arms the timer itself when it ends.)
    scheduleAutoIndex();
  }
}

app.whenReady().then(() => {
  // A losing second instance has already called app.quit() above; bail out
  // before it can open the profile DB or steal the shortcut registration.
  if (!gotSingleInstanceLock) return;

  if (process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath));
  }

  const appDb = getDb();

  const savedTheme = appDb.getAppSetting('theme');
  if (isValidTheme(savedTheme)) {
    currentTheme = savedTheme;
  }
  nativeTheme.themeSource = currentTheme;

  setupAppMenu();

  pendingOnboarding = resolveShouldShowOnboarding(appDb);
  // Default ON since the Quick Search redesign. On macOS MetinBul is a
  // resident search utility whose only real window is Settings, so closing
  // that window must not take the global shortcut down with it -- unless the
  // user has said so: an explicit "0" from the checkbox is still honoured.
  keepRunningInBackground = parseBooleanSetting(
    appDb.getAppSetting('keep_running_in_background'),
    true
  );
  autoIndexEnabled = parseBooleanSetting(appDb.getAppSetting('auto_index_enabled'), true);
  ocrEnabled = parseBooleanSetting(appDb.getAppSetting('ocr_enabled'), true);
  ocrHelperPath = locateOcrHelper();
  void refreshOcrAvailability();
  launchedAtLogin = wasLaunchedAtLogin(
    process.platform,
    process.argv,
    isStartAtLoginSupported(process.platform)
      ? app.getLoginItemSettings(buildLoginItemQueryOptions(process.platform, process.execPath))
      : undefined
  );

  const INACCESSIBLE_FILE_ERROR = 'Bu dosyaya şu anda erişilemiyor. Dosya taşınmış, silinmiş veya ilgili sürücü bağlı olmayabilir.';

  // IPC Handlers
  ipcMain.handle('app:shouldShowOnboarding', () => {
    return pendingOnboarding;
  });

  ipcMain.handle('app:completeOnboarding', async (
    _event,
    mode: 'all' | 'selected',
    folders?: string[],
    options?: { startAtLogin?: boolean }
  ) => {
    try {
      appDb.setSearchScopeMode(mode);
      if (mode === 'selected' && Array.isArray(folders)) {
        for (const folder of folders) {
          if (typeof folder === 'string' && folder) {
            appDb.addSearchArea(folder, 'include');
          }
        }
      }
      // A fresh install decides "start at login" during setup, with the box
      // ticked by default and in plain view -- the login item is never
      // registered behind the user's back. Upgrading users are not touched:
      // they never see this screen, and their current OS setting stands.
      if (options && typeof options.startAtLogin === 'boolean' && isStartAtLoginSupported(process.platform)) {
        try {
          app.setLoginItemSettings(
            buildLoginItemConfig(process.platform, options.startAtLogin, process.execPath)
          );
        } catch (err) {
          console.error('[MetinBul] Failed to apply the setup start-at-login choice:', err);
        }
      }
      appDb.setOnboardingCompleted();
      pendingOnboarding = false;
      triggerIndexing();
      return true;
    } catch (err) {
      console.error('Failed to complete onboarding:', err);
      return false;
    }
  });

  ipcMain.handle('app:getDocumentCount', () => getSearchService().documentCount());

  ipcMain.handle('app:getLastSkippedDataless', () => {
    const value = appDb.getAppSetting('last_skipped_dataless_count');
    const parsed = value ? Number.parseInt(value, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  });

  ipcMain.handle('app:rescan', async () => {
    await triggerIndexing();
    return true;
  });

  ipcMain.handle('app:search', async (event, query: string, sort?: string) => {
    const validSort = sort === 'oldest' || sort === 'relevance' ? sort : 'modified';
    const text = typeof query === 'string' ? query : '';
    const outcome = await getSearchService().search(event.sender.id, text, validSort, 100);
    if (outcome.state === 'search_error') {
      lastSearchError = { at: Date.now(), message: outcome.error ?? 'bilinmeyen hata' };
      // The search terms themselves are never written anywhere.
      console.error(`[MetinBul] Search failed (sort=${validSort}, query length=${text.length}): ${outcome.error}`);
    }
    return outcome;
  });

  ipcMain.handle('app:getSearchScopeMode', () => {
    return appDb.getSearchScopeMode();
  });

  ipcMain.handle('app:setSearchScopeMode', async (_event, mode: 'all' | 'selected') => {
    try {
      appDb.setSearchScopeMode(mode);
      invalidateIndexCounts();
      triggerIndexing();
      return true;
    } catch (err) {
      console.error('Failed to set search scope mode:', err);
      return false;
    }
  });

  ipcMain.handle('app:getSearchAreas', () => {
    return appDb.getSearchAreas();
  });

  ipcMain.handle('app:addSearchArea', async (_event, folderPath: string, type: 'include' | 'exclude') => {
    try {
      if (!folderPath || typeof folderPath !== 'string') return false;
      appDb.addSearchArea(folderPath, type);
      invalidateIndexCounts();
      triggerIndexing();
      return true;
    } catch (err) {
      console.error('Failed to add search area:', err);
      return false;
    }
  });

  ipcMain.handle('app:removeSearchArea', async (_event, folderPath: string) => {
    try {
      if (!folderPath || typeof folderPath !== 'string') return false;
      appDb.removeSearchArea(folderPath);
      invalidateIndexCounts();
      triggerIndexing();
      return true;
    } catch (err) {
      console.error('Failed to remove search area:', err);
      return false;
    }
  });

  ipcMain.handle('app:selectFolder', async (event) => {
    // Parented to whichever window asked (Settings on macOS, the main window
    // on Windows) -- macOS has no main window to hang the sheet on any more.
    const owner = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Arama Alanı Seç'
    };
    const result = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('app:openFile', async (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: INACCESSIBLE_FILE_ERROR };
      }
      const error = await shell.openPath(filePath);
      if (error) {
        return { success: false, error: INACCESSIBLE_FILE_ERROR };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: INACCESSIBLE_FILE_ERROR };
    }
  });

  ipcMain.handle('app:showInFolder', (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: INACCESSIBLE_FILE_ERROR };
      }
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: INACCESSIBLE_FILE_ERROR };
    }
  });

  ipcMain.handle('app:getAboutInfo', () => {
    return getAboutMetadata();
  });

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    try {
      if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')) {
        await shell.openExternal(url);
        return { success: true };
      }
      return { success: false, error: 'Invalid URL protocol' };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('app:sendFeedback', async () => {
    const mailtoUrl = getFeedbackMailto();
    if (mailtoUrl) {
      await shell.openExternal(mailtoUrl);
      return { success: true };
    }
    return { success: false, error: 'Feedback target is not configured' };
  });

  ipcMain.handle('app:copyToClipboard', (_event, text: string) => {
    try {
      if (typeof text === 'string') {
        clipboard.writeText(text);
        return { success: true };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('app:getTheme', () => {
    return currentTheme;
  });

  ipcMain.handle('app:setTheme', (_event, theme: AppTheme) => {
    setAppTheme(theme);
    return true;
  });

  ipcMain.handle('app:checkForUpdates', async (_event) => {
    const version = getPackageVersion();
    return checkForUpdates(version);
  });

  ipcMain.handle('app:getQuickSearchShortcut', () => {
    const accelerator = appDb.getAppSetting('quick_search_shortcut') || getDefaultAccelerator(process.platform);
    const registered = registeredQuickSearchAccelerator === accelerator;
    return {
      accelerator,
      display: formatAcceleratorForDisplay(accelerator, process.platform),
      registered,
      error: registered ? undefined : (quickSearchShortcutError ?? undefined)
    };
  });

  ipcMain.handle('app:setQuickSearchShortcut', (_event, accelerator: string) => {
    // Reported separately from a plain syntax error: the user needs to know
    // *why* this particular combination is refused (spec §8).
    if (conflictsWithScreenReader(accelerator)) {
      return { success: false, error: SCREEN_READER_CONFLICT_MESSAGE };
    }
    if (!isValidAccelerator(accelerator)) {
      return { success: false, error: 'Geçersiz kısayol.' };
    }
    const previous = registeredQuickSearchAccelerator;
    const ok = registerQuickSearchShortcut(accelerator);
    if (ok) {
      appDb.setAppSetting('quick_search_shortcut', accelerator);
      return { success: true };
    }
    // Restore the previous working shortcut rather than leaving none active.
    if (previous) {
      registerQuickSearchShortcut(previous);
    }
    return { success: false, error: 'Bu kısayol başka bir uygulama tarafından kullanılıyor. Farklı bir kısayol deneyin.' };
  });

  ipcMain.handle('app:getStartupSettings', () => {
    return getStartupSettingsPayload();
  });

  ipcMain.handle('app:setStartAtLogin', (_event, enabled: boolean) => {
    if (!isStartAtLoginSupported(process.platform)) {
      return {
        success: false,
        error: 'Bu özellik bu işletim sisteminde kullanılamıyor.',
        settings: getStartupSettingsPayload()
      };
    }
    const wanted = enabled === true;
    try {
      app.setLoginItemSettings(
        buildLoginItemConfig(process.platform, wanted, process.execPath)
      );
    } catch (err) {
      console.error('[MetinBul] Failed to write login item settings:', err);
      return {
        success: false,
        error: 'Başlangıç öğesi güncellenemedi.',
        settings: getStartupSettingsPayload()
      };
    }
    // Verified against the OS instead of assumed: setLoginItemSettings has
    // no return value and fails quietly (a sandboxed/unapproved bundle, a
    // locked-down Run key), which is exactly the silent failure this
    // feature must not have.
    const settings = getStartupSettingsPayload();
    if (settings.startAtLogin !== wanted) {
      return {
        success: false,
        error: 'İşletim sistemi bu ayarı kabul etmedi. Sistem ayarlarından başlangıç öğelerini denetleyin.',
        settings
      };
    }
    return { success: true, settings };
  });

  ipcMain.handle('app:setKeepRunningInBackground', (_event, enabled: boolean) => {
    if (!canStayResident()) {
      return {
        success: false,
        error: 'Bu özellik bu işletim sisteminde kullanılamıyor.',
        settings: getStartupSettingsPayload()
      };
    }
    keepRunningInBackground = enabled === true;
    appDb.setAppSetting(
      'keep_running_in_background',
      serializeBooleanSetting(keepRunningInBackground)
    );
    return { success: true, settings: getStartupSettingsPayload() };
  });

  ipcMain.handle('app:setAutoIndexEnabled', (_event, enabled: boolean) => {
    autoIndexEnabled = enabled === true;
    appDb.setAppSetting('auto_index_enabled', serializeBooleanSetting(autoIndexEnabled));
    scheduleAutoIndex();
    return getIndexStatusPayload();
  });

  // Takes effect from the next update; documents already read keep their text.
  ipcMain.handle('app:setOcrEnabled', (_event, enabled: boolean) => {
    ocrEnabled = enabled === true;
    appDb.setAppSetting('ocr_enabled', serializeBooleanSetting(ocrEnabled));
    return getIndexStatusPayload();
  });

  // Asks Windows for the Turkish OCR component (the user approves the
  // administrator prompt); takes effect from the next update.
  ipcMain.handle('app:installWindowsTurkishOcr', async () => {
    if (process.platform !== 'win32') return { success: false, status: await getIndexStatusPayload() };
    const installed = await installWindowsTurkishOcr();
    await refreshOcrAvailability();
    return { success: installed && ocrAvailable, status: await getIndexStatusPayload() };
  });

  ipcMain.handle('app:hideQuickSearch', (_event, reason?: string) => {
    hideQuickSearch(reason === 'open' ? 'open' : 'dismiss');
    return true;
  });

  // The panel reports the height its content needs; the window follows,
  // between the compact search field and the per-display maximum.
  ipcMain.handle('quick-search:setHeight', (event, contentHeight: number, allowShrink: boolean) => {
    const win = quickSearchWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight)) return false;
    const current = win.getContentBounds();
    // The renderer measures in CSS pixels; window bounds are in DIPs, which
    // differ once the user zooms the panel (Görünüm › Büyüt).
    const height = nextPanelHeight(
      current.height,
      contentHeight * win.webContents.getZoomFactor(),
      { min: QUICK_SEARCH_COMPACT_HEIGHT, max: quickSearchMaxHeight },
      allowShrink === true
    );
    if (height !== current.height) {
      win.setContentBounds({ ...current, height }, false);
    }
    return true;
  });

  // Right-click on a result. The chosen action goes back to the panel, which
  // runs it through the same path as Enter / Cmd+Enter (including the error
  // shown when a file has gone missing).
  ipcMain.handle('quick-search:showResultMenu', (event, filePath: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || typeof filePath !== 'string' || !filePath) return false;
    const send = (action: 'open' | 'reveal') => {
      if (!win.isDestroyed()) win.webContents.send('quick-search:resultAction', { action, path: filePath });
    };
    const menu = Menu.buildFromTemplate([
      { label: 'Aç', click: () => send('open') },
      { label: process.platform === 'darwin' ? 'Finder’da Göster' : 'Klasörde Göster', click: () => send('reveal') }
    ]);
    quickSearchMenuOpen = true;
    menu.popup({
      window: win,
      callback: () => {
        quickSearchMenuOpen = false;
      }
    });
    return true;
  });

  ipcMain.handle('app:openSettings', (_event, section?: string) => {
    openSettingsWindow(isSettingsSection(section) ? section : 'general');
    return true;
  });

  ipcMain.handle('app:getIndexStatus', () => {
    return getIndexStatusPayload();
  });

  ipcMain.handle('app:getUnreadableDocuments', () => getSearchService().unreadableDocuments(200));

  ipcMain.handle('app:getUpdateInfo', () => {
    return latestUpdateInfo;
  });

  // One-time migration: the theme used to live only in the main window's
  // localStorage. The first surface to load hands it over if the main
  // process has never stored one; afterwards app_settings is the source.
  ipcMain.handle('app:adoptLegacyTheme', (_event, theme: unknown) => {
    if (appDb.getAppSetting('theme') === undefined && isValidTheme(theme)) {
      setAppTheme(theme);
    }
    return currentTheme;
  });

  // The panel is built hidden on every launch so the shortcut answers
  // instantly; it is the one renderer MetinBul keeps while idle.
  createQuickSearchWindow();
  createTray();

  const savedAccelerator = appDb.getAppSetting('quick_search_shortcut') || getDefaultAccelerator(process.platform);
  if (!registerQuickSearchShortcut(savedAccelerator)) {
    console.error(`Failed to register Quick Search shortcut: ${savedAccelerator}`);
  }

  if (usesUtilityShell) {
    // macOS. A login launch shows nothing at all: MetinBul is ready behind
    // the shortcut and the Dock icon. A deliberate launch (Finder,
    // Spotlight, Dock) gets the search field straight away -- or setup, the
    // first time.
    if (pendingOnboarding) {
      openSettingsWindow('onboarding');
    } else if (!launchedAtLogin) {
      showQuickSearch();
    }
  } else {
    // Windows/Linux keep the main window. A login launch stays out of the
    // way: behind the notification area icon where MetinBul can stay resident
    // (unless setup is still to be done), otherwise minimized in the taskbar.
    if (!launchedAtLogin || !shouldStayResident() || pendingOnboarding) {
      createWindow({ startMinimized: launchedAtLogin });
    }
  }

  // No index pass at startup -- not at login, not on a normal launch, not
  // deferred to first use. The persisted index is searchable the moment the
  // process is up; re-scanning the whole document set (~2,800 files on the
  // real profile, with re-extraction of every previously failed file) on each
  // start was the second half of the P0. Indexing runs when the user asks for
  // it (setup, a scope change, "Belgeleri Güncelle" / "Yeniden Tara") and,
  // unless they turned it off, every AUTO_INDEX_INTERVAL_MS -- the first time
  // one full interval after launch.
  scheduleAutoIndex();

  // Silent update check: at launch where a main window is up (Windows/Linux,
  // not at login), otherwise the first time a surface is opened (see
  // noteSurfaceOpened). Boot time never spends network on it.
  if (!usesUtilityShell && !launchedAtLogin) {
    scheduleUpdateCheck(3000);
  }

  app.on('activate', (_event, hasVisibleWindows) => {
    // A visible panel already answers the request; handleReopen also covers
    // the panel being up when a Dock click arrives.
    if (quickSearchWindow && !quickSearchWindow.isDestroyed() && quickSearchWindow.isVisible()) {
      return;
    }
    handleReopen(hasVisibleWindows);
  });
});

app.on('window-all-closed', () => {
  // Residency is the user's choice: with "Pencere kapandığında arka planda
  // açık tut" on (macOS and Windows; the default), MetinBul keeps running so
  // the global Quick Search shortcut and the automatic updates go on, and
  // "MetinBul'dan Çık" (Cmd+Q, or the notification area icon's menu) stays
  // the real quit. With it off, closing the last window quits.
  //
  // In practice mainWindow's 'closed' handler gets there first, because the
  // hidden Quick Search window keeps this event from firing; this is the
  // backstop for the paths where it does.
  if (!shouldStayResident()) {
    if (db) {
      db.close();
      db = null;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  globalShortcut.unregisterAll();
  registeredQuickSearchAccelerator = null;
  if (autoIndexTimer) {
    clearTimeout(autoIndexTimer);
    autoIndexTimer = null;
  }

  // Terminating mid-run is safe: indexer writes are one transaction per file
  // (better-sqlite3) and the DB is WAL-mode/crash-safe, so at worst the
  // in-flight file gets re-indexed on next launch.
  if (currentIndexingWorker) {
    currentIndexingWorker.terminate();
    currentIndexingWorker = null;
  }
  searchService?.close();
  if (db) {
    db.close();
    db = null;
  }
});
