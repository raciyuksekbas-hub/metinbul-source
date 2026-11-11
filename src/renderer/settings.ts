// The Settings window: configuration and maintenance, kept apart from the
// search panel so that searching never has to look past either. Four
// sections -- Genel, Arama Konumları, İndeks, Hakkında -- plus first-run
// setup, which replaces the tabs until a scope has been chosen.
import { announce, announceAlways } from './announcer.js';
import { loadA11yPrefs, applyA11yPrefs, A11Y_PREFS_STORAGE_KEY } from './a11y-prefs.js';
import { THEME_STORAGE_KEY } from '../shared/theme.js';
import { renderGeneralView, syncThemeRadios } from './settings/general-view.js';
import { renderLocationsView } from './settings/locations-view.js';
import { renderIndexView } from './settings/index-view.js';
import { renderAboutView, noteUpdateAvailable } from './settings/about-view.js';
import { renderOnboardingView } from './settings/onboarding-view.js';
import type { AppTheme, SettingsSection, IndexProgressData } from './window-api.js';

type TabSection = Exclude<SettingsSection, 'onboarding'>;
const TABS: TabSection[] = ['general', 'locations', 'index', 'about'];
const TAB_TITLES: Record<TabSection, string> = {
  general: 'Genel',
  locations: 'Arama Konumları',
  index: 'İndeks',
  about: 'Hakkında'
};

const IS_MAC = /Mac/i.test(navigator.userAgent);
const tablist = document.getElementById('settings-tabs') as HTMLDivElement;
const onboardingPanel = document.getElementById('panel-onboarding') as HTMLElement;

let activeTab: TabSection = 'general';
let indexNotice: string | null = null;

function tabButton(section: TabSection): HTMLButtonElement {
  return document.getElementById(`tab-${section}`) as HTMLButtonElement;
}

function tabPanel(section: TabSection): HTMLElement {
  return document.getElementById(`panel-${section}`) as HTMLElement;
}

async function renderSection(section: TabSection, extra: { checkUpdates?: boolean } = {}) {
  const panel = tabPanel(section);
  switch (section) {
    case 'general':
      // The "linear results" preference only changes the Windows main
      // window's result list; on macOS there is nothing for it to affect.
      await renderGeneralView(panel, { showLinearResultsOption: !IS_MAC });
      break;
    case 'locations':
      await renderLocationsView(panel);
      break;
    case 'index':
      await renderIndexView(panel, { notice: indexNotice });
      break;
    case 'about':
      await renderAboutView(panel, { checkUpdates: extra.checkUpdates });
      break;
  }
}

async function activateTab(section: TabSection, options: { focusTab?: boolean; checkUpdates?: boolean } = {}) {
  activeTab = section;
  tablist.hidden = false;
  onboardingPanel.hidden = true;
  for (const tab of TABS) {
    const selected = tab === section;
    const button = tabButton(tab);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    tabPanel(tab).hidden = !selected;
  }
  document.title = `MetinBul Ayarları — ${TAB_TITLES[section]}`;
  await renderSection(section, { checkUpdates: options.checkUpdates });
  if (options.focusTab) tabButton(section).focus();
}

async function showOnboarding() {
  tablist.hidden = true;
  for (const tab of TABS) tabPanel(tab).hidden = true;
  onboardingPanel.hidden = false;
  document.title = 'MetinBul Kurulumu';
  await renderOnboardingView(onboardingPanel, {
    onComplete: async () => {
      indexNotice = 'Kurulum tamamlandı. Belgeleriniz indeksleniyor; bu sırada arama yapabilirsiniz.';
      await activateTab('index', { focusTab: true });
    }
  });
  (onboardingPanel.querySelector('input[name="onboarding-mode"]:checked') as HTMLElement | null)?.focus();
  announce('MetinBul kurulumu. Nerede aramak istediğinizi seçin.');
}

