import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface SearchAreaItem {
  path: string;
  type: 'include' | 'exclude';
  added_at: number;
}

export interface StartupSettings {
  startAtLogin: boolean;
  startAtLoginSupported: boolean;
  startAtLoginStatus?: string;
  keepRunningInBackground: boolean;
  backgroundSupported: boolean;
}

export interface StartupSettingsResult {
  success: boolean;
  error?: string;
  settings: StartupSettings;
}

export type SettingsSection = 'general' | 'locations' | 'index' | 'about' | 'onboarding';

export interface MetinBulApi {
  getDocumentCount: () => Promise<number>;
  rescan: () => Promise<boolean>;
  search: (query: string, sort?: 'modified' | 'oldest' | 'relevance') => Promise<any>;
  openFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  showInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  onProgress: (callback: (progress: any) => void) => () => void;
  getAboutInfo: () => Promise<any>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  sendFeedback: () => Promise<{ success: boolean; error?: string }>;
  copyToClipboard: (text: string) => Promise<{ success: boolean }>;
  getTheme: () => Promise<'dark' | 'light'>;
  setTheme: (theme: 'dark' | 'light') => Promise<boolean>;
  adoptLegacyTheme: (theme: string | null) => Promise<'dark' | 'light'>;
  onThemeChanged: (callback: (theme: 'dark' | 'light') => void) => () => void;
  checkForUpdates: () => Promise<any>;
  getUpdateInfo: () => Promise<any>;
  onUpdateAvailable: (callback: (info: any) => void) => () => void;
  getSearchScopeMode: () => Promise<'all' | 'selected'>;
  setSearchScopeMode: (mode: 'all' | 'selected') => Promise<boolean>;
  getSearchAreas: () => Promise<SearchAreaItem[]>;
  addSearchArea: (path: string, type: 'include' | 'exclude') => Promise<boolean>;
  removeSearchArea: (path: string) => Promise<boolean>;
  selectFolder: () => Promise<string | null>;
  shouldShowOnboarding: () => Promise<boolean>;
  completeOnboarding: (mode: 'all' | 'selected', folders?: string[], options?: { startAtLogin?: boolean }) => Promise<boolean>;
  getLastSkippedDataless: () => Promise<number>;
  getIndexStatus: () => Promise<any>;
  getUnreadableDocuments: () => Promise<any[]>;
  getQuickSearchShortcut: () => Promise<{ accelerator: string; display: string; registered: boolean; error?: string }>;
  getStartupSettings: () => Promise<StartupSettings>;
  setStartAtLogin: (enabled: boolean) => Promise<StartupSettingsResult>;
  setKeepRunningInBackground: (enabled: boolean) => Promise<StartupSettingsResult>;
  setAutoIndexEnabled: (enabled: boolean) => Promise<any>;
  setOcrEnabled: (enabled: boolean) => Promise<any>;
  installWindowsTurkishOcr: () => Promise<any>;
  setQuickSearchShortcut: (accelerator: string) => Promise<{ success: boolean; error?: string }>;
  onShortcutChanged: (callback: () => void) => () => void;
  openSettings: (section?: SettingsSection) => Promise<boolean>;
  onSettingsNavigate: (callback: (target: { section: SettingsSection; checkUpdates: boolean }) => void) => () => void;
  hideQuickSearch: (reason?: 'dismiss' | 'open') => Promise<boolean>;
  setQuickSearchHeight: (contentHeight: number, allowShrink: boolean) => Promise<boolean>;
  showResultContextMenu: (filePath: string) => Promise<boolean>;
  onQuickSearchShown: (callback: (info: { maxHeight: number }) => void) => () => void;
  onQuickSearchReset: (callback: () => void) => () => void;
  onQuickSearchResultAction: (callback: (request: { action: 'open' | 'reveal'; path: string }) => void) => () => void;
  onWindowRestored: (callback: () => void) => () => void;
}

