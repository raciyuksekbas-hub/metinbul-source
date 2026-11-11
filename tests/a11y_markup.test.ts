// Automated accessibility gates over the shipped markup, stylesheet and
// renderer sources (spec §29, §31).
//
// These are static checks, deliberately: MetinBul has no DOM test
// environment and adding one purely for assertions of this shape would pull
// in a dependency without buying much. They catch the regressions that
// actually happen -- a control losing its label, a focus outline being
// suppressed again, an English string reaching a screen reader -- and they
// are explicitly NOT a substitute for real screen-reader verification, which
// stays a manual release gate (see METINBUL_ACCESSIBILITY_REPORT.md).
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

const indexHtml = read('src/renderer/index.html');
const quickHtml = read('src/renderer/quick-search.html');
const settingsHtml = read('src/renderer/settings.html');
const css = read('src/renderer/style.css');
const rendererTs = read('src/renderer/renderer.ts');
const quickTs = read('src/renderer/quick-search.ts');
const settingsTs = read('src/renderer/settings.ts');
const resultCardTs = read('src/renderer/result-card.ts');
const settingsViews: [string, string][] = [
  'general-view.ts', 'locations-view.ts', 'index-view.ts', 'about-view.ts', 'onboarding-view.ts'
].map(name => [`settings/${name}`, read(`src/renderer/settings/${name}`)]);

const HTML_PAGES: [string, string][] = [
  ['index.html', indexHtml],
  ['quick-search.html', quickHtml],
  ['settings.html', settingsHtml]
];

describe('A11Y-F — Turkish accessibility locale', () => {
  it('declares Turkish as the document language on every page', () => {
    for (const [name, html] of HTML_PAGES) {
      expect(html, name).toMatch(/<html[^>]*\blang="tr"/);
      expect(html, name).not.toMatch(/\blang="en"/);
    }
  });

  it('writes every accessible name and description in Turkish', () => {
    // Latin-script Turkish shares its alphabet with English, so this checks
    // for the specific English strings that would appear if a control were
    // labelled from an untranslated source.
    const forbidden = /aria-label="(Close|Search|Settings|Loading|Selected|Open|Clear|Cancel|Dialog)/i;
    for (const [name, html] of HTML_PAGES) {
      expect(html, name).not.toMatch(forbidden);
    }
  });

  it('labels every window and dialog with a Turkish title', () => {
    // Window titles are what VoiceOver reads when a window takes focus.
    expect(quickHtml).toContain('<title>MetinBul Hızlı Arama</title>');
    expect(settingsHtml).toContain('<title>MetinBul Ayarları</title>');
    expect(indexHtml).toMatch(/id="onboarding-title"[^>]*>MetinBul kurulumu/);
    for (const [name, html] of HTML_PAGES) {
      expect(html, name).not.toMatch(/<title>[^<]*Quick Search/);
    }
  });

  it('names every settings section in Turkish', () => {
    for (const label of ['Genel', 'Arama Konumları', 'İndeks', 'Hakkında']) {
      expect(settingsHtml).toMatch(new RegExp(`role="tab"[^>]*>${label}</button>`));
    }
  });
});

describe('A11Y-B — searchbox semantics', () => {
  it('gives the main search field a real label, not just a placeholder', () => {
    expect(indexHtml).toMatch(/<label[^>]*for="search-input"[^>]*>Belgelerde ara<\/label>/);
    expect(indexHtml).toMatch(/id="search-input"[^>]*aria-describedby="search-input-hint"/s);
  });

  it('uses a search input type so readers announce it as a search field', () => {
    expect(indexHtml).toMatch(/<input\s+type="search"\s+id="search-input"/);
  });

  it('labels the Quick Search field and exposes its combobox behaviour', () => {
    expect(quickHtml).toMatch(/<label[^>]*for="qs-input"[^>]*>Belgelerde ara<\/label>/);
    expect(quickHtml).toMatch(/id="qs-input"[\s\S]*?role="combobox"/);
    expect(quickHtml).toMatch(/aria-controls="qs-listbox"/);
    // The controlled listbox is permanent markup, so aria-controls never
    // points at an element that does not exist yet.
    expect(quickHtml).toMatch(/id="qs-listbox"[^>]*role="listbox"/);
  });

  it('describes the Quick Search keys to screen readers, not only visually', () => {
    expect(quickHtml).toMatch(/id="qs-input"[\s\S]*?aria-describedby="qs-input-hint"/);
    expect(quickTs).toContain('inputHint.textContent');
    expect(quickHtml).toMatch(/id="qs-footer"[^>]*aria-hidden="true"/);
  });

  it('gives the clear-search button a Turkish accessible name, not an icon glyph', () => {
    expect(indexHtml).toMatch(/id="btn-clear-search"[^>]*aria-label="Aramayı temizle"/);
  });
});

