// MetinBul main window -- Windows and Linux only.
//
// macOS has no main window any more: there MetinBul is the Quick Search panel
// plus a Settings window. Windows/Linux keep this window as their main
// surface; on Windows it can be closed and reopened from the notification area
// icon. Its settings, search areas and about dialogs now open the shared Settings
// window, so both platforms configure MetinBul in exactly the same place.
import { createResultRowElement } from './result-card.js';
import { announce, announceAlways } from './announcer.js';
import { trapFocus, type FocusTrapHandle } from './focus-trap.js';
import { loadA11yPrefs, applyA11yPrefs, A11Y_PREFS_STORAGE_KEY } from './a11y-prefs.js';
import { renderOnboardingView } from './settings/onboarding-view.js';
import { THEME_STORAGE_KEY } from '../shared/theme.js';
import { QUERY_TOO_SHORT_MESSAGE } from '../shared/quick-search-model.js';
import {
  getAccessibleSearchStatus,
  getAccessibleDocumentCount,
  getAccessibleIndexingStatus,
  SEARCH_STATUS_SEARCHING,
  ERROR_MESSAGES,
  formatCount
} from '../shared/a11y-text.js';
import type { SearchResultItem, IndexProgressData, UpdateCheckInfo, AppTheme, SearchSortMode } from './window-api.js';

// DOM Elements
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const footerText = document.getElementById('footer-text') as HTMLSpanElement;
const datalessHint = document.getElementById('dataless-hint') as HTMLSpanElement;
const btnRescan = document.getElementById('btn-rescan') as HTMLButtonElement;
const btnSearchAreas = document.getElementById('btn-search-areas') as HTMLButtonElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const btnClearSearch = document.getElementById('btn-clear-search') as HTMLButtonElement;
const resultsHeader = document.getElementById('results-header') as HTMLDivElement;
const resultsCount = document.getElementById('results-count') as HTMLSpanElement;
const resultsList = document.getElementById('results-list') as HTMLDivElement;
const sortSelect = document.getElementById('sort-select') as HTMLSelectElement;

let currentSort: SearchSortMode = 'modified';

// Update Banner Elements
const updateBanner = document.getElementById('update-banner') as HTMLDivElement;
const updateBannerText = document.getElementById('update-banner-text') as HTMLSpanElement;
const btnViewUpdate = document.getElementById('btn-view-update') as HTMLButtonElement;
const btnDismissUpdate = document.getElementById('btn-dismiss-update') as HTMLButtonElement;

// Footer actions and the first-run setup dialog
const actionThemeToggle = document.getElementById('action-theme-toggle') as HTMLButtonElement;
const actionShortcut = document.getElementById('action-shortcut') as HTMLButtonElement;
const actionSearchAreas = document.getElementById('action-search-areas') as HTMLButtonElement;
const actionAbout = document.getElementById('action-about') as HTMLButtonElement;
const onboardingOverlay = document.getElementById('onboarding-overlay') as HTMLDivElement;
const onboardingBody = document.getElementById('onboarding-body') as HTMLDivElement;
const appContainer = document.querySelector('.app-container') as HTMLElement;

let searchDebounceTimer: any = null;
let currentUpdateUrl: string = '';
let activeTheme: AppTheme = 'dark';

// Theme Management
function applyTheme(theme: AppTheme, notifyMain: boolean = true) {
  activeTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', activeTheme);
  
  if (actionThemeToggle) {
    actionThemeToggle.textContent = activeTheme === 'dark' ? 'Tema: Koyu' : 'Tema: Açık';
  }

  try {
    localStorage.setItem('metinbul:theme', activeTheme);
  } catch {
    // Ignore storage failure
  }

  if (notifyMain && window.api?.setTheme) {
    window.api.setTheme(activeTheme);
  }
}

async function initTheme() {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    legacy = null;
  }
  try {
    // The main process stores the theme now; a choice that only this
    // window's storage knew about is handed over once, then followed.
    applyTheme(await window.api.adoptLegacyTheme(legacy), false);
  } catch {
    applyTheme(legacy === 'light' ? 'light' : 'dark', false);
  }
}

