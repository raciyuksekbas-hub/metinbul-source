// MetinBul Quick Search -- the panel the global shortcut brings up, and on
// macOS the app's primary surface: ⌥ Space → type → find.
//
// It reuses the existing app:search / app:openFile IPC (same scope, same
// results as anywhere else) and the shared result-row renderer. No query is
// ever persisted: nothing here writes to localStorage or app settings.
import { createResultRowElement } from './result-card.js';
import { announce, announceAlways, resetAnnouncer } from './announcer.js';
import { loadA11yPrefs, applyA11yPrefs, A11Y_PREFS_STORAGE_KEY } from './a11y-prefs.js';
import {
  getAccessibleSearchStatus,
  getAccessibleIndexingStatus,
  SEARCH_STATUS_SEARCHING,
  SEARCH_STATUS_NO_RESULTS,
  ERROR_MESSAGES,
  formatCount
} from '../shared/a11y-text.js';
import {
  describeCoverage,
  isCoveragePartial,
  isQueryTooShort,
  INDEX_UPDATING_NOTE,
  QUERY_TOO_SHORT_MESSAGE
} from '../shared/quick-search-model.js';
import { THEME_STORAGE_KEY } from '../shared/theme.js';
import type { SearchResultItem, AppTheme, SearchSortMode, SettingsSection, UpdateCheckInfo, IndexStatus, SearchOutcome } from './window-api.js';

const IS_MAC = /Mac/i.test(navigator.userAgent);

const panel = document.getElementById('qs-panel') as HTMLDivElement;
const qsInput = document.getElementById('qs-input') as HTMLInputElement;
const inputHint = document.getElementById('qs-input-hint') as HTMLSpanElement;
const busyIndicator = document.getElementById('qs-busy') as HTMLSpanElement;
const settingsButton = document.getElementById('qs-settings') as HTMLButtonElement;
const updateDot = document.getElementById('qs-update-dot') as HTMLSpanElement;
const body = document.getElementById('qs-body') as HTMLDivElement;
const meta = document.getElementById('qs-meta') as HTMLDivElement;
const countLabel = document.getElementById('qs-count') as HTMLSpanElement;
const coverageLine = document.getElementById('qs-coverage') as HTMLParagraphElement;
const sortSelect = document.getElementById('qs-sort') as HTMLSelectElement;
const listbox = document.getElementById('qs-listbox') as HTMLDivElement;
const message = document.getElementById('qs-message') as HTMLDivElement;
const messagePrimary = document.getElementById('qs-message-primary') as HTMLParagraphElement;
const messageSecondary = document.getElementById('qs-message-secondary') as HTMLParagraphElement;
const messageAction = document.getElementById('qs-message-action') as HTMLButtonElement;
const footer = document.getElementById('qs-footer') as HTMLDivElement;

const REVEAL_LABEL = IS_MAC ? 'Finder’da göster' : 'Klasörde göster';

inputHint.textContent = IS_MAC
  ? 'Aramak istediğiniz ifadeyi yazın. Sonuçlar arasında yukarı ve aşağı ok tuşlarıyla gezinin. '
    + 'Enter belgeyi açar, Command ile Enter Finder’da gösterir, Escape paneli kapatır.'
  : 'Aramak istediğiniz ifadeyi yazın. Sonuçlar arasında yukarı ve aşağı ok tuşlarıyla gezinin. '
    + 'Enter belgeyi açar, Control ile Enter klasörde gösterir, Escape paneli kapatır.';
footer.textContent = IS_MAC
  ? `↩ Aç   ⌘↩ ${REVEAL_LABEL}   esc Kapat`
  : `Enter Aç   Ctrl+Enter ${REVEAL_LABEL}   Esc Kapat`;
settingsButton.title = IS_MAC ? 'Ayarlar (⌘,)' : 'Ayarlar (Ctrl+,)';

let results: SearchResultItem[] = [];
let selectedIndex = -1;
let currentSort: SearchSortMode = 'modified';
let searchToken = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let busyTimer: ReturnType<typeof setTimeout> | null = null;
let messageActionHandler: (() => void) | null = null;

// --- Theme & accessibility preferences --------------------------------------

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

