// First-run setup: where to search, and -- for a fresh install -- whether to
// start with the computer. Shown once, before the first scan (see
// resolveShouldShowOnboarding in main.ts); indexing does not start until a
// scope has been chosen.
//
// Used by the Settings window (macOS) and by the main window's setup dialog
// (Windows/Linux), so both platforms ask exactly the same thing.
import { escapeHtml } from '../result-card.js';
import { announce } from '../announcer.js';
import { getAllScopeNote } from '../../shared/a11y-text.js';
import { recordShortcut } from './shortcut-recorder.js';

export interface OnboardingViewOptions {
  /** Called after the choice has been saved and the first scan started. */
  onComplete: () => void;
}

export async function renderOnboardingView(container: HTMLElement, options: OnboardingViewOptions): Promise<void> {
  const startupAndShortcut = await Promise.all([
    window.api.getStartupSettings(),
    window.api.getQuickSearchShortcut()
  ]);
  const startup = startupAndShortcut[0];
  let shortcut = startupAndShortcut[1];
  // What the last attempt to change the shortcut came to.
  let shortcutStatus = '';

  let mode: 'all' | 'selected' = 'all';
  let folders: string[] = [];
  // Start-at-login is on by default for a new install -- in plain view, as a
  // ticked box the user can untick before anything is registered.
  let startAtLogin = true;

  function render(focusSelector?: string) {
    const canContinue = mode === 'all' || folders.length > 0;
    const foldersHtml = folders.length === 0
      ? '<p class="settings-empty">Henüz klasör eklenmedi.</p>'
      : `<ul class="settings-list" aria-label="Seçilen klasörler">
          ${folders.map(folder => `
            <li class="settings-list-item">
              <span class="settings-list-path" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
              <button class="btn-secondary-sm btn-remove-onboarding-folder" data-path="${escapeHtml(folder)}" type="button"
                      aria-label="${escapeHtml(folder)} klasörünü listeden kaldır">Kaldır</button>
            </li>`).join('')}
        </ul>`;

    container.innerHTML = `
      <div class="onboarding">
        <h1 class="onboarding-title" id="onboarding-heading">Nerede aramak istiyorsunuz?</h1>
        <p class="settings-note">MetinBul yalnızca seçtiğiniz konumlardaki DOC, DOCX, PDF ve UDF belgelerini indeksler. Bu ayarı daha sonra Arama Konumları bölümünden değiştirebilirsiniz.</p>

        <div class="settings-card">
          <div class="settings-row">
            <span class="settings-choice" role="radiogroup" aria-labelledby="onboarding-heading">
              <label class="radio-label">
                <input type="radio" name="onboarding-mode" value="all" ${mode === 'all' ? 'checked' : ''}>
                <span>Bilgisayarın Tümü</span>
              </label>
              <label class="radio-label">
                <input type="radio" name="onboarding-mode" value="selected" ${mode === 'selected' ? 'checked' : ''}>
                <span>Sadece Belirli Klasörler</span>
              </label>
            </span>
          </div>
        </div>
        ${mode === 'all' ? `<p class="settings-note">${escapeHtml(getAllScopeNote(/Windows/.test(navigator.userAgent)))}</p>` : ''}

        ${mode === 'selected' ? `
          <section class="settings-group" aria-labelledby="onboarding-folders-title">
            <div class="settings-group-header">
              <h2 class="settings-group-title" id="onboarding-folders-title">Şunlarla Sınırlı</h2>
              <button id="btn-onboarding-add-folder" class="btn-secondary-sm" type="button">Klasör Ekle…</button>
            </div>
            ${foldersHtml}
          </section>` : ''}

        ${startup.startAtLoginSupported ? `
          <div class="settings-card">
            <div class="settings-row">
              <label class="checkbox-label">
                <input type="checkbox" id="chk-onboarding-start-at-login" ${startAtLogin ? 'checked' : ''}>
                <span>Bilgisayar açıldığında MetinBul’u başlat</span>
              </label>
            </div>
          </div>` : ''}

        <div class="settings-card">
          <div class="settings-row">
            <span class="settings-row-label" id="onboarding-shortcut-label">Hızlı Arama kısayolu</span>
            <span class="settings-row-end">
              <kbd class="settings-kbd" id="onboarding-shortcut-current" aria-labelledby="onboarding-shortcut-label onboarding-shortcut-current">${escapeHtml(shortcut.display || shortcut.accelerator)}</kbd>
              <button id="btn-onboarding-shortcut" class="btn-secondary-sm" type="button" aria-describedby="onboarding-shortcut-note">Değiştir</button>
            </span>
          </div>
        </div>
        <p class="settings-note" id="onboarding-shortcut-note">Kurulumdan sonra hangi programda olursanız olun bu kısayol MetinBul’un arama alanını açar. Bu tuşları başka bir programda kullanıyorsanız değiştirin.</p>
        <p id="onboarding-shortcut-status" class="settings-status" ${shortcutStatus ? '' : 'hidden'}>${escapeHtml(shortcutStatus)}</p>

        <div class="onboarding-actions">
          <button id="btn-onboarding-continue" class="btn-primary-sm" type="button" ${canContinue ? '' : 'disabled'}>Devam Et</button>
        </div>
      </div>
    `;

    container.querySelectorAll<HTMLInputElement>('input[name="onboarding-mode"]').forEach(radio => {
      radio.onchange = () => {
        mode = radio.value === 'selected' ? 'selected' : 'all';
        render(`input[name="onboarding-mode"][value="${mode}"]`);
      };
    });

    const btnAdd = container.querySelector('#btn-onboarding-add-folder') as HTMLButtonElement | null;
    if (btnAdd) {
      btnAdd.onclick = async () => {
        const selected = await window.api.selectFolder('include');
        if (selected && !folders.includes(selected)) {
          folders.push(selected);
          render('#btn-onboarding-add-folder');
        }
      };
    }

    container.querySelectorAll<HTMLButtonElement>('.btn-remove-onboarding-folder').forEach(btn => {
      btn.onclick = () => {
        folders = folders.filter(f => f !== btn.dataset.path);
        render('#btn-onboarding-add-folder');
      };
    });

    const chkStart = container.querySelector('#chk-onboarding-start-at-login') as HTMLInputElement | null;
    if (chkStart) {
      chkStart.onchange = () => {
        startAtLogin = chkStart.checked;
      };
    }

    const btnShortcut = container.querySelector('#btn-onboarding-shortcut') as HTMLButtonElement;
    btnShortcut.onclick = () => {
      recordShortcut(btnShortcut, async message => {
        shortcut = await window.api.getQuickSearchShortcut();
        shortcutStatus = message ?? '';
        render('#btn-onboarding-shortcut');
        if (message) announce(message);
      });
    };

    const btnContinue = container.querySelector('#btn-onboarding-continue') as HTMLButtonElement;
    btnContinue.onclick = async () => {
      btnContinue.disabled = true;
      await window.api.completeOnboarding(
        mode,
        mode === 'selected' ? folders : undefined,
        startup.startAtLoginSupported ? { startAtLogin } : undefined
      );
      announce('Kurulum tamamlandı. Belgeleriniz indeksleniyor.');
      options.onComplete();
    };

    if (focusSelector) (container.querySelector(focusSelector) as HTMLElement | null)?.focus();
  }

  render();
}
