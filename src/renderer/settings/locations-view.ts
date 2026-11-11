// Ayarlar › Arama Konumları: where MetinBul searches. Moved here from the
// main window's "Arama Alanları" dialog; every change is saved as it is made
// and re-indexes the affected scope, exactly as before.
import { escapeHtml } from '../result-card.js';
import { announceAlways } from '../announcer.js';
import { getAccessibleScopeState } from '../../shared/a11y-text.js';
import type { SearchAreaItem } from '../window-api.js';

export interface LocationsViewOptions {
  /** Called after any change, so other views can refresh their counts. */
  onChanged?: () => void;
}

function folderList(items: SearchAreaItem[], label: string, empty: string, type: 'include' | 'exclude'): string {
  if (items.length === 0) {
    return `<p class="settings-empty">${empty}</p>`;
  }
  return `
    <ul class="settings-list" aria-label="${label}">
      ${items.map(area => `
        <li class="settings-list-item">
          <span class="settings-list-path" title="${escapeHtml(area.path)}">${escapeHtml(area.path)}</span>
          <button class="btn-secondary-sm btn-remove-area" data-path="${escapeHtml(area.path)}" data-type="${type}" type="button"
                  aria-label="${escapeHtml(area.path)} klasörünü listeden kaldır">Kaldır</button>
        </li>
      `).join('')}
    </ul>`;
}

export async function renderLocationsView(container: HTMLElement, options: LocationsViewOptions = {}): Promise<void> {
  const [mode, areas] = await Promise.all([
    window.api.getSearchScopeMode(),
    window.api.getSearchAreas()
  ]);
  const includes = areas.filter(a => a.type === 'include');
  const excludes = areas.filter(a => a.type === 'exclude');

  container.innerHTML = `
    <section class="settings-group" aria-labelledby="scope-title">
      <h2 class="settings-group-title" id="scope-title">Nerede aransın?</h2>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-choice" role="radiogroup" aria-labelledby="scope-title">
            <label class="radio-label">
              <input type="radio" name="search-scope-mode" value="all" ${mode === 'all' ? 'checked' : ''}>
              <span>Bilgisayarın Tümü</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="search-scope-mode" value="selected" ${mode === 'selected' ? 'checked' : ''}>
              <span>Sadece Belirli Klasörler</span>
            </label>
          </span>
        </div>
      </div>
      <p class="settings-note">${mode === 'all'
        ? 'Bilgisayarınızdaki erişilebilir belge konumlarında arama yapılır. Sistem ve geçici dosya alanları taranmaz.'
        : 'Yalnızca aşağıda eklediğiniz klasörlerde arama yapılır.'}</p>
    </section>

    ${mode === 'selected' ? `
    <section class="settings-group" aria-labelledby="includes-title">
      <div class="settings-group-header">
        <h2 class="settings-group-title" id="includes-title">Şunlarla Sınırlı</h2>
        <button id="btn-add-include-folder" class="btn-secondary-sm" type="button">Klasör Ekle…</button>
      </div>
      ${folderList(includes, 'Aramaya dahil edilen klasörler', 'Henüz klasör eklenmedi. Arama yapabilmek için en az bir klasör ekleyin.', 'include')}
    </section>` : ''}

    <section class="settings-group" aria-labelledby="excludes-title">
      <div class="settings-group-header">
        <h2 class="settings-group-title" id="excludes-title">Şunlar Dışında</h2>
        <button id="btn-add-exclude-folder" class="btn-secondary-sm" type="button">Klasör Hariç Tut…</button>
      </div>
      ${folderList(excludes, 'Aramadan hariç tutulan klasörler', 'Hariç tutulan klasör yok.', 'exclude')}
    </section>
  `;

  const refresh = async (focusSelector?: string) => {
    await renderLocationsView(container, options);
    options.onChanged?.();
    if (focusSelector) (container.querySelector(focusSelector) as HTMLElement | null)?.focus();
  };

  container.querySelectorAll<HTMLInputElement>('input[name="search-scope-mode"]').forEach(radio => {
    radio.onchange = async () => {
      const targetMode = radio.value === 'selected' ? 'selected' : 'all';
      await window.api.setSearchScopeMode(targetMode);
      const updated = await window.api.getSearchAreas();
      announceAlways(getAccessibleScopeState(targetMode, updated.filter(a => a.type === 'include').length));
      await refresh(`input[name="search-scope-mode"][value="${targetMode}"]`);
    };
  });

  const addFolder = async (type: 'include' | 'exclude', buttonId: string) => {
    const selected = await window.api.selectFolder();
    if (!selected) return;
    await window.api.addSearchArea(selected, type);
    announceAlways(type === 'include'
      ? `${selected} klasörü arama kapsamına eklendi.`
      : `${selected} klasörü arama dışında bırakıldı.`);
    await refresh(`#${buttonId}`);
  };

  const btnAddInclude = container.querySelector('#btn-add-include-folder') as HTMLButtonElement | null;
  if (btnAddInclude) btnAddInclude.onclick = () => addFolder('include', 'btn-add-include-folder');
  const btnAddExclude = container.querySelector('#btn-add-exclude-folder') as HTMLButtonElement | null;
  if (btnAddExclude) btnAddExclude.onclick = () => addFolder('exclude', 'btn-add-exclude-folder');

  container.querySelectorAll<HTMLButtonElement>('.btn-remove-area').forEach(btn => {
    btn.onclick = async () => {
      const targetPath = btn.dataset.path;
      if (!targetPath) return;
      await window.api.removeSearchArea(targetPath);
      announceAlways(`${targetPath} klasörü listeden kaldırıldı.`);
      // The button that had focus is gone; its section's "add" button is the
      // natural place to land.
      await refresh(btn.dataset.type === 'include' ? '#btn-add-include-folder' : '#btn-add-exclude-folder');
    };
  });
}
