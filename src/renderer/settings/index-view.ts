// Ayarlar › İndeks: what MetinBul has read, when, and what it could not.
//
// The trust rule behind this page: "bulamadım" (not found) and "okuyamadım"
// (could not read) are different answers. Documents that failed extraction,
// that carry no text layer, or whose cloud content is not on this device are
// counted separately here, and the panel's no-results state points at it.
import { escapeHtml } from '../result-card.js';
import { announceAlways } from '../announcer.js';
import { formatCount, getAccessibleDocumentCount, getAccessibleIndexingStatus } from '../../shared/a11y-text.js';
import { formatFolderLocation, formatIndexTimestamp, INDEX_UPDATING_NOTE } from '../../shared/quick-search-model.js';
import type { IndexStatus, UnreadableDocumentItem } from '../window-api.js';

export interface IndexViewOptions {
  /** One-time note shown above the summary (e.g. right after setup). */
  notice?: string | null;
}

function progressHtml(status: IndexStatus): string {
  if (!status.isIndexing) return '';
  const p = status.progress;
  if (p && p.status === 'indexing' && p.total > 0) {
    return `
      <div class="index-progress">
        <progress max="${p.total}" value="${p.current}" aria-label="İndeksleme ilerlemesi"></progress>
        <span>${escapeHtml(getAccessibleIndexingStatus(p.current, p.total))}</span>
      </div>`;
  }
  return `<div class="index-progress"><span>Belgeleriniz taranıyor…</span></div>`;
}

function issuesHtml(status: IndexStatus): string {
  const items: string[] = [];
  if (status.failed > 0) {
    items.push(`<li><strong>${formatCount(status.failed)}</strong> belge işlenemedi (bozuk, şifreli veya desteklenmeyen biçim).</li>`);
  }
  if (status.noText > 0) {
    items.push(`<li><strong>${formatCount(status.noText)}</strong> belgede aranabilir metin yok (örneğin taranmış PDF).</li>`);
  }
  if (status.dataless > 0) {
    items.push(`<li><strong>${formatCount(status.dataless)}</strong> belgenin içeriği bu bilgisayarda değil (bulut dosyası). MetinBul bu dosyaları kendiliğinden indirmez.</li>`);
  }
  if (items.length === 0) {
    return status.indexed > 0
      ? '<p class="settings-note">Kapsamdaki tüm belgeler okunabildi.</p>'
      : '';
  }
  return `
    <section class="settings-group" aria-labelledby="index-issues-title">
      <h2 class="settings-group-title" id="index-issues-title">Aranamayan belgeler</h2>
      <ul class="index-issues">${items.join('')}</ul>
      ${status.failed + status.noText > 0 ? `
      <details id="unreadable-details" class="index-details">
        <summary>İşlenemeyen belgeleri göster</summary>
        <div id="unreadable-list" class="index-details-body"><p class="settings-note">Yükleniyor…</p></div>
      </details>` : ''}
    </section>`;
}

function autoIndexNote(status: IndexStatus): string {
  const minutes = status.autoIndexIntervalMinutes;
  if (!status.autoIndexEnabled) {
    return 'Otomatik güncelleme kapalı. Yeni veya değişen belgeler için Belgeleri Güncelle\'yi kullanın.';
  }
  const next = status.nextAutoIndexAt && !status.isIndexing
    ? ` Sonraki otomatik güncelleme: ${formatIndexTimestamp(status.nextAutoIndexAt)}.`
    : '';
  return `MetinBul açıkken belgeleriniz ${minutes} dakikada bir kendiliğinden güncellenir; yeni ve değişen belgeler `
    + `en geç ${minutes} dakika içinde aranabilir olur. Hemen güncellemek için Belgeleri Güncelle'yi kullanın.${next}`;
}

function ocrNote(status: IndexStatus): string {
  if (!status.ocrEnabled) {
    return 'Metin tanıma kapalı: taranmış PDF\'lerin içeriği aranmaz. Daha önce okunanlar aranmaya devam eder.';
  }
  const counts = [`Metin tanımayla okunan: ${formatCount(status.ocrRecognized)} belge.`];
  if (status.ocrPending > 0) counts.push(`Sırada bekleyen: ${formatCount(status.ocrPending)} belge.`);
  return `PDF'lerin metin içermeyen sayfaları (taranmış belgeler) ${status.ocrSystemName}'un metin tanımasıyla okunur; `
    + `internet gerekmez ve belgeler bilgisayarınızdan çıkmaz. Her güncellemede en çok ${status.ocrBudgetMinutes} dakika çalışır. ${counts.join(' ')}`;
}

