// Ayarlar › Hakkında: version, updates, feedback and copyright. These were
// three separate dialogs in the main window ("Hakkında", "Telif", "Geri
// Bildirim") plus the update banner; nothing they offered is dropped.
import { escapeHtml } from '../result-card.js';
import { announceAlways } from '../announcer.js';
import type { UpdateCheckInfo } from '../window-api.js';

const RELEASES_FALLBACK_URL = 'https://github.com/raciyuksekbas-hub/metinbul-releases/releases';

let lastUpdateInfo: UpdateCheckInfo | null = null;

function updateHtml(info: UpdateCheckInfo | null, checking: boolean): string {
  if (checking) return '<p class="settings-status">Güncellemeler denetleniyor…</p>';
  if (!info) return '';
  if (info.updateAvailable) {
    return `
      <p class="settings-notice" role="note">
        MetinBul ${escapeHtml(info.latestVersion || '')} kullanılabilir.
        <button id="btn-view-update" class="settings-inline-link" type="button">Güncellemeyi Gör</button>
      </p>`;
  }
  if (info.status === 'up_to_date') {
    return `<p class="settings-status">${escapeHtml(info.message || 'MetinBul güncel.')}</p>`;
  }
  return `<p class="settings-warning">${escapeHtml(info.message || 'Güncelleme sunucusuna erişilemedi.')}</p>`;
}

export async function renderAboutView(container: HTMLElement, options: { checkUpdates?: boolean } = {}): Promise<void> {
  const [about, knownUpdate] = await Promise.all([
    window.api.getAboutInfo(),
    window.api.getUpdateInfo().catch(() => null)
  ]);
  if (knownUpdate && !lastUpdateInfo) lastUpdateInfo = knownUpdate;

  const render = (checking: boolean) => {
    container.innerHTML = `
      <section class="settings-group about-head" aria-labelledby="about-title">
        <h2 class="about-title" id="about-title">
          <span class="logo-regular">Metin</span><span class="logo-bold">Bul</span>
        </h2>
        <p class="about-version">Sürüm ${escapeHtml(about.version)}</p>
        <p class="about-description">${escapeHtml(about.shortDescription)}</p>
        <p class="settings-note">Geliştirici: ${escapeHtml(about.developerName)}</p>
      </section>

      <section class="settings-group" aria-labelledby="about-updates-title">
        <h2 class="settings-group-title" id="about-updates-title">Güncellemeler</h2>
        <div class="settings-card">
          <div class="settings-row">
            <span class="settings-row-label">Yeni sürüm denetimi</span>
            <button id="btn-check-updates" class="btn-secondary-sm" type="button" ${checking ? 'disabled' : ''}>Güncellemeleri Denetle</button>
          </div>
        </div>
        ${updateHtml(lastUpdateInfo, checking)}
      </section>

      <section class="settings-group" aria-labelledby="about-feedback-title">
        <h2 class="settings-group-title" id="about-feedback-title">Geri Bildirim</h2>
        <p class="settings-note">${escapeHtml(about.feedback.text)}</p>
        <div class="settings-card">
          <div class="settings-row">
            <span class="settings-row-label">${escapeHtml(about.feedback.email)}</span>
            <span class="settings-row-end">
              <button id="btn-send-feedback" class="btn-secondary-sm" type="button">E-posta Gönder</button>
              <button id="btn-copy-feedback-email" class="btn-secondary-sm" type="button">Adresi Kopyala</button>
            </span>
          </div>
        </div>
        <p id="feedback-status" class="settings-status" hidden></p>
      </section>

      <section class="settings-group" aria-labelledby="about-copyright-title">
        <h2 class="settings-group-title" id="about-copyright-title">Telif</h2>
        <p class="about-copyright">${escapeHtml(about.copyright)}</p>
        <p class="settings-note">${escapeHtml(about.copyrightNote)}</p>
      </section>
    `;

    const btnCheck = container.querySelector('#btn-check-updates') as HTMLButtonElement;
    btnCheck.onclick = () => void checkNow();

    const btnView = container.querySelector('#btn-view-update') as HTMLButtonElement | null;
    if (btnView) {
      btnView.onclick = () => {
        void window.api.openExternal(lastUpdateInfo?.releaseUrl || RELEASES_FALLBACK_URL);
      };
    }

    const btnSend = container.querySelector('#btn-send-feedback') as HTMLButtonElement;
    btnSend.onclick = () => {
      if (about.feedback?.mailtoUrl) void window.api.openExternal(about.feedback.mailtoUrl);
      else void window.api.sendFeedback();
    };

    const btnCopy = container.querySelector('#btn-copy-feedback-email') as HTMLButtonElement;
    btnCopy.onclick = async () => {
      const result = await window.api.copyToClipboard(about.feedback.email);
      const status = container.querySelector('#feedback-status') as HTMLElement;
      status.textContent = result.success ? 'E-posta adresi kopyalandı.' : 'Adres kopyalanamadı.';
      status.hidden = false;
      announceAlways(status.textContent);
    };
  };

  async function checkNow() {
    render(true);
    announceAlways('Güncellemeler denetleniyor.');
    try {
      lastUpdateInfo = await window.api.checkForUpdates();
    } catch {
      lastUpdateInfo = { updateAvailable: false, currentVersion: about.version, status: 'unreachable', message: 'Güncelleme sunucusuna erişilemedi.' };
    }
    render(false);
    (container.querySelector('#btn-check-updates') as HTMLElement | null)?.focus();
    const info = lastUpdateInfo;
    announceAlways(info.updateAvailable
      ? `MetinBul ${info.latestVersion || ''} kullanılabilir.`.replace(/\s+/g, ' ')
      : (info.message || (info.status === 'up_to_date' ? 'MetinBul güncel.' : 'Güncelleme sunucusuna erişilemedi.')));
  }

  render(false);
  if (options.checkUpdates) await checkNow();
}

/** Called when the main process finds an update in the background. */
export function noteUpdateAvailable(info: UpdateCheckInfo) {
  lastUpdateInfo = info;
}