// Render search results.
//
// The list is exposed as a real list collection and its accessible name
// carries the count, so a reader entering the region hears "18 sonuç, liste"
// rather than an unnamed group of divs (spec §11).
function renderResults(results: SearchResultItem[], query: string, emptyScopeHint?: string) {
  resultsList.innerHTML = '';

  if (!query.trim()) {
    resultsHeader.classList.add('hidden');
    resultsList.removeAttribute('role');
    resultsList.removeAttribute('aria-label');
    resultsList.innerHTML = `
      <div class="placeholder-state">
        <p>Belgelerinizde aramak istediğiniz ifadeyi yazın.</p>
      </div>
    `;
    return;
  }

  resultsHeader.classList.remove('hidden');
  resultsCount.textContent = `${formatCount(results.length)} sonuç`;

  if (results.length === 0) {
    resultsList.removeAttribute('role');
    resultsList.setAttribute('aria-label', 'Arama sonuçları');
    resultsList.innerHTML = `
      <div class="placeholder-state">
        <p>${emptyScopeHint || 'Eşleşen belge bulunamadı.'}</p>
      </div>
    `;
    return;
  }

  resultsList.setAttribute('role', 'list');
  resultsList.setAttribute('aria-label', `Arama sonuçları, ${formatCount(results.length)} belge`);

  results.forEach((result, i) => {
    const row = createResultRowElement(result, {
      onOpen: handleOpenFile,
      onShowInFolder: handleShowInFolder
    }, {
      showMultipleSnippets: true,
      index: i + 1,
      total: results.length,
      query
    });
    resultsList.appendChild(row);
  });
}

let statusTimeoutTimer: any = null;

function showTemporaryStatus(message: string, durationMs: number = 4000) {
  if (statusTimeoutTimer) {
    clearTimeout(statusTimeoutTimer);
  }
  statusText.textContent = message;
  statusTimeoutTimer = setTimeout(() => {
    updateStatusFromDb();
  }, durationMs);
}

async function handleOpenFile(filePath: string) {
  const res = await window.api.openFile(filePath);
  if (!res.success && res.error) {
    showTemporaryStatus(res.error);
  }
}

async function handleShowInFolder(filePath: string) {
  const res = await window.api.showInFolder(filePath);
  if (!res.success && res.error) {
    showTemporaryStatus(res.error);
  }
}

// Perform search
// Guards against an out-of-order response overwriting a newer one, and lets
// the announcement describe the query the user actually last typed.
let searchToken = 0;

async function performSearch(query: string) {
  if (!query || !query.trim()) {
    btnClearSearch.classList.add('hidden');
    renderResults([], '');
    return;
  }

  btnClearSearch.classList.remove('hidden');
  const token = ++searchToken;

  // Announced once per settled search, never per keystroke: the debounce
  // above is what keeps NVDA/JAWS from being flooded (spec §10).
  announce(SEARCH_STATUS_SEARCHING);

  try {
    const [outcome, emptyScope] = await Promise.all([
      window.api.search(query, currentSort),
      hasEmptySelectedScope()
    ]);
    if (token !== searchToken) return;

    // A failed search is reported as one, never as an empty result list
    // (P0: search_error used to arrive here as []).
    if (outcome.state === 'search_error') {
      renderResults([], query, ERROR_MESSAGES.searchFailed);
      announceAlways(ERROR_MESSAGES.searchFailed, 'assertive');
      return;
    }
    if (outcome.state === 'index_not_ready') {
      renderResults([], query, INDEX_NOT_READY_MESSAGE);
      announceAlways(INDEX_NOT_READY_MESSAGE);
      return;
    }
    if (outcome.state === 'query_too_short') {
      renderResults([], query, QUERY_TOO_SHORT_MESSAGE);
      announce(QUERY_TOO_SHORT_MESSAGE);
      return;
    }

    const results = outcome.results;
    renderResults(results, query, emptyScope ? EMPTY_SCOPE_MESSAGE : undefined);

    if (emptyScope && results.length === 0) {
      announceAlways(EMPTY_SCOPE_MESSAGE);
    } else {
      announceAlways(getAccessibleSearchStatus(results.length));
    }
  } catch {
    if (token !== searchToken) return;
    renderResults([], query, ERROR_MESSAGES.searchFailed);
    announceAlways(ERROR_MESSAGES.searchFailed, 'assertive');
  }
}