async function initTheme() {
  try {
    // The main process owns the theme; a value only this browser profile
    // knows about (older versions kept it here) is handed over once.
    applyTheme(await window.api.adoptLegacyTheme(readLegacyTheme()));
  } catch {
    // Keep the markup default (dark).
  }
}

window.api?.onThemeChanged?.((theme: AppTheme) => applyTheme(theme));

// Text size, contrast and motion preferences are chosen in Settings; both
// windows share this origin's storage, so the panel follows a change live.
applyA11yPrefs(loadA11yPrefs());
window.addEventListener('storage', (event) => {
  if (event.key === A11Y_PREFS_STORAGE_KEY) {
    applyA11yPrefs(loadA11yPrefs());
    syncHeight(true);
  }
});

// --- Panel height -------------------------------------------------------------

let heightQueued = false;
let pendingShrink = false;
// The tallest the panel may get on the current display, in CSS pixels; sent
// by the main process each time the panel is shown.
let maxPanelHeight = 480;

function textZoom(): number {
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

// The panel keeps its natural height and only the result list scrolls: the
// list gets whatever is left of the display's budget after the field, the
// count line and the hints. The resulting height is reported to the main
// process, which sizes the window to it. Selection changes pass
// allowShrink=false so the window never bounces as the arrow keys move
// through rows of different heights.
//
// Measured synchronously (layout reads are) and batched per task with a
// microtask rather than requestAnimationFrame: a panel's page can believe it
// is hidden, and then animation frames simply never arrive.
function syncHeight(allowShrink: boolean) {
  pendingShrink = pendingShrink || allowShrink;
  if (heightQueued) return;
  heightQueued = true;
  queueMicrotask(() => {
    heightQueued = false;
    const shrink = pendingShrink;
    pendingShrink = false;
    if (!listbox.hidden) {
      const chrome = panel.getBoundingClientRect().height - listbox.getBoundingClientRect().height;
      const available = Math.max(96, maxPanelHeight - chrome);
      // Inline lengths are in unzoomed CSS pixels; measurements are zoomed.
      listbox.style.maxHeight = `${Math.floor(available / textZoom())}px`;
    }
    const height = panel.getBoundingClientRect().height;
    window.api.setQuickSearchHeight(Math.ceil(height), shrink).catch(() => {});
  });
}

// --- Rendering ----------------------------------------------------------------

function optionId(index: number): string {
  return `qs-option-${index}`;
}

// Collapsing the combobox clears aria-activedescendant too, otherwise it
// keeps pointing at a node that no longer exists and readers announce
// nothing on the next arrow press.
function setExpanded(expanded: boolean) {
  qsInput.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (!expanded) qsInput.removeAttribute('aria-activedescendant');
}

function setBusy(busy: boolean) {
  if (busyTimer) {
    clearTimeout(busyTimer);
    busyTimer = null;
  }
  if (!busy) {
    busyIndicator.hidden = true;
    return;
  }
  // Only a search that is actually slow gets an indicator; a fast one would
  // just make it flicker.
  busyTimer = setTimeout(() => {
    busyIndicator.hidden = false;
  }, 180);
}

function hideMessage() {
  message.hidden = true;
  message.classList.remove('qs-message-error');
  messageSecondary.hidden = true;
  messageAction.hidden = true;
  messageActionHandler = null;
}

interface MessageOptions {
  secondary?: string | null;
  action?: { label: string; run: () => void };
  error?: boolean;
  /** Keep the result list visible (an action on a result failed). */
  keepResults?: boolean;
}

function showMessage(primary: string, options: MessageOptions = {}) {
  body.hidden = false;
  if (!options.keepResults) {
    meta.hidden = true;
    coverageLine.hidden = true;
    listbox.hidden = true;
    listbox.replaceChildren();
    footer.hidden = true;
    setExpanded(false);
  }
  message.hidden = false;
  message.classList.toggle('qs-message-error', options.error === true);
  messagePrimary.textContent = primary;
  messageSecondary.hidden = !options.secondary;
  messageSecondary.textContent = options.secondary || '';
  if (options.action) {
    messageAction.hidden = false;
    messageAction.textContent = options.action.label;
    messageActionHandler = options.action.run;
  } else {
    messageAction.hidden = true;
    messageActionHandler = null;
  }
  syncHeight(true);
}

function renderIdle() {
  results = [];
  selectedIndex = -1;
  countLabel.textContent = '';
  coverageLine.hidden = true;
  body.hidden = true;
  meta.hidden = true;
  listbox.hidden = true;
  listbox.replaceChildren();
  footer.hidden = true;
  hideMessage();
  setExpanded(false);
  syncHeight(true);
}

function renderResults(query: string) {
  hideMessage();
  body.hidden = false;
  meta.hidden = false;
  listbox.hidden = false;
  footer.hidden = false;
  countLabel.textContent = `${formatCount(results.length)} sonuç`;
  listbox.setAttribute('aria-label', `Arama sonuçları, ${formatCount(results.length)} belge`);

  const rows = results.map((result, index) => createResultRowElement(result, {
    onOpen: () => {
      selectIndex(index);
      void openResult(result);
    },
    onShowInFolder: () => {
      selectIndex(index);
      void revealResult(result);
    },
    onContextMenu: (path) => {
      selectIndex(index);
      void window.api.showResultContextMenu(path);
    }
  }, {
    asOption: true,
    selected: index === selectedIndex,
    domId: optionId(index),
    index: index + 1,
    total: results.length,
    query
  }));
  listbox.replaceChildren(...rows);
  listbox.scrollTop = 0;

  setExpanded(true);
  if (selectedIndex >= 0) {
    qsInput.setAttribute('aria-activedescendant', optionId(selectedIndex));
  }
  syncHeight(true);
}

// "12 sonuç" alone overstates what was searched when part of the document set
// could not be read or the index is being updated, so that is said under the
// count. Fetched after the results are on screen: it never delays them.
async function showCoverageForResults(token: number) {
  let status: IndexStatus | null = null;
  try {
    status = await window.api.getIndexStatus();
  } catch {
    return;
  }
  if (token !== searchToken || listbox.hidden) return;
  const lines: string[] = [];
  if (status.isIndexing) lines.push(INDEX_UPDATING_NOTE);
  if (isCoveragePartial(status)) lines.push(describeCoverage(status));
  coverageLine.textContent = lines.join(' ');
  coverageLine.hidden = lines.length === 0;
  syncHeight(true);
}

function selectIndex(nextIndex: number) {
  if (nextIndex === selectedIndex || nextIndex < 0 || nextIndex >= results.length) return;
  const previous = listbox.children[selectedIndex] as HTMLElement | undefined;
  if (previous) previous.setAttribute('aria-selected', 'false');

  selectedIndex = nextIndex;
  const next = listbox.children[selectedIndex] as HTMLElement | undefined;
  if (next) {
    next.setAttribute('aria-selected', 'true');
    // Pointing aria-activedescendant at the option is what makes the reader
    // announce it; focus itself never leaves the text field.
    qsInput.setAttribute('aria-activedescendant', next.id);
    next.scrollIntoView({ block: 'nearest' });
  }
  syncHeight(false);
}

function moveSelection(delta: number) {
  if (results.length === 0) return;
  if (selectedIndex === -1) {
    selectIndex(delta > 0 ? 0 : results.length - 1);
    return;
  }
  if (Math.abs(delta) === 1) {
    // Single steps wrap around, as before; page jumps stop at the ends.
    selectIndex((selectedIndex + delta + results.length) % results.length);
  } else {
    selectIndex(Math.min(results.length - 1, Math.max(0, selectedIndex + delta)));
  }
}

// --- Empty and error states ---------------------------------------------------

function openSettings(section: SettingsSection) {
  void window.api.openSettings(section);
}

// Three different answers, never one: the phrase is not in a ready index
// (no_matches), there is nothing readable to search yet (index_not_ready),
// or the search itself failed (search_error, handled in runSearch). The first
// two are explained with the state of the index.
async function explainEmptyResult(token: number, state: 'no_matches' | 'index_not_ready') {
  let status: IndexStatus | null = null;
  try {
    status = await window.api.getIndexStatus();
  } catch {
    status = null;
  }
  if (token !== searchToken) return;

  if (status?.onboardingPending) {
    showMessage('Kurulum henüz tamamlanmadı.', {
      secondary: 'Nerede aranacağını seçtiğinizde belgeleriniz indekslenir.',
      action: { label: 'Kurulumu Aç', run: () => openSettings('onboarding') }
    });
    announceAlways('Kurulum henüz tamamlanmadı.');
    return;
  }

  if (status && status.scopeMode === 'selected' && !status.hasIncludedFolders) {
    showMessage('Arama için en az bir klasör seçin.', {
      action: { label: 'Arama Konumları', run: () => openSettings('locations') }
    });
    announceAlways('Arama için en az bir klasör seçin.');
    return;
  }

  if (state === 'index_not_ready' || (status && status.indexed === 0)) {
    // Not "no results": there was nothing readable to search in.
    const preparing = status?.isIndexing === true;
    const progress = preparing && status?.progress && status.progress.total > 0
      ? getAccessibleIndexingStatus(status.progress.current, status.progress.total)
      : null;
    const primary = preparing ? 'Belgeler hazırlanıyor…' : 'Henüz belge indekslenmedi.';
    showMessage(primary, {
      secondary: preparing ? progress : 'Belgeleri Güncelle ile indeksi oluşturabilirsiniz.',
      action: { label: 'İndeks', run: () => openSettings('index') }
    });
    announceAlways(preparing ? 'Belgeler hazırlanıyor.' : 'Henüz belge indekslenmedi.');
    return;
  }

  // A genuine "not found", stated with exactly what was searched.
  const visibleLines: string[] = [];
  const spokenParts: string[] = [SEARCH_STATUS_NO_RESULTS];
  if (status?.isIndexing) {
    visibleLines.push(INDEX_UPDATING_NOTE);
    spokenParts.push(INDEX_UPDATING_NOTE);
  }
  if (status) {
    visibleLines.push(describeCoverage(status));
    spokenParts.push(describeCoverage(status, { spoken: true }));
  }
  showMessage(SEARCH_STATUS_NO_RESULTS, {
    secondary: visibleLines.join(' ') || null,
    action: status && isCoveragePartial(status) ? { label: 'Ayrıntılar', run: () => openSettings('index') } : undefined
  });
  announceAlways(spokenParts.join(' '));
}

// --- Search -----------------------------------------------------------------------

async function runSearch(query: string) {
  if (!query.trim()) {
    searchToken++;
    setBusy(false);
    renderIdle();
    return;
  }

  if (isQueryTooShort(query)) {
    // Not searched at all, so not "nothing found" either.
    searchToken++;
    setBusy(false);
    results = [];
    selectedIndex = -1;
    showMessage(QUERY_TOO_SHORT_MESSAGE);
    announce(QUERY_TOO_SHORT_MESSAGE);
    return;
  }

  const token = ++searchToken;
  setBusy(true);
  announce(SEARCH_STATUS_SEARCHING);

  let outcome: SearchOutcome;
  try {
    outcome = await window.api.search(query, currentSort);
  } catch {
    // The IPC call itself failed (e.g. the main process is gone).
    outcome = { state: 'search_error', results: [] };
  }
  if (token !== searchToken) return;
  setBusy(false);
  results = outcome.results;
  selectedIndex = results.length > 0 ? 0 : -1;

  switch (outcome.state) {
    case 'success':
      renderResults(query);
      announceAlways(getAccessibleSearchStatus(results.length));
      void showCoverageForResults(token);
      return;
    case 'query_too_short':
      showMessage(QUERY_TOO_SHORT_MESSAGE);
      announce(QUERY_TOO_SHORT_MESSAGE);
      return;
    case 'no_matches':
    case 'index_not_ready':
      await explainEmptyResult(token, outcome.state);
      return;
    case 'search_error':
    default:
      // A failure is said as one -- never shown as an empty result list. The
      // technical reason is in Settings › İndeks and the log, not here.
      showMessage(ERROR_MESSAGES.searchFailed, {
        secondary: 'Arama motoru bir hata bildirdi.',
        action: { label: 'Ayrıntılar', run: () => openSettings('index') },
        error: true
      });
      announceAlways(ERROR_MESSAGES.searchFailed, 'assertive');
  }
}

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(qsInput.value), 120);
}

