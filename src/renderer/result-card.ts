// Shared result-card rendering used by both the main window and the Quick
// Search window, so the two bundles (built separately by esbuild) don't
// duplicate the same markup/sanitize logic.
//
// Accessibility model (spec §11, §12, §13):
//   * The list is a real list/listitem collection.
//   * Each row's primary control is a real <button> whose accessible name is
//     the whole result sentence ("Sonuç 1 / 12. Merve.udf. 4 eşleşme."), so a
//     reader announces one meaningful unit rather than a badge, a filename and
//     a count as three separate stops.
//   * The visual highlight (<mark>) is aria-hidden and the same information is
//     restated as text ("Eşleşme 2 / 4. Aranan ifade: … Bağlam: …"). Without
//     this the matched term is spoken twice, detached from its sentence.
//   * Match passages are plain list text, not focus stops: the reader's own
//     item navigation moves between them, so no keyboard hijacking is needed.

import {
  getAccessibleSearchResult,
  getAccessibleMatchContext,
  stripHighlight
} from '../shared/a11y-text.js';
import { formatFolderLocation } from '../shared/quick-search-model.js';

export interface RenderableResult {
  id: number;
  filename: string;
  path: string;
  extension: string;
  snippet: string;
  snippets?: string[];
  matchCount?: number;
}