const INDEX_NOT_READY_MESSAGE = 'Henüz aranabilir belge yok. Belgeleriniz indekslendiğinde arama yapabilirsiniz.';

function updateDatalessHint(count: number) {
  if (!datalessHint) return;
  if (count > 0) {
    const formatted = formatCount(count);
    const spoken = `${formatted} belgenin içeriği bu bilgisayarda bulunmadığı için indekslenmedi. `
      + 'Bu bulut dosyaları klasörlerde görünse de içerikleri indirilmemiştir. '
      + 'MetinBul bu dosyaları kendiliğinden indirmez.';
    datalessHint.textContent = `☁️ ${formatted} belgenin içeriği bu bilgisayarda bulunmadığı için indekslenmedi.`;
    // The emoji must not be spoken as "bulut" before the sentence, and the
    // full explanation was previously only in a mouse-only title attribute.
    datalessHint.setAttribute('aria-label', spoken);
    datalessHint.setAttribute('role', 'note');
    datalessHint.classList.remove('hidden');
  } else {
    datalessHint.classList.add('hidden');
  }
}

const EMPTY_SCOPE_MESSAGE = 'Arama için en az bir klasör seçin.';

async function hasEmptySelectedScope(): Promise<boolean> {
  try {
    const mode = await window.api.getSearchScopeMode();
    if (mode !== 'selected') return false;
    const areas = await window.api.getSearchAreas();
    return !areas.some(a => a.type === 'include');
  } catch {
    return false;
  }
}

async function updateStatusFromDb() {
  try {
    if (await hasEmptySelectedScope()) {
      statusText.textContent = EMPTY_SCOPE_MESSAGE;
      footerText.textContent = EMPTY_SCOPE_MESSAGE;
      return;
    }

    const count = await window.api.getDocumentCount();
    if (count > 0) {
      const formatted = formatCount(count);
      statusText.textContent = `${formatted} belge indekslendi`;
      footerText.textContent = `${formatted} belge indekslendi`;
    } else {
      statusText.textContent = 'Hazır';
      footerText.textContent = '0 belge indekslendi';
    }
    statusText.setAttribute('aria-label', getAccessibleDocumentCount(count));
  } catch {
    statusText.textContent = 'Hazır';
    statusText.setAttribute('aria-label', ERROR_MESSAGES.indexUnavailable);
    footerText.textContent = '';
  }
}

// Update Banner Logic
function showUpdateBanner(info: UpdateCheckInfo) {
  if (!info || !info.updateAvailable) return;
  currentUpdateUrl = info.releaseUrl || 'https://github.com/raciyuksekbas-hub/metinbul-releases/releases';
  if (updateBannerText) {
    updateBannerText.textContent = `MetinBul ${info.latestVersion || ''} kullanılabilir`;
  }
  if (updateBanner) {
    updateBanner.classList.remove('hidden');
  }
  announce(`MetinBul ${info.latestVersion || ''} sürümü kullanılabilir.`.replace(/\s+/g, ' '));
}

function hideUpdateBanner() {
  if (updateBanner) {
    updateBanner.classList.add('hidden');
  }
}

// Everything outside the setup dialog is hidden from assistive tech while it
// is open, so a JAWS/NVDA virtual cursor cannot wander into the window behind
// it. The card itself is never inside an aria-hidden subtree.
function inertRootsFor(card: HTMLElement): HTMLElement[] {
  return Array.from(appContainer.children).filter(
    el => !el.contains(card)
  ) as HTMLElement[];
}

function openSettings(section: 'general' | 'locations' | 'index' | 'about') {
  void window.api.openSettings(section);
}

