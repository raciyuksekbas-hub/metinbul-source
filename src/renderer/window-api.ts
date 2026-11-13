// Shared `window.api` typing for both renderer bundles (main window and
// Quick Search window) -- kept in one place so their `declare global`
// augmentations merge instead of conflicting.

export interface SearchResultItem {
  id: number;
  filename: string;
  path: string;
  extension: string;
  mtime: number;
  snippet: string;
  snippets: string[];
  matchCount: number;
  index_status: string;
}

export type SearchSortMode = 'modified' | 'oldest' | 'relevance';

// Mirrors SearchOutcome in src/search/search-outcome.ts: what happened to a
// search, kept apart so a failure is never shown as "no results".
export type SearchState = 'success' | 'no_matches' | 'query_too_short' | 'index_not_ready' | 'search_error' | 'superseded';

export interface SearchOutcome {
  state: SearchState;
  results: SearchResultItem[];
  error?: string;
}

export interface IndexProgressData {
  total: number;
  current: number;
  currentFile?: string;
  status: 'scanning' | 'indexing' | 'completed' | 'error';
  message?: string;
  skippedDataless?: number;
  /** 'auto' for the automatic update timer; such passes stay quiet. */
  trigger?: 'user' | 'auto';
}

export interface UpdateCheckInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  status: 'update_available' | 'up_to_date' | 'unreachable' | 'error';
  message?: string;
}

export interface SearchAreaItem {
  path: string;
  type: 'include' | 'exclude';
  added_at: number;
}

export type AppTheme = 'dark' | 'light';

export interface StartupSettings {
  startAtLogin: boolean;
  startAtLoginSupported: boolean;
  startAtLoginStatus?: string;
  keepRunningInBackground: boolean;
  backgroundSupported: boolean;
  /** "Ekran paylaşımında gizle". */
  contentProtection: boolean;
}

export interface StartupSettingsResult {
  success: boolean;
  error?: string;
  settings: StartupSettings;
}


export type SettingsSection = 'general' | 'locations' | 'index' | 'about' | 'onboarding';

export interface IndexStatus {
  indexed: number;
  failed: number;
  noText: number;
  dataless: number;
  /** ms since epoch; 0 when MetinBul has never finished an index pass. */
  lastIndexedAt: number;
  isIndexing: boolean;
  progress: IndexProgressData | null;
  scopeMode: 'all' | 'selected';
  hasIncludedFolders: boolean;
  onboardingPending: boolean;
  lastSearchError: { at: number; message: string } | null;
  /** "Belgeleri otomatik güncelle"; on unless the user turned it off. */
  autoIndexEnabled: boolean;
  autoIndexIntervalMinutes: number;
  /** ms since epoch of the next automatic update; null when none is armed. */
  nextAutoIndexAt: number | null;
  /** Text recognition for scanned PDFs: the system offers Turkish. */
  ocrAvailable: boolean;
  /** Windows has text recognition but not its Turkish component yet. */
  ocrNeedsTurkishComponent: boolean;
  /** Windows: the computer's security policy keeps PowerShell from running it. */
  ocrRestricted: boolean;
  ocrSystemName: 'macOS' | 'Windows';
  /** "Taranmış PDF'lerde metin tanıma"; on unless the user turned it off. */
  ocrEnabled: boolean;
  /** How long one update may spend on text recognition. */
  ocrBudgetMinutes: number;
  /** Scanned PDFs whose content came from text recognition. */
  ocrRecognized: number;
  /** Scanned PDFs still waiting for it. */
  ocrPending: number;
  /** Whether the index file is encrypted, and why not when it is not. */
  indexEncrypted: boolean;
  indexEncryptionProblem: string | null;
}

export interface UnreadableDocumentItem {
  path: string;
  filename: string;
  status: 'failed' | 'no_text';
}

export interface MetinBulRendererApi {
  getDocumentCount: () => Promise<number>;
  rescan: () => Promise<boolean>;
  search: (query: string, sort?: SearchSortMode) => Promise<SearchOutcome>;
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  showInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  onProgress: (callback: (progress: IndexProgressData) => void) => () => void;
  getAboutInfo: () => Promise<any>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  sendFeedback: () => Promise<{ success: boolean; error?: string }>;
  copyToClipboard: (text: string) => Promise<{ success: boolean }>;
  getTheme: () => Promise<AppTheme>;
  setTheme: (theme: AppTheme) => Promise<boolean>;
  adoptLegacyTheme: (theme: string | null) => Promise<AppTheme>;
  onThemeChanged?: (callback: (theme: AppTheme) => void) => () => void;
  checkForUpdates: () => Promise<UpdateCheckInfo>;
  getUpdateInfo: () => Promise<UpdateCheckInfo | null>;
  onUpdateAvailable?: (callback: (info: UpdateCheckInfo) => void) => () => void;
  getSearchScopeMode: () => Promise<'all' | 'selected'>;
  setSearchScopeMode: (mode: 'all' | 'selected') => Promise<boolean>;
  getSearchAreas: () => Promise<SearchAreaItem[]>;
  addSearchArea: (path: string, type: 'include' | 'exclude') => Promise<boolean>;
  removeSearchArea: (path: string) => Promise<boolean>;
  selectFolder: (purpose?: 'include' | 'exclude') => Promise<string | null>;
  rebuildIndex: () => Promise<boolean>;
  shouldShowOnboarding: () => Promise<boolean>;
  completeOnboarding: (mode: 'all' | 'selected', folders?: string[], options?: { startAtLogin?: boolean }) => Promise<boolean>;
  getLastSkippedDataless: () => Promise<number>;
  getIndexStatus: () => Promise<IndexStatus>;
  getUnreadableDocuments: () => Promise<UnreadableDocumentItem[]>;
  getQuickSearchShortcut: () => Promise<{ accelerator: string; display: string; registered: boolean; error?: string }>;
  getStartupSettings: () => Promise<StartupSettings>;
  setStartAtLogin: (enabled: boolean) => Promise<StartupSettingsResult>;
  setKeepRunningInBackground: (enabled: boolean) => Promise<StartupSettingsResult>;
  setContentProtection: (enabled: boolean) => Promise<StartupSettingsResult>;
  setAutoIndexEnabled: (enabled: boolean) => Promise<IndexStatus>;
  setOcrEnabled: (enabled: boolean) => Promise<IndexStatus>;
  installWindowsTurkishOcr: () => Promise<{ success: boolean; status: IndexStatus }>;
  setQuickSearchShortcut: (accelerator: string) => Promise<{ success: boolean; error?: string }>;
  onShortcutChanged?: (callback: () => void) => () => void;
  openSettings: (section?: SettingsSection) => Promise<boolean>;
  onSettingsNavigate?: (callback: (target: { section: SettingsSection; checkUpdates: boolean }) => void) => () => void;
  hideQuickSearch: (reason?: 'dismiss' | 'open') => Promise<boolean>;
  setQuickSearchHeight: (contentHeight: number, allowShrink: boolean) => Promise<boolean>;
  showResultContextMenu: (filePath: string) => Promise<boolean>;
  onQuickSearchShown?: (callback: (info: { maxHeight: number }) => void) => () => void;
  onQuickSearchReset?: (callback: () => void) => () => void;
  onQuickSearchResultAction?: (callback: (request: { action: 'open' | 'reveal'; path: string }) => void) => () => void;
  onWindowRestored?: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    api: MetinBulRendererApi;
  }
}