// One subscription helper for every main → renderer event, each returning
// its own unsubscribe function.
function subscribe<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: MetinBulApi = {
  getDocumentCount: () => ipcRenderer.invoke('app:getDocumentCount'),
  rescan: () => ipcRenderer.invoke('app:rescan'),
  search: (query: string, sort?: 'modified' | 'oldest' | 'relevance') => ipcRenderer.invoke('app:search', query, sort),
  openFile: (filePath: string) => ipcRenderer.invoke('app:openFile', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('app:showInFolder', filePath),
  onProgress: (callback) => subscribe('index:progress', callback),
  getAboutInfo: () => ipcRenderer.invoke('app:getAboutInfo'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  sendFeedback: () => ipcRenderer.invoke('app:sendFeedback'),
  copyToClipboard: (text: string) => ipcRenderer.invoke('app:copyToClipboard', text),
  getTheme: () => ipcRenderer.invoke('app:getTheme'),
  setTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('app:setTheme', theme),
  adoptLegacyTheme: (theme: string | null) => ipcRenderer.invoke('app:adoptLegacyTheme', theme),
  onThemeChanged: (callback) => subscribe('app:themeChanged', callback),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  getUpdateInfo: () => ipcRenderer.invoke('app:getUpdateInfo'),
  onUpdateAvailable: (callback) => subscribe('app:updateAvailable', callback),
  getSearchScopeMode: () => ipcRenderer.invoke('app:getSearchScopeMode'),
  setSearchScopeMode: (mode: 'all' | 'selected') => ipcRenderer.invoke('app:setSearchScopeMode', mode),
  getSearchAreas: () => ipcRenderer.invoke('app:getSearchAreas'),
  addSearchArea: (folderPath: string, type: 'include' | 'exclude') => ipcRenderer.invoke('app:addSearchArea', folderPath, type),
  removeSearchArea: (folderPath: string) => ipcRenderer.invoke('app:removeSearchArea', folderPath),
  selectFolder: () => ipcRenderer.invoke('app:selectFolder'),
  shouldShowOnboarding: () => ipcRenderer.invoke('app:shouldShowOnboarding'),
  completeOnboarding: (mode, folders, options) => ipcRenderer.invoke('app:completeOnboarding', mode, folders, options),
  getLastSkippedDataless: () => ipcRenderer.invoke('app:getLastSkippedDataless'),
  getIndexStatus: () => ipcRenderer.invoke('app:getIndexStatus'),
  getUnreadableDocuments: () => ipcRenderer.invoke('app:getUnreadableDocuments'),
  getQuickSearchShortcut: () => ipcRenderer.invoke('app:getQuickSearchShortcut'),
  getStartupSettings: () => ipcRenderer.invoke('app:getStartupSettings'),
  setStartAtLogin: (enabled: boolean) => ipcRenderer.invoke('app:setStartAtLogin', enabled),
  setKeepRunningInBackground: (enabled: boolean) => ipcRenderer.invoke('app:setKeepRunningInBackground', enabled),
  setAutoIndexEnabled: (enabled: boolean) => ipcRenderer.invoke('app:setAutoIndexEnabled', enabled),
  setOcrEnabled: (enabled: boolean) => ipcRenderer.invoke('app:setOcrEnabled', enabled),
  installWindowsTurkishOcr: () => ipcRenderer.invoke('app:installWindowsTurkishOcr'),
  setQuickSearchShortcut: (accelerator: string) => ipcRenderer.invoke('app:setQuickSearchShortcut', accelerator),
  onShortcutChanged: (callback) => subscribe('app:shortcutChanged', callback),
  openSettings: (section) => ipcRenderer.invoke('app:openSettings', section),
  onSettingsNavigate: (callback) => subscribe('settings:navigate', callback),
  hideQuickSearch: (reason) => ipcRenderer.invoke('app:hideQuickSearch', reason),
  setQuickSearchHeight: (contentHeight, allowShrink) => ipcRenderer.invoke('quick-search:setHeight', contentHeight, allowShrink),
  showResultContextMenu: (filePath) => ipcRenderer.invoke('quick-search:showResultMenu', filePath),
  onQuickSearchShown: (callback) => subscribe('quick-search:shown', callback),
  onQuickSearchReset: (callback) => subscribe('quick-search:reset', callback),
  onQuickSearchResultAction: (callback) => subscribe('quick-search:resultAction', callback),
  onWindowRestored: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:windowRestored', listener);
    return () => {
      ipcRenderer.removeListener('app:windowRestored', listener);
    };
  }
};

contextBridge.exposeInMainWorld('api', api);