function unreadableListHtml(items: UnreadableDocumentItem[]): string {
  if (items.length === 0) return '<p class="settings-note">İşlenemeyen belge yok.</p>';
  return `
    <ul class="settings-list" aria-label="İşlenemeyen belgeler">
      ${items.map(item => `
        <li class="settings-list-item">
          <span class="settings-list-text">
            <span class="settings-list-name">${escapeHtml(item.filename)}</span>
            <span class="settings-list-meta">${item.status === 'failed' ? 'Okunamadı' : 'Metin yok'} · ${escapeHtml(formatFolderLocation(item.path))}</span>
          </span>
          <button class="btn-secondary-sm btn-reveal-unreadable" type="button" data-path="${escapeHtml(item.path)}"
                  aria-label="${escapeHtml(item.filename)} dosyasını klasörde göster">Göster</button>
        </li>`).join('')}
    </ul>`;
}

export async function renderIndexView(container: HTMLElement, options: IndexViewOptions = {}): Promise<void> {
  const status = await window.api.getIndexStatus();
  const wasOpen = (container.querySelector('#unreadable-details') as HTMLDetailsElement | null)?.open === true;
  // Updates re-render this page on their own now (every few minutes): put
  // keyboard focus back where it was instead of dropping it on the body.
  const active = document.activeElement as HTMLElement | null;
  const focusedId = active && container.contains(active) ? active.id : '';

  const updated = status.lastIndexedAt > 0
    ? `Son güncelleme: ${escapeHtml(formatIndexTimestamp(status.lastIndexedAt))}`
    : 'Henüz tamamlanmış bir güncelleme yok.';

  container.innerHTML = `
    ${options.notice ? `<p class="settings-notice" role="note">${escapeHtml(options.notice)}</p>` : ''}

    <section class="settings-group" aria-labelledby="index-summary-title">
      <h2 class="settings-group-title" id="index-summary-title">Durum</h2>
      <div class="settings-card">
        <div class="settings-row index-summary">
          <span class="index-summary-text">
            <span class="index-count">${escapeHtml(getAccessibleDocumentCount(status.indexed).replace(/\.$/, ''))}</span>
            <span class="index-updated">${updated}</span>
          </span>
          <button id="btn-index-update" class="btn-primary-sm" type="button" ${status.isIndexing ? 'disabled' : ''}>
            ${status.isIndexing ? 'Güncelleniyor…' : 'Belgeleri Güncelle'}
          </button>
        </div>
        ${progressHtml(status)}
      </div>
      ${status.isIndexing ? `<p class="settings-status">${escapeHtml(INDEX_UPDATING_NOTE)}</p>` : ''}
      <div class="settings-card">
        <div class="settings-row">
          <label class="checkbox-label">
            <input type="checkbox" id="chk-auto-index" aria-describedby="auto-index-note" ${status.autoIndexEnabled ? 'checked' : ''}>
            <span>Belgeleri otomatik güncelle (${status.autoIndexIntervalMinutes} dakikada bir)</span>
          </label>
        </div>
      </div>
      <p class="settings-note" id="auto-index-note">${escapeHtml(autoIndexNote(status))}</p>
      ${status.ocrAvailable ? `
      <div class="settings-card">
        <div class="settings-row">
          <label class="checkbox-label">
            <input type="checkbox" id="chk-ocr" aria-describedby="ocr-note" ${status.ocrEnabled ? 'checked' : ''}>
            <span>Taranmış PDF'lerde metin tanıma</span>
          </label>
        </div>
      </div>
      <p class="settings-note" id="ocr-note">${escapeHtml(ocrNote(status))}</p>` : ''}
      ${status.ocrNeedsTurkishComponent ? `
      <div class="settings-card">
        <div class="settings-row">
          <button id="btn-install-ocr-turkish" class="btn-secondary-sm" type="button" aria-describedby="ocr-turkish-note">Türkçe metin tanımayı yükle</button>
        </div>
      </div>
      <p class="settings-note" id="ocr-turkish-note">Taranmış PDF'lerin okunabilmesi için Windows'un Türkçe metin tanıma bileşeni gerekiyor. Yüklemek için internet bağlantısı ve yönetici izni gerekir.</p>` : ''}
      ${status.ocrRestricted ? `
      <p class="settings-warning" role="note">Bu bilgisayarın güvenlik ayarları (PowerShell’in kısıtlı dil kipi) Windows’un metin tanımasını engelliyor: taranmış PDF’lerin yalnızca metin katmanı aranabilir. Bilgisayarı yöneten kişiye danışabilirsiniz.</p>` : ''}
      ${status.lastSearchError ? `
      <p class="settings-warning" role="note">
        Son arama hatası (${escapeHtml(formatIndexTimestamp(status.lastSearchError.at))}):
        ${escapeHtml(status.lastSearchError.message)}
      </p>` : ''}
    </section>

    ${issuesHtml(status)}

    <section class="settings-group" aria-labelledby="index-file-title">
      <h2 class="settings-group-title" id="index-file-title">Arama Dizini</h2>
      ${status.indexEncrypted
        ? '<p class="settings-note">Arama dizini şifreli: yalnızca bu bilgisayardaki kullanıcı hesabınızla açılabilir.</p>'
        : `<p class="settings-warning" role="note">${escapeHtml(status.indexEncryptionProblem || 'Arama dizini şifrelenmemiş.')}</p>`}
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label">Dizini sil ve yeniden oluştur</span>
          <button id="btn-index-rebuild" class="btn-secondary-sm" type="button" aria-describedby="index-rebuild-note">Yeniden Oluştur…</button>
        </div>
      </div>
      <p class="settings-note" id="index-rebuild-note">Arama dizinindeki bütün metinler silinir ve belgeler baştan okunur. Belgelerinize ve ayarlarınıza dokunulmaz.</p>
    </section>
  `;

  if (focusedId) (container.querySelector(`#${focusedId}`) as HTMLElement | null)?.focus();

  const chkAuto = container.querySelector('#chk-auto-index') as HTMLInputElement;
  chkAuto.onchange = async () => {
    const wanted = chkAuto.checked;
    chkAuto.disabled = true;
    await window.api.setAutoIndexEnabled(wanted);
    await renderIndexView(container, options);
    (container.querySelector('#chk-auto-index') as HTMLInputElement | null)?.focus();
    announceAlways(wanted
      ? `Belgeler ${status.autoIndexIntervalMinutes} dakikada bir otomatik güncellenecek.`
      : 'Otomatik güncelleme kapatıldı.');
  };

  const chkOcr = container.querySelector('#chk-ocr') as HTMLInputElement | null;
  if (chkOcr) {
    chkOcr.onchange = async () => {
      const wanted = chkOcr.checked;
      chkOcr.disabled = true;
      await window.api.setOcrEnabled(wanted);
      await renderIndexView(container, options);
      (container.querySelector('#chk-ocr') as HTMLInputElement | null)?.focus();
      announceAlways(wanted
        ? 'Taranmış PDF\'ler bir sonraki güncellemeden başlayarak metin tanımayla okunacak.'
        : 'Metin tanıma kapatıldı.');
    };
  }

  const btnInstallTurkish = container.querySelector('#btn-install-ocr-turkish') as HTMLButtonElement | null;
  if (btnInstallTurkish) {
    btnInstallTurkish.onclick = async () => {
      btnInstallTurkish.disabled = true;
      btnInstallTurkish.textContent = 'Yükleniyor…';
      announceAlways('Türkçe metin tanıma bileşeni yükleniyor. Windows yönetici izni isteyecek.');
      const { success } = await window.api.installWindowsTurkishOcr();
      const notice = success
        ? 'Türkçe metin tanıma hazır. Taranmış PDF\'ler bir sonraki güncellemeden başlayarak okunacak.'
        : 'Türkçe metin tanıma bileşeni yüklenemedi. İnternet bağlantınızı ve yönetici iznini kontrol edip yeniden deneyin.';
      await renderIndexView(container, { ...options, notice });
      announceAlways(notice);
    };
  }

  const btnUpdate = container.querySelector('#btn-index-update') as HTMLButtonElement;
  btnUpdate.onclick = async () => {
    btnUpdate.disabled = true;
    btnUpdate.textContent = 'Güncelleniyor…';
    announceAlways('Belgeler güncelleniyor.');
    await window.api.rescan();
  };

  const btnRebuild = container.querySelector('#btn-index-rebuild') as HTMLButtonElement;
  btnRebuild.onclick = async () => {
    // The main process asks for confirmation in a dialog of its own.
    if (await window.api.rebuildIndex()) {
      announceAlways('Arama dizini silindi; belgeler baştan okunuyor.');
    }
  };

  const details = container.querySelector('#unreadable-details') as HTMLDetailsElement | null;
  if (details) {
    const load = async () => {
      const list = container.querySelector('#unreadable-list') as HTMLElement | null;
      if (!list) return;
      list.innerHTML = unreadableListHtml(await window.api.getUnreadableDocuments());
      list.querySelectorAll<HTMLButtonElement>('.btn-reveal-unreadable').forEach(btn => {
        btn.onclick = async () => {
          const result = await window.api.showInFolder(btn.dataset.path || '');
          if (!result.success && result.error) announceAlways(result.error, 'assertive');
        };
      });
    };
    details.addEventListener('toggle', () => {
      if (details.open) void load();
    });
    // A progress refresh re-renders the page; keep the list open if it was.
    if (wasOpen) {
      details.open = true;
    }
  }
}