// First-run setup: shown once, before the first scan, only for a genuinely
// fresh install (see resolveShouldShowOnboarding in main.ts). Deliberately
// has no X / outside-click / Escape close path -- indexing must not start
// before a scope choice is made. The form itself is the shared setup view,
// the same one the Settings window shows on macOS.
let onboardingTrap: FocusTrapHandle | null = null;

async function initOnboardingIfNeeded(): Promise<boolean> {
  try {
    const shouldShow = await window.api.shouldShowOnboarding?.();
    if (!shouldShow) return false;
    onboardingOverlay.classList.remove('hidden');
    await renderOnboardingView(onboardingBody, {
      onComplete: async () => {
        onboardingOverlay.classList.add('hidden');
        onboardingTrap?.release();
        onboardingTrap = null;
        // Focus has nowhere sensible to return to (the dialog opened at
        // startup), so it goes to the primary task instead of <body>.
        searchInput.focus();
        announce('Kurulum tamamlandı. Belgelerinizde arama yapabilirsiniz.');
        await updateStatusFromDb();
      }
    });
    // Deliberately no onEscape: this dialog cannot be dismissed without a
    // scope choice, so trapping without an exit is the intended behaviour.
    const card = onboardingOverlay.querySelector('.popover-card') as HTMLElement;
    onboardingTrap = trapFocus(card, { inertRoots: inertRootsFor(onboardingOverlay) });
    announce('MetinBul kurulumu, iletişim kutusu. Nerede aramak istediğinizi seçin.');
    return true;
  } catch {
    return false;
  }
}

// Event Listeners
searchInput.addEventListener('input', () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    performSearch(searchInput.value);
  }, 150);
});

sortSelect?.addEventListener('change', () => {
  currentSort = (sortSelect.value as SearchSortMode) || 'modified';
  if (searchInput.value.trim()) {
    performSearch(searchInput.value);
  }
});

btnClearSearch.addEventListener('click', () => {
  searchInput.value = '';
  // Focus returns to the search field rather than being lost with the button
  // that is about to be hidden (spec §9, §18).
  searchInput.focus();
  performSearch('');
  announceAlways('Arama temizlendi.');
});

btnRescan.addEventListener('click', async () => {
  statusText.textContent = 'Belgeleriniz taranıyor…';
  announceAlways('Yeniden tarama başlatıldı.');
  await window.api.rescan();
});

btnSearchAreas?.addEventListener('click', () => openSettings('locations'));

// Theme Toggle Listener
actionThemeToggle?.addEventListener('click', () => {
  const next = activeTheme === 'dark' ? 'light' : 'dark';
  applyTheme(next, true);
  announceAlways(next === 'dark' ? 'Koyu tema etkin.' : 'Açık tema etkin.');
});

// Update Banner Buttons
btnViewUpdate?.addEventListener('click', () => {
  if (currentUpdateUrl) {
    window.api.openExternal(currentUpdateUrl);
  }
});

btnDismissUpdate?.addEventListener('click', hideUpdateBanner);

// Footer actions open the shared Settings window at the matching section.
actionShortcut?.addEventListener('click', () => openSettings('general'));
actionSearchAreas?.addEventListener('click', () => openSettings('locations'));
actionAbout?.addEventListener('click', () => openSettings('about'));

// Accessibility preferences are edited in the Settings window; this window
// shares its storage and follows a change live.
window.addEventListener('storage', (event) => {
  if (event.key === A11Y_PREFS_STORAGE_KEY) applyA11yPrefs(loadA11yPrefs());
});

// Brought back from the background or the taskbar: put the caret on the
// primary control and say so, otherwise a screen reader user has no signal
// that the window is now in front (spec §16).
window.api?.onWindowRestored?.(() => {
  const dialogOpen = !onboardingOverlay.classList.contains('hidden');
  // A dialog owns focus while it is open; stealing it back to the search
  // field would drop the user out of the dialog they were in.
  if (!dialogOpen) {
    searchInput.focus();
  }
  announceAlways('MetinBul açıldı. Belgelerde ara alanı seçili.');
});