describe('A11Y-C — search result semantics', () => {
  it('renders results as a real list collection', () => {
    expect(rendererTs).toContain("resultsList.setAttribute('role', 'list')");
    expect(resultCardTs).toContain("role', options.asOption ? 'option' : 'listitem'");
  });

  it('names the result list with its own count', () => {
    expect(rendererTs).toMatch(/aria-label',\s*`Arama sonuçları, \$\{formatCount\(results\.length\)\} belge`/);
  });

  it('makes the primary result action a real button, not a clickable div', () => {
    expect(resultCardTs).toMatch(/<button type="button" class="result-primary btn-open"/);
  });

  it('exposes selection state on Quick Search options', () => {
    expect(resultCardTs).toContain("row.setAttribute('aria-selected'");
    expect(quickTs).toContain("next.setAttribute('aria-selected', 'true')");
  });
});

describe('A11Y-D — match context is exposed as text', () => {
  it('restates each match passage as screen-reader text', () => {
    expect(resultCardTs).toContain('getAccessibleMatchContext');
    expect(resultCardTs).toMatch(/<span class="visually-hidden"\$\{idAttr\}>\$\{escapeHtml\(spoken\)\}<\/span>/);
  });

  it('hides the visual highlight so the term is not announced twice', () => {
    // The <mark> markup is inside an aria-hidden span in every render path.
    expect(resultCardTs).toMatch(/<span aria-hidden="true">…\$\{sanitizeSnippet\(s\)\}…<\/span>/);
  });

  it('describes the row with its first match context', () => {
    expect(resultCardTs).toContain('aria-describedby="${descId}"');
  });

  it('does not emit a second copy of the description', () => {
    // The description points at the first passage already in the match list.
    // A separate copy makes NVDA/JAWS read the same context twice when
    // traversing the row (spec §34).
    const descIdOccurrences = resultCardTs.match(/\$\{descId\}/g) || [];
    expect(descIdOccurrences.length).toBe(2); // one id attribute, one reference
    expect(resultCardTs).not.toMatch(/<span id="\$\{descId\}" class="visually-hidden">/);
  });
});

describe('A11Y-E — modal and focus management', () => {
  it('gives every dialog a role, modal flag and accessible name', () => {
    // The only modal left is the first-run setup in the Windows main window;
    // settings, search areas and about moved to the Settings window.
    const dialogs = indexHtml.match(/role="dialog"[^>]*/g) || [];
    expect(dialogs.length).toBeGreaterThanOrEqual(1);
    for (const dialog of dialogs) {
      expect(dialog).toContain('aria-modal="true"');
      expect(dialog).toMatch(/aria-labelledby="[^"]+"/);
    }
  });

  it('traps focus in the setup dialog and releases it when setup completes', () => {
    expect(rendererTs).toContain('trapFocus(card');
    expect(rendererTs).toContain('onboardingTrap?.release()');
  });

  it('dismisses the Quick Search panel on Escape and Cmd+W, from any control in it', () => {
    expect(quickTs).toMatch(/e\.key === 'Escape'[\s\S]{0,120}?hideQuickSearch\('dismiss'\)/);
    expect(quickTs).toMatch(/\(e\.key === 'w' \|\| e\.key === 'W'\)[\s\S]{0,160}?hideQuickSearch\('dismiss'\)/);
  });

  it('exposes the Settings sections as a real tab interface', () => {
    const tabs = settingsHtml.match(/<button[^>]*role="tab"[^>]*>/g) || [];
    expect(tabs.length).toBe(4);
    for (const tab of tabs) {
      const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1];
      const id = /id="([^"]+)"/.exec(tab)?.[1];
      expect(controls, tab).toBeTruthy();
      // Each tab controls a real panel, and that panel is named by the tab.
      expect(settingsHtml).toMatch(new RegExp(`id="${controls}"[^>]*role="tabpanel"[^>]*aria-labelledby="${id}"`));
    }
    // Only the selected tab sits in the tab order; arrows move between tabs.
    expect(settingsHtml.match(/role="tab"[^>]*aria-selected="true"/g) || []).toHaveLength(1);
    expect(settingsTs).toContain("e.key === 'ArrowRight'");
    expect(settingsTs).toContain('button.tabIndex = selected ? 0 : -1');
  });

  it('hides the background from assistive tech without hiding the dialog', () => {
    // inertRootsFor only ever returns siblings that do not contain the card,
    // so no focusable control ends up inside an aria-hidden subtree.
    expect(rendererTs).toContain('el => !el.contains(card)');
  });
});

