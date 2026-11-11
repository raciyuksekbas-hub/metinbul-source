// Ayarlar › Genel: start-up behaviour, the Quick Search shortcut, theme and
// accessibility preferences. Moved here from the main window's "Ayarlar"
// popover; the behaviour of every control is unchanged.
import { escapeHtml } from '../result-card.js';
import { announceAlways } from '../announcer.js';
import {
  loadA11yPrefs, saveA11yPrefs, applyA11yPrefs,
  type A11yPrefs, type TextScale, type TriState
} from '../a11y-prefs.js';
import type { AppTheme } from '../window-api.js';

export interface GeneralViewOptions {
  /** The "linear results" preference only affects the Windows main window. */
  showLinearResultsOption: boolean;
}

// Maps a browser KeyboardEvent to an Electron accelerator key token. Returns
// null while only modifier keys are held (waiting for the actual key).
export function keyEventToAcceleratorToken(e: KeyboardEvent): string | null {
  const key = e.key;
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null;
  if (key === ' ') return 'Space';
  const named: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Escape', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
  };
  if (named[key]) return named[key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (/^[0-9]$/.test(key)) return key;
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  return null;
}

let captureCleanup: (() => void) | null = null;

export async function renderGeneralView(container: HTMLElement, options: GeneralViewOptions): Promise<void> {
  captureCleanup?.();
  captureCleanup = null;

  const [shortcut, startup, theme] = await Promise.all([
    window.api.getQuickSearchShortcut(),
    window.api.getStartupSettings(),
    window.api.getTheme()
  ]);
  const a11y = loadA11yPrefs();

  // A shortcut that could not be registered is shown as a warning with the
  // reason, never quietly rendered as if it worked.
  const shortcutWarning = shortcut.registered
    ? ''
    : `<p class="settings-warning">⚠ ${escapeHtml(shortcut.error || 'Bu kısayol şu anda etkin değil.')}</p>`;

  // macOS can register the login item and still be waiting for the user to
  // allow it; the setting would then look on while nothing starts at login.
  const approvalHint = startup.startAtLogin && startup.startAtLoginStatus === 'requires-approval'
    ? '<p class="settings-warning">⚠ macOS bu başlangıç öğesini henüz onaylamadı. Sistem Ayarları › Genel › Giriş Öğeleri bölümünden MetinBul’a izin verin.</p>'
    : '';

  const quitWhere = /Windows/i.test(navigator.userAgent) ? ' (bildirim alanındaki MetinBul simgesine sağ tıklayın)' : '';

  const startupRows: string[] = [];
  if (startup.startAtLoginSupported) {
    startupRows.push(`
      <div class="settings-row">
        <label class="checkbox-label">
          <input type="checkbox" id="chk-start-at-login" ${startup.startAtLogin ? 'checked' : ''}>
          <span>Bilgisayar açıldığında MetinBul’u başlat</span>
        </label>
      </div>`);
  }
  if (startup.backgroundSupported) {
    startupRows.push(`
      <div class="settings-row">
        <label class="checkbox-label">
          <input type="checkbox" id="chk-keep-background" ${startup.keepRunningInBackground ? 'checked' : ''}>
          <span>Pencere kapandığında arka planda açık tut</span>
        </label>
      </div>`);
  }

  const startupGroup = startupRows.length === 0 ? '' : `
    <section class="settings-group" aria-labelledby="general-startup-title">
      <h2 class="settings-group-title" id="general-startup-title">Başlangıç</h2>
      <div class="settings-card">${startupRows.join('')}</div>
      <p class="settings-note">
        Arka planda açık kalan MetinBul arama kısayoluna hazır bekler; otomatik güncelleme açıksa
        belgelerinizi de güncel tutar. Tamamen kapatmak için “MetinBul’dan Çık” komutunu kullanın${quitWhere}.
      </p>
      ${approvalHint}
      <p id="startup-status" class="settings-status" hidden></p>
    </section>`;

  const scaleOptions = ([100, 125, 150, 175, 200] as TextScale[])
    .map(v => `<option value="${v}" ${a11y.textScale === v ? 'selected' : ''}>%${v}</option>`)
    .join('');
  const triOptions = (current: TriState) => ([
    ['system', 'Sistem'], ['on', 'Açık'], ['off', 'Kapalı']
  ] as [TriState, string][])
    .map(([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  // Disabled rather than hidden while "use system settings" is on: a control
  // that vanishes from the tree is harder to understand than one that
  // reports itself as unavailable.
  const a11yDisabled = a11y.useSystemSettings ? 'disabled' : '';

  container.innerHTML = `
    ${startupGroup}

    <section class="settings-group" aria-labelledby="general-shortcut-title">
      <h2 class="settings-group-title" id="general-shortcut-title">Hızlı Arama</h2>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label" id="shortcut-row-label">Kısayol</span>
          <span class="settings-row-end">
            <kbd class="settings-kbd" id="shortcut-current" aria-labelledby="shortcut-row-label shortcut-current">${escapeHtml(shortcut.display || shortcut.accelerator)}</kbd>
            <button id="btn-shortcut-record" class="btn-secondary-sm" type="button">Değiştir</button>
          </span>
        </div>
      </div>
      <p class="settings-note">Hangi uygulamada olursanız olun, bu kısayol MetinBul’un arama alanını açar.</p>
      ${shortcutWarning}
      <p id="shortcut-status" class="settings-status" hidden></p>
    </section>

    <section class="settings-group" aria-labelledby="general-appearance-title">
      <h2 class="settings-group-title" id="general-appearance-title">Görünüm</h2>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label" id="theme-row-label">Tema</span>
          <span class="segmented" role="radiogroup" aria-labelledby="theme-row-label">
            <label class="segmented-option">
              <input type="radio" name="theme" value="light" ${theme === 'light' ? 'checked' : ''}>
              <span>Açık</span>
            </label>
            <label class="segmented-option">
              <input type="radio" name="theme" value="dark" ${theme === 'dark' ? 'checked' : ''}>
              <span>Koyu</span>
            </label>
          </span>
        </div>
      </div>
    </section>

    <section class="settings-group" aria-labelledby="a11y-section-title">
      <h2 class="settings-group-title" id="a11y-section-title">Erişilebilirlik</h2>
      <div class="settings-card" role="group" aria-labelledby="a11y-section-title">
        <div class="settings-row">
          <label class="checkbox-label">
            <input type="checkbox" id="chk-a11y-system" ${a11y.useSystemSettings ? 'checked' : ''}>
            <span>Sistem ayarlarını kullan</span>
          </label>
        </div>
        <div class="settings-row settings-field">
          <label for="sel-a11y-scale">Metin boyutu</label>
          <select id="sel-a11y-scale" class="settings-select" ${a11yDisabled}>${scaleOptions}</select>
        </div>
        <div class="settings-row settings-field">
          <label for="sel-a11y-contrast">Yüksek kontrast</label>
          <select id="sel-a11y-contrast" class="settings-select" ${a11yDisabled}>${triOptions(a11y.highContrast)}</select>
        </div>
        <div class="settings-row settings-field">
          <label for="sel-a11y-motion">Hareketi azalt</label>
          <select id="sel-a11y-motion" class="settings-select" ${a11yDisabled}>${triOptions(a11y.reduceMotion)}</select>
        </div>
        ${options.showLinearResultsOption ? `
        <div class="settings-row">
          <label class="checkbox-label">
            <input type="checkbox" id="chk-a11y-linear" ${a11y.linearResults ? 'checked' : ''}>
            <span>Doğrusal sonuç görünümü</span>
          </label>
        </div>` : ''}
      </div>
      <p class="settings-note">Bu tercihler yalnızca bu bilgisayarda saklanır ve hiçbir yere gönderilmez.</p>
    </section>
  `;

  const rerender = async (focusSelector?: string) => {
    await renderGeneralView(container, options);
    if (focusSelector) (container.querySelector(focusSelector) as HTMLElement | null)?.focus();
  };

  function reportStatus(id: string, text: string) {
    const status = container.querySelector(`#${id}`) as HTMLElement | null;
    if (status) {
      status.textContent = text;
      status.hidden = false;
    }
    announceAlways(text);
  }

  // --- Start-up -------------------------------------------------------------
  // Both toggles re-render from the state the main process reports back
  // rather than trusting the checkbox: the OS can refuse a login item, and
  // the user can change it outside MetinBul.
  const chkStartAtLogin = container.querySelector('#chk-start-at-login') as HTMLInputElement | null;
  if (chkStartAtLogin) {
    chkStartAtLogin.onchange = async () => {
      const wanted = chkStartAtLogin.checked;
      chkStartAtLogin.disabled = true;
      const result = await window.api.setStartAtLogin(wanted);
      await rerender('#chk-start-at-login');
      reportStatus('startup-status', result.success
        ? (wanted
          ? 'MetinBul bilgisayar açıldığında arka planda başlatılacak.'
          : 'Bilgisayar açıldığında otomatik başlatma kapatıldı.')
        : (result.error || 'Ayar değiştirilemedi.'));
    };
  }

  const chkKeepBackground = container.querySelector('#chk-keep-background') as HTMLInputElement | null;
  if (chkKeepBackground) {
    chkKeepBackground.onchange = async () => {
      const wanted = chkKeepBackground.checked;
      chkKeepBackground.disabled = true;
      const result = await window.api.setKeepRunningInBackground(wanted);
      await rerender('#chk-keep-background');
      reportStatus('startup-status', result.success
        ? (wanted
          ? 'Pencere kapatıldığında MetinBul arka planda açık kalacak.'
          : 'Pencere kapatıldığında MetinBul tamamen kapanacak.')
        : (result.error || 'Ayar değiştirilemedi.'));
    };
  }

  // --- Shortcut ---------------------------------------------------------------
  const btnRecord = container.querySelector('#btn-shortcut-record') as HTMLButtonElement;
  btnRecord.onclick = () => {
    btnRecord.textContent = 'Bir tuş kombinasyonuna basın… (Esc ile iptal)';
    btnRecord.disabled = true;
    // Key capture is global while recording, so the state is announced --
    // otherwise Tab appears to stop working with no reason given.
    announceAlways('Kısayol kaydediliyor. Bir tuş kombinasyonuna basın. İptal etmek için Escape tuşuna basın.');

    const captureHandler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        cleanup();
        await rerender('#btn-shortcut-record');
        announceAlways('Kısayol değiştirme iptal edildi.');
        return;
      }

      const keyToken = keyEventToAcceleratorToken(e);
      if (!keyToken) return; // still only modifiers held down

      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push('Control');
      if (e.metaKey) modifiers.push('Command');
      if (e.altKey) modifiers.push('Alt');
      if (e.shiftKey) modifiers.push('Shift');

      cleanup();

      if (modifiers.length === 0) {
        await rerender('#btn-shortcut-record');
        reportStatus('shortcut-status', 'En az bir değiştirici tuş (Ctrl/Cmd/Alt/Shift) gerekli.');
        return;
      }

      const accelerator = [...modifiers, keyToken].join('+');
      const result = await window.api.setQuickSearchShortcut(accelerator);
      await rerender('#btn-shortcut-record');
      if (result.success) {
        const current = await window.api.getQuickSearchShortcut();
        reportStatus('shortcut-status', `Hızlı Arama kısayolu: ${current.display || accelerator}.`);
      } else {
        reportStatus('shortcut-status', result.error || 'Kısayol ayarlanamadı.');
      }
    };

    function cleanup() {
      window.removeEventListener('keydown', captureHandler, true);
      captureCleanup = null;
    }

    captureCleanup = cleanup;
    window.addEventListener('keydown', captureHandler, true);
  };

  // --- Theme -------------------------------------------------------------------
  container.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(radio => {
    radio.onchange = async () => {
      const next = radio.value === 'light' ? 'light' : 'dark';
      await window.api.setTheme(next as AppTheme);
      announceAlways(next === 'dark' ? 'Koyu tema etkin.' : 'Açık tema etkin.');
    };
  });

  // --- Accessibility -------------------------------------------------------------
  function commit(patch: Partial<A11yPrefs>, spoken: string) {
    const next = { ...loadA11yPrefs(), ...patch };
    saveA11yPrefs(next);
    applyA11yPrefs(next);
    announceAlways(spoken);
  }

  const chkSystem = container.querySelector('#chk-a11y-system') as HTMLInputElement | null;
  if (chkSystem) {
    chkSystem.onchange = async () => {
      commit(
        { useSystemSettings: chkSystem.checked },
        chkSystem.checked
          ? 'Sistem erişilebilirlik ayarları kullanılıyor.'
          : 'Erişilebilirlik ayarları MetinBul içinden yönetiliyor.'
      );
      // Re-render so the dependent controls' disabled state matches.
      await rerender('#chk-a11y-system');
    };
  }
  const selScale = container.querySelector('#sel-a11y-scale') as HTMLSelectElement | null;
  if (selScale) {
    selScale.onchange = () => commit({ textScale: Number(selScale.value) as TextScale }, `Metin boyutu yüzde ${selScale.value}.`);
  }
  const selContrast = container.querySelector('#sel-a11y-contrast') as HTMLSelectElement | null;
  if (selContrast) {
    selContrast.onchange = () => commit(
      { highContrast: selContrast.value as TriState },
      `Yüksek kontrast: ${selContrast.options[selContrast.selectedIndex].text}.`
    );
  }
  const selMotion = container.querySelector('#sel-a11y-motion') as HTMLSelectElement | null;
  if (selMotion) {
    selMotion.onchange = () => commit(
      { reduceMotion: selMotion.value as TriState },
      `Hareketi azalt: ${selMotion.options[selMotion.selectedIndex].text}.`
    );
  }
  const chkLinear = container.querySelector('#chk-a11y-linear') as HTMLInputElement | null;
  if (chkLinear) {
    chkLinear.onchange = () => commit(
      { linearResults: chkLinear.checked },
      chkLinear.checked ? 'Doğrusal sonuç görünümü açık.' : 'Doğrusal sonuç görünümü kapalı.'
    );
  }
}

/** Updates only the theme radios, without re-rendering (keeps focus put). */
export function syncThemeRadios(container: HTMLElement, theme: AppTheme) {
  container.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(radio => {
    radio.checked = radio.value === theme;
  });
}