// --- Result actions -----------------------------------------------------------------

function showActionError(text: string) {
  showMessage(text, { error: true, keepResults: true });
  announceAlways(text, 'assertive');
}

async function openResult(result: SearchResultItem) {
  const response = await window.api.openFile(result.path);
  if (response.success) {
    await window.api.hideQuickSearch('open');
  } else {
    showActionError(response.error || ERROR_MESSAGES.fileMissing);
  }
}

async function revealResult(result: SearchResultItem) {
  const response = await window.api.showInFolder(result.path);
  if (response.success) {
    await window.api.hideQuickSearch('open');
  } else {
    showActionError(response.error || ERROR_MESSAGES.fileMissing);
  }
}

function selectedResult(): SearchResultItem | undefined {
  return selectedIndex >= 0 ? results[selectedIndex] : results[0];
}

// --- Events ------------------------------------------------------------------------

qsInput.addEventListener('input', scheduleSearch);

qsInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'PageDown') {
    e.preventDefault();
    moveSelection(5);
  } else if (e.key === 'PageUp') {
    e.preventDefault();
    moveSelection(-5);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = selectedResult();
    if (!target) return;
    const reveal = IS_MAC ? e.metaKey : e.ctrlKey;
    void (reveal ? revealResult(target) : openResult(target));
  }
});