describe('A11Y-A — keyboard navigation', () => {
  it('offers a skip link to the primary control', () => {
    expect(indexHtml).toContain('class="skip-link" href="#search-input"');
  });

  it('uses no positive tabindex anywhere (spec §14)', () => {
    for (const [name, source] of [...HTML_PAGES, ['renderer.ts', rendererTs], ['result-card.ts', resultCardTs], ['quick-search.ts', quickTs], ['settings.ts', settingsTs], ...settingsViews] as [string, string][]) {
      expect(source, name).not.toMatch(/tabindex=["']?[1-9]/i);
      expect(source, name).not.toMatch(/tabIndex\s*=\s*[1-9]/);
    }
  });

  it('keeps focus in the Quick Search field and moves an activedescendant instead', () => {
    expect(quickTs).toContain("qsInput.setAttribute('aria-activedescendant'");
    expect(quickTs).toContain("qsInput.removeAttribute('aria-activedescendant')");
  });
});

describe('A11Y-K — live announcements', () => {
  it('declares both live regions up front on every page', () => {
    for (const [name, html] of HTML_PAGES) {
      expect(html, name).toMatch(/id="a11y-live-polite"[^>]*aria-live="polite"/);
      expect(html, name).toMatch(/id="a11y-live-assertive"[^>]*aria-live="assertive"/);
    }
  });

  it('routes every announcement through the shared channel', () => {
    // No component may mint its own live region (spec §10).
    for (const [name, source] of [['renderer.ts', rendererTs], ['quick-search.ts', quickTs], ['result-card.ts', resultCardTs], ['settings.ts', settingsTs], ...settingsViews] as [string, string][]) {
      expect(source, name).not.toMatch(/aria-live=/);
    }
    expect(rendererTs).toContain("from './announcer.js'");
    expect(quickTs).toContain("from './announcer.js'");
    expect(settingsTs).toContain("from './announcer.js'");
  });

  it('tells the reader why a search found nothing, not just that it did', () => {
    // "Bulamadım" is not "okuyamadım": the no-results announcement says what
    // was searched and what could not be, in its spoken form.
    expect(quickTs).toContain('spokenParts.push(describeCoverage(status, { spoken: true }))');
    expect(quickTs).toContain("announceAlways(spokenParts.join(' '))");
    // ...and an index with nothing readable is announced as such, not as
    // "Sonuç bulunamadı".
    expect(quickTs).toMatch(/announceAlways\(preparing \? 'Belgeler hazırlanıyor\.' : 'Henüz belge indekslenmedi\.'\)/);
  });

  it('reserves the assertive channel for genuine errors', () => {
    const assertiveCalls = rendererTs.match(/announce\w*\([^)]*'assertive'\)/g) || [];
    expect(assertiveCalls.length).toBeGreaterThan(0);
    for (const call of assertiveCalls) {
      expect(call).toMatch(/ERROR_MESSAGES/);
    }
  });
});

describe('A11Y-G / A11Y-H / A11Y-I — scaling, motion and forced colors', () => {
  it('supports text scaling that reflows rather than clips', () => {
    expect(css).toContain('zoom: var(--a11y-text-scale, 1)');
    // The app shell must size from a percentage chain, not the unzoomed
    // viewport: 100vh under zoom overflows instead of reflowing.
    expect(css).toMatch(/\.app-container\s*\{[^}]*height:\s*100%/);
    // Long values wrap instead of being cut off at 200%.
    expect(css).toMatch(/\.result-filename,[\s\S]*?overflow-wrap:\s*anywhere/);
  });

  it('honours prefers-reduced-motion and the in-app override', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('[data-motion="reduce"]');
  });

  it('supports Windows forced colors', () => {
    expect(css).toContain('@media (forced-colors: active)');
    // The match highlight is the app's core signal and must use the system
    // pair Windows reserves for it.
    expect(css).toMatch(/mark\s*\{[^}]*background-color:\s*Mark/);
    expect(css).toMatch(/outline:\s*3px solid Highlight/);
  });
});