async function navigate(section: SettingsSection, options: { checkUpdates?: boolean } = {}) {
  if (section === 'onboarding') {
    if (await window.api.shouldShowOnboarding()) {
      await showOnboarding();
      return;
    }
    section = 'general';
  }
  await activateTab(section, { focusTab: true, checkUpdates: options.checkUpdates });
  announce(`${TAB_TITLES[section]} ayarları.`);
}

// --- Tabs: click, arrows, Home/End --------------------------------------------
for (const section of TABS) {
  tabButton(section).addEventListener('click', () => void activateTab(section, { focusTab: true }));
}

tablist.addEventListener('keydown', (e) => {
  const current = TABS.indexOf(activeTab);
  let next = -1;
  if (e.key === 'ArrowRight') next = (current + 1) % TABS.length;
  else if (e.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TABS.length - 1;
  if (next >= 0) {
    e.preventDefault();
    void activateTab(TABS[next], { focusTab: true });
  }
});

// --- Theme and accessibility preferences -----------------------------------------
function applyTheme(theme: AppTheme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function readLegacyTheme(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

window.api?.onThemeChanged?.((theme) => {
  applyTheme(theme);
  syncThemeRadios(tabPanel('general'), theme);
});

applyA11yPrefs(loadA11yPrefs());
window.addEventListener('storage', (event) => {
  if (event.key === A11Y_PREFS_STORAGE_KEY) applyA11yPrefs(loadA11yPrefs());
});

// --- Live state from the main process ---------------------------------------------
// Progress events can arrive many times a second during a scan; the İndeks
// page re-renders at most a few times a second, and only while it is shown.
let indexRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshIndexSoon() {
  if (activeTab !== 'index' || !onboardingPanel.hidden) return;
  if (indexRefreshTimer) return;
  indexRefreshTimer = setTimeout(() => {
    indexRefreshTimer = null;
    if (activeTab === 'index' && onboardingPanel.hidden) void renderSection('index');
  }, 400);
}

let lastAnnouncedPhase = '';
window.api.onProgress((progress: IndexProgressData) => {
  // Only transitions are announced; a per-tick live region would make the
  // window unusable with a screen reader. Automatic updates (every ten
  // minutes) are not announced at all unless they fail.
  if (progress.status !== lastAnnouncedPhase) {
    if (progress.trigger === 'auto') {
      if (progress.status === 'error') announce('Otomatik güncelleme tamamlanamadı.');
    } else if (progress.status === 'scanning') announce('Belgeleriniz taranıyor.');
    else if (progress.status === 'indexing') announce('İndeksleme başladı.');
    else if (progress.status === 'completed') announce('İndeks güncellendi.');
    else if (progress.status === 'error') announceAlways('İndeksleme tamamlanamadı.', 'assertive');
    lastAnnouncedPhase = progress.status === 'completed' || progress.status === 'error' ? '' : progress.status;
  }
  refreshIndexSoon();
});

window.api?.onShortcutChanged?.(() => {
  if (activeTab === 'general' && onboardingPanel.hidden) {
    const kbd = document.getElementById('shortcut-current');
    if (kbd) {
      void window.api.getQuickSearchShortcut().then(s => {
        kbd.textContent = s.display || s.accelerator;
      });
    }
  }
});

window.api?.onUpdateAvailable?.((info) => {
  noteUpdateAvailable(info);
  if (activeTab === 'about' && onboardingPanel.hidden) void renderSection('about');
});

window.api?.onSettingsNavigate?.(({ section, checkUpdates }) => {
  void navigate(section, { checkUpdates });
});

// --- Start ----------------------------------------------------------------------------
(async function init() {
  try {
    applyTheme(await window.api.adoptLegacyTheme(readLegacyTheme()));
  } catch {
    // Keep the markup default.
  }
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('section') as SettingsSection | null;
  const section: SettingsSection = requested && (requested === 'onboarding' || (TABS as string[]).includes(requested))
    ? requested
    : 'general';
  await navigate(section, { checkUpdates: params.get('checkUpdates') === '1' });
})();