// Panel-wide keys, wherever focus is (the field, the sort menu, a button).
window.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const command = IS_MAC ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    void window.api.hideQuickSearch('dismiss');
  } else if (command && (e.key === 'w' || e.key === 'W')) {
    // Cmd+W hides the panel; it never closes the app.
    e.preventDefault();
    void window.api.hideQuickSearch('dismiss');
  } else if (command && e.key === ',') {
    e.preventDefault();
    openSettings('general');
  }
}, true);

sortSelect.addEventListener('change', () => {
  currentSort = (sortSelect.value as SearchSortMode) || 'modified';
  announceAlways(`Sıralama: ${sortSelect.options[sortSelect.selectedIndex].text}.`);
  // Back to the field, so the arrow keys move through the re-sorted list.
  qsInput.focus();
  if (qsInput.value.trim()) void runSearch(qsInput.value);
});

settingsButton.addEventListener('click', () => openSettings('general'));
messageAction.addEventListener('click', () => messageActionHandler?.());

function showUpdateAvailable(info: UpdateCheckInfo | null) {
  if (!info || !info.updateAvailable) return;
  updateDot.hidden = false;
  settingsButton.setAttribute('aria-label', `Ayarlar. MetinBul ${info.latestVersion || ''} kullanılabilir.`.replace(/\s+/g, ' '));
}