describe('A11Y-J — no colour-only information, focus stays visible', () => {
  it('never suppresses a focus indicator without replacing it', () => {
    // `outline: none` is only acceptable when the same rule set, or a
    // :focus-visible rule, restores a visible indicator. The two historical
    // offenders (search input, footer links) are gone.
    expect(css).not.toMatch(/\.footer-action-link:focus\s*\{\s*outline:\s*none/);
    expect(css).not.toMatch(/\.search-box input\s*\{[^}]*outline:\s*none/);
    // The panel's field drops the box ring; its indicator is an accent-coloured
    // caret (the field always holds focus while the panel is up).
    if (/\.qs-field input\s*\{[^}]*outline:\s*none/.test(css)) {
      expect(css).toMatch(/\.qs-field input\s*\{[^}]*caret-color:\s*var\(--accent-teal\)/);
    }
    // The theme switch hides its radios visually; focus moves to the label.
    expect(css).toMatch(/\.segmented-option input:focus-visible \+ span\s*\{[^}]*outline:/);
  });

  it('puts text on accent fills in the contrast-checked colour, not literal white', () => {
    expect(css).toMatch(/\.btn-primary-sm\s*\{[^}]*color:\s*var\(--on-accent\)/);
    expect(css).not.toMatch(/background(-color)?:\s*var\(--accent-teal\);\s*color:\s*#fff/i);
  });

  it('defines a global focus-visible indicator', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  });

  it('marks the selected Quick Search option with more than a background colour', () => {
    expect(css).toMatch(/\[aria-selected="true"\]\s*\{[^}]*border-left/);
  });

  it('marks the active Settings tab with more than a background colour', () => {
    expect(css).toMatch(/\.settings-tab\[aria-selected="true"\]\s*\{[^}]*box-shadow:\s*inset 0 -2px 0/);
  });

  it('keeps row actions visible once they can receive focus', () => {
    expect(css).toContain('.result-row:focus-within .result-actions');
  });
});

describe('Background restore focus (spec §16)', () => {
  const mainTs = read('src/main/main.ts');
  const preloadTs = read('src/main/preload.ts');

  it('tells the renderer when the window is brought back to the front', () => {
    expect(mainTs).toContain("mainWindow.webContents.send('app:windowRestored')");
    expect(preloadTs).toContain("ipcRenderer.on('app:windowRestored', listener)");
  });

  it('moves focus to the search field and announces the restore', () => {
    expect(rendererTs).toContain('onWindowRestored');
    expect(rendererTs).toContain("announceAlways('MetinBul açıldı. Belgelerde ara alanı seçili.')");
  });

  it('does not steal focus out of an open dialog', () => {
    expect(rendererTs).toContain('if (!dialogOpen) {');
  });
});

describe('A11Y-L — screen-reader-safe keyboard shortcuts', () => {
  it('marks decorative icons aria-hidden so they are not read as names', () => {
    for (const [name, html] of HTML_PAGES) {
      const svgs = html.match(/<svg[^>]*>/g) || [];
      // The search pages carry icons; the Settings window is text-only.
      if (name !== 'settings.html') expect(svgs.length, name).toBeGreaterThan(0);
      for (const svg of svgs) {
        expect(svg, `${name}: ${svg}`).toContain('aria-hidden="true"');
      }
    }
  });

  it('gives every icon-only button a Turkish accessible name', () => {
    // Buttons whose only visible content is a glyph must carry aria-label.
    const glyphButtons = indexHtml.match(/<button[^>]*>\s*<span aria-hidden="true">[✕]<\/span>/g) || [];
    expect(glyphButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of glyphButtons) {
      expect(button).toMatch(/aria-label="[^"]+"/);
    }
    // The panel's settings button is an icon (and a dot when an update is
    // waiting); its name says both.
    expect(quickHtml).toMatch(/id="qs-settings"[^>]*aria-label="Ayarlar"/);
    expect(quickTs).toContain("settingsButton.setAttribute('aria-label', `Ayarlar. MetinBul");
  });
});
