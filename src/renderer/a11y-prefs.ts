// Accessibility preferences (spec §24). Entirely local: stored in
// localStorage, never sent anywhere (spec §38).
//
// Every preference defaults to "follow the system", so a user who has already
// configured macOS/Windows accessibility settings gets the right behaviour
// without opening MetinBul's settings at all. The explicit options exist for
// the case where the app should differ from the system.

export type TriState = 'system' | 'on' | 'off';
export type TextScale = 100 | 125 | 150 | 175 | 200;

export interface A11yPrefs {
  /** Master switch: when true, every other preference follows the OS. */
  useSystemSettings: boolean;
  textScale: TextScale;
  highContrast: TriState;
  reduceMotion: TriState;
  linearResults: boolean;
}

export const DEFAULT_A11Y_PREFS: A11yPrefs = {
  useSystemSettings: true,
  textScale: 100,
  highContrast: 'system',
  reduceMotion: 'system',
  linearResults: false
};

export const A11Y_PREFS_STORAGE_KEY = 'metinbul:a11y';

const VALID_SCALES: TextScale[] = [100, 125, 150, 175, 200];

export function isValidTextScale(value: unknown): value is TextScale {
  return VALID_SCALES.includes(value as TextScale);
}

export function isValidTriState(value: unknown): value is TriState {
  return value === 'system' || value === 'on' || value === 'off';
}

/** Coerces arbitrary stored JSON back into a valid preference object. */
export function normalizeA11yPrefs(raw: unknown): A11yPrefs {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<A11yPrefs>;
  return {
    useSystemSettings: input.useSystemSettings !== false,
    textScale: isValidTextScale(input.textScale) ? input.textScale : DEFAULT_A11Y_PREFS.textScale,
    highContrast: isValidTriState(input.highContrast) ? input.highContrast : DEFAULT_A11Y_PREFS.highContrast,
    reduceMotion: isValidTriState(input.reduceMotion) ? input.reduceMotion : DEFAULT_A11Y_PREFS.reduceMotion,
    linearResults: input.linearResults === true
  };
}

/**
 * Resolves the preference set into the concrete attributes the stylesheet
 * keys off. Kept pure so the mapping is unit-testable without a DOM.
 */
export interface ResolvedA11yState {
  textScalePercent: number;
  /** null means "leave it to the OS media query". */
  forceHighContrast: boolean | null;
  reduceMotion: boolean | null;
  linearResults: boolean;
}

export function resolveA11yPrefs(prefs: A11yPrefs): ResolvedA11yState {
  if (prefs.useSystemSettings) {
    return {
      textScalePercent: 100,
      forceHighContrast: null,
      reduceMotion: null,
      linearResults: prefs.linearResults
    };
  }
  return {
    textScalePercent: prefs.textScale,
    forceHighContrast: prefs.highContrast === 'system' ? null : prefs.highContrast === 'on',
    reduceMotion: prefs.reduceMotion === 'system' ? null : prefs.reduceMotion === 'on',
    linearResults: prefs.linearResults
  };
}

export function loadA11yPrefs(): A11yPrefs {
  try {
    const raw = localStorage.getItem(A11Y_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_A11Y_PREFS };
    return normalizeA11yPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_A11Y_PREFS };
  }
}

export function saveA11yPrefs(prefs: A11yPrefs): void {
  try {
    localStorage.setItem(A11Y_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable; the in-memory preference still applies.
  }
}

/** Writes the resolved state onto <html> for the stylesheet to consume. */
export function applyA11yPrefs(prefs: A11yPrefs): void {
  const state = resolveA11yPrefs(prefs);
  const root = document.documentElement;

  root.style.setProperty('--a11y-text-scale', String(state.textScalePercent / 100));

  if (state.forceHighContrast === null) root.removeAttribute('data-contrast');
  else root.setAttribute('data-contrast', state.forceHighContrast ? 'high' : 'normal');

  if (state.reduceMotion === null) root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', state.reduceMotion ? 'reduce' : 'full');

  if (state.linearResults) root.setAttribute('data-layout', 'linear');
  else root.removeAttribute('data-layout');
}