window.api?.onUpdateAvailable?.((info) => showUpdateAvailable(info));

// The selected result's actions also come from the native context menu.
window.api?.onQuickSearchResultAction?.(({ action, path }) => {
  const result = results.find(r => r.path === path);
  if (!result) return;
  void (action === 'reveal' ? revealResult(result) : openResult(result));
});

// Hidden: start clean, so the next invocation shows the bare search field.
// The field also gives up focus: this page is never throttled (see main.ts),
// so a focused field would keep blinking its caret -- and repainting -- while
// MetinBul sits idle in the background. Measured: ~0.9% of a core, gone once
// nothing is focused.
window.api?.onQuickSearchReset?.(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  searchToken++;
  setBusy(false);
  qsInput.value = '';
  renderIdle();
  resetAnnouncer();
  qsInput.blur();
});

// Shown via the shortcut from another app: the caret goes straight into the
// field, and a screen reader is told where focus landed.
window.api?.onQuickSearchShown?.((info) => {
  if (info && Number.isFinite(info.maxHeight) && info.maxHeight > 0) {
    maxPanelHeight = info.maxHeight;
  }
  qsInput.focus();
  qsInput.select();
  panel.classList.remove('qs-panel-enter');
  // Restarting the animation needs a reflow between remove and add.
  void panel.offsetWidth;
  panel.classList.add('qs-panel-enter');
  announceAlways('MetinBul hızlı arama. Aramak istediğiniz ifadeyi yazın.');
});

initTheme();
window.api.getUpdateInfo?.().then(showUpdateAvailable).catch(() => {});
renderIdle();
// No focus here: the page loads hidden, and focus is taken when the panel
// is actually shown (onQuickSearchShown).