export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Allows only <mark> tags through (used for search-match highlighting);
// everything else is escaped.
export function sanitizeSnippet(snippet: string): string {
  if (!snippet) return '';
  return snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

export function getExtClass(ext: string): string {
  const clean = ext.replace('.', '').toLowerCase();
  switch (clean) {
    case 'docx': return 'ext-docx';
    case 'pdf': return 'ext-pdf';
    case 'udf': return 'ext-udf';
    case 'doc': return 'ext-doc';
    default: return '';
  }
}

/** Containing folder name, used to disambiguate same-named documents. */
export function getFolderName(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

export interface ResultRowOptions {
  // Main window shows up to 3 distinct match passages per document (spec
  // §9); the compact Quick Search window stays single-snippet by default.
  showMultipleSnippets?: boolean;
  /** 1-based position in the result list, for "Sonuç 3 / 18". */
  index?: number;
  /** Total results in the list. */
  total?: number;
  /** The active query, restated as "Aranan ifade: …". */
  query?: string;
  /** DOM id assigned to the row (Quick Search uses it for aria-activedescendant). */
  domId?: string;
  /**
   * Renders the row as a listbox option instead of a listitem containing a
   * button. Used by Quick Search, where arrow keys move a selection while
   * focus stays in the text field: an option must not contain interactive
   * descendants, so the whole row carries the accessible name itself.
   */
  asOption?: boolean;
  /** Option selection state, exposed as aria-selected. */
  selected?: boolean;
}

const MAX_DISPLAYED_SNIPPETS = 3;

let uid = 0;

export interface ResultRowHandlers {
  onOpen: (path: string) => void;
  onShowInFolder?: (path: string) => void;
  /** Quick Search: right-click opens the native result menu. */
  onContextMenu?: (path: string) => void;
}

export function createResultRowElement(
  result: RenderableResult,
  handlers: ResultRowHandlers,
  options: ResultRowOptions = {}
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'result-row';
  row.setAttribute('role', options.asOption ? 'option' : 'listitem');
  if (options.asOption) {
    row.setAttribute('aria-selected', options.selected ? 'true' : 'false');
  }
  if (options.domId) row.id = options.domId;

  const extName = (result.extension || '').replace('.', '').toUpperCase();
  const extClass = getExtClass(result.extension);

  const snippetsToShow = options.showMultipleSnippets && result.snippets && result.snippets.length > 0
    ? result.snippets.slice(0, MAX_DISPLAYED_SNIPPETS)
    : [result.snippet];
  const matchCount = result.matchCount ?? snippetsToShow.length;
  const remaining = matchCount - snippetsToShow.length;

  const index = options.index ?? 1;
  const total = options.total ?? 1;
  const query = options.query || '';

  // The row's single accessible name. The badge/filename/count spans that
  // render it visually are aria-hidden so they are not re-announced.
  const accessibleName = getAccessibleSearchResult({
    index,
    total,
    filename: result.filename,
    matchCount,
    folder: getFolderName(result.path)
  });

  const rowUid = ++uid;
  const descId = `result-desc-${rowUid}`;
  const hasContext = snippetsToShow.length > 0 && !!snippetsToShow[0];

  const snippetsHtml = snippetsToShow
    .map((s, i) => {
      const spoken = getAccessibleMatchContext({
        index: i + 1,
        total: matchCount,
        query,
        snippet: s
      });
      // The first passage doubles as the row button's description, so it is
      // referenced by id rather than duplicated: emitting a second copy makes
      // NVDA/JAWS read the same context twice when traversing the row.
      const idAttr = i === 0 ? ` id="${descId}"` : '';
      return `<div class="result-snippet" role="listitem">
        <span class="visually-hidden"${idAttr}>${escapeHtml(spoken)}</span>
        <span aria-hidden="true">…${sanitizeSnippet(s)}…</span>
      </div>`;
    })
    .join('');

  const matchBadgeHtml = options.showMultipleSnippets && matchCount > 1
    ? `<span class="result-match-count" aria-hidden="true">${matchCount} eşleşme</span>`
    : '';
  const remainingHtml = remaining > 0
    ? `<div class="result-snippet-more">
         <span class="visually-hidden">Bu belgede ${remaining} eşleşme daha var.</span>
         <span aria-hidden="true">+${remaining} eşleşme daha</span>
       </div>`
    : '';

  // Description = the first passage, so a reader tabbing the list hears where
  // the term occurred without having to enter each row. In listitem mode this
  // is the in-list node referenced by id; option mode has no list to point at,
  // so it is folded into the option's own label instead.
  const firstContext = hasContext
    ? getAccessibleMatchContext({ index: 1, total: matchCount, query, snippet: snippetsToShow[0] })
    : '';

  if (options.asOption) {
    // Quick Search: name, the passage where the term occurs, and the folder
    // -- nothing a user does not need to answer "which document, and where?".
    // aria-label on the option is the single spoken unit; everything inside
    // is decorative so nothing is announced twice.
    row.setAttribute('aria-label', `${accessibleName} ${firstContext}`.trim());
    row.classList.add('qs-option');

    // Passages are shown exactly as search() cut them: it already puts "…"
    // on the ends it trimmed (and only there), so adding marks here would
    // produce the doubled "……" the accessibility report recorded.
    //
    // Every row shows its best passage. The selected row also reveals up to
    // two more, plus how many matches remain, which is how the multi-passage
    // view of the old main window survives in a single-column panel.
    const passages = (result.snippets && result.snippets.length > 0 ? result.snippets : [result.snippet])
      .filter(Boolean)
      .slice(0, MAX_DISPLAYED_SNIPPETS);
    const optionRemaining = Math.max(0, matchCount - passages.length);
    const location = formatFolderLocation(result.path);

    row.innerHTML = `
      <div class="qs-option-name result-filename" aria-hidden="true">${escapeHtml(result.filename)}</div>
      ${passages.map((sn, i) => `
        <div class="qs-option-snippet${i > 0 ? ' qs-option-extra' : ''}" aria-hidden="true">${sanitizeSnippet(sn)}</div>
      `).join('')}
      ${optionRemaining > 0 ? `<div class="qs-option-more qs-option-extra" aria-hidden="true">+${optionRemaining} eşleşme daha</div>` : ''}
      <div class="qs-option-location" aria-hidden="true" title="${escapeHtml(result.path)}">${escapeHtml(location)}</div>
    `;

    // Mouse equivalents of the keyboard actions: click opens, Cmd-click
    // (Ctrl-click elsewhere) reveals in the file manager, right-click offers
    // both. Keyboard users have Enter / Cmd+Enter on the combobox.
    row.addEventListener('click', (e) => {
      const reveal = e.metaKey || e.ctrlKey;
      if (reveal && handlers.onShowInFolder) handlers.onShowInFolder(result.path);
      else handlers.onOpen(result.path);
    });
    if (handlers.onContextMenu) {
      const onContextMenu = handlers.onContextMenu;
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onContextMenu(result.path);
      });
    }
    return row;
  }

  row.innerHTML = `
    <div class="result-row-header">
      <div class="result-title-group">
        <button type="button" class="result-primary btn-open"
                aria-label="${escapeHtml(accessibleName)}"
                ${hasContext ? `aria-describedby="${descId}"` : ''}>
          <span class="ext-badge ${extClass}" aria-hidden="true">${escapeHtml(extName)}</span>
          <span class="result-filename" aria-hidden="true">${escapeHtml(result.filename)}</span>
          ${matchBadgeHtml}
        </button>
      </div>
      ${handlers.onShowInFolder ? `
        <div class="result-actions">
          <button type="button" class="btn-action btn-open-action"
                  aria-label="${escapeHtml(result.filename)} dosyasını aç">Aç</button>
          <button type="button" class="btn-action btn-show"
                  aria-label="${escapeHtml(result.filename)} dosyasını klasörde göster">Klasörde Göster</button>
        </div>
      ` : ''}
    </div>
    <div class="result-snippets" role="list" aria-label="Eşleşen metin bağlamları">
      ${snippetsHtml}
    </div>
    ${remainingHtml}
    <div class="result-path">
      <span class="visually-hidden">Konum: ${escapeHtml(result.path)}.</span>
      <span aria-hidden="true">${escapeHtml(result.path)}</span>
    </div>
  `;

  row.querySelectorAll<HTMLButtonElement>('.btn-open, .btn-open-action').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      handlers.onOpen(result.path);
    };
  });

  const btnShow = row.querySelector('.btn-show') as HTMLButtonElement | null;
  if (btnShow && handlers.onShowInFolder) {
    const onShowInFolder = handlers.onShowInFolder;
    btnShow.onclick = (e) => {
      e.stopPropagation();
      onShowInFolder(result.path);
    };
  }

  // Mouse affordance only: keyboard users activate the real button above, so
  // this must not become a second, unlabelled tab stop.
  row.onclick = (e) => {
    if ((e.target as HTMLElement)?.closest('button')) return;
    handlers.onOpen(result.path);
  };

  return row;
}

export { stripHighlight };