// Menu theme changed listener
window.api?.onThemeChanged?.((theme: AppTheme) => {
  applyTheme(theme, false);
});

// Background update available listener
window.api?.onUpdateAvailable?.((info: UpdateCheckInfo) => {
  showUpdateBanner(info);
});

// Progress event listener from main process
// Indexing can emit hundreds of progress events. Only the transitions are
// announced -- a per-tick live region would make the app unusable under
// NVDA/JAWS, which would read every count (spec §10).
let lastAnnouncedIndexPhase = '';

window.api.onProgress(async (progress: IndexProgressData) => {
  // Automatic updates (every ten minutes) refresh the status line only: no
  // announcements unless they fail, and the result list is left alone rather
  // than re-searched under the user's cursor.
  const automatic = progress.trigger === 'auto';
  if (progress.status === 'scanning') {
    statusText.textContent = 'Belgeleriniz taranıyor…';
    footerText.textContent = 'Taranıyor…';
    if (!automatic && lastAnnouncedIndexPhase !== 'scanning') {
      lastAnnouncedIndexPhase = 'scanning';
      announce('Belgeleriniz taranıyor.');
    }
  } else if (progress.status === 'indexing') {
    const formattedTotal = formatCount(progress.total);
    const formattedCurrent = formatCount(progress.current);
    statusText.textContent = `İndeksleniyor… (${formattedCurrent}/${formattedTotal})`;
    statusText.setAttribute('aria-label', getAccessibleIndexingStatus(progress.current, progress.total));
    footerText.textContent = `İndeksleniyor… ${formattedTotal} belge`;
    if (!automatic && lastAnnouncedIndexPhase !== 'indexing') {
      lastAnnouncedIndexPhase = 'indexing';
      announce('İndeksleme başladı.');
    }
  } else if (progress.status === 'completed') {
    lastAnnouncedIndexPhase = '';
    await updateStatusFromDb();
    if (!automatic) {
      announce(getAccessibleDocumentCount(await window.api.getDocumentCount().catch(() => 0)));
    }
    if (typeof progress.skippedDataless === 'number') {
      updateDatalessHint(progress.skippedDataless);
    }
    // Refresh current search results if search query is active
    if (!automatic && searchInput.value.trim()) {
      performSearch(searchInput.value);
    }
  } else if (progress.status === 'error') {
    lastAnnouncedIndexPhase = '';
    showTemporaryStatus(ERROR_MESSAGES.indexingFailed);
    announceAlways(ERROR_MESSAGES.indexingFailed, automatic ? 'polite' : 'assertive');
  }
});

// Surfaces a failed global-shortcut registration without a modal: the
// footer entry point to the setting carries the warning, and the reason is
// on its tooltip (it is also logged by the main process).
async function markShortcutStateInFooter() {
  if (!actionShortcut) return;
  try {
    const { registered, display, accelerator, error } = await window.api.getQuickSearchShortcut();
    if (registered) {
      actionShortcut.classList.remove('footer-action-warning');
      actionShortcut.textContent = 'Ayarlar';
      actionShortcut.title = `Hızlı Arama: ${display || accelerator}`;
    } else {
      actionShortcut.classList.add('footer-action-warning');
      actionShortcut.textContent = '⚠ Ayarlar';
      actionShortcut.title = error || 'Hızlı Arama kısayolu kaydedilemedi.';
    }
  } catch {
    // Non-critical indicator; the popover still reports the real state.
  }
}

// Initial load
(async function init() {
  applyA11yPrefs(loadA11yPrefs());
  await initTheme();
  await markShortcutStateInFooter();
  const showingOnboarding = await initOnboardingIfNeeded();
  if (!showingOnboarding) {
    await updateStatusFromDb();
  }
  try {
    const count = await window.api.getLastSkippedDataless?.();
    if (typeof count === 'number') updateDatalessHint(count);
  } catch {
    // Non-critical hint; ignore failures
  }
})();
