import { describe, it, expect } from 'vitest';
import {
  getAccessibleSearchResult,
  getAccessibleMatchContext,
  getAccessibleSearchStatus,
  getAccessibleFilterState,
  getAccessibleScopeState,
  getAccessibleDocumentCount,
  getAccessibleIndexingStatus,
  stripHighlight,
  extractHighlightedTerm,
  formatCount,
  SEARCH_STATUS_SEARCHING,
  SEARCH_STATUS_NO_RESULTS,
  SEARCH_STATUS_FAILED,
  ERROR_MESSAGES
} from '../src/shared/a11y-text.js';

// A11Y-F: every user-facing accessible string is Turkish.
// A11Y-C / A11Y-D: result and match-context sentences (spec §30).
describe('A11Y-C — accessible search result text', () => {
  it('renders position, filename and match count as one Turkish sentence', () => {
    expect(getAccessibleSearchResult({
      index: 1,
      total: 12,
      filename: 'Merve.udf',
      matchCount: 4
    })).toBe('Sonuç 1 / 12. Merve.udf. 4 eşleşme.');
  });

  it('appends the containing folder when one is supplied', () => {
    expect(getAccessibleSearchResult({
      index: 3,
      total: 18,
      filename: 'Merve Işık İstinaf.udf',
      matchCount: 4,
      folder: 'Belgeler'
    })).toBe('Sonuç 3 / 18. Merve Işık İstinaf.udf. 4 eşleşme. Belgeler klasörü.');
  });

  it('omits the match count when the document reports none', () => {
    expect(getAccessibleSearchResult({ index: 2, total: 5, filename: 'rapor.pdf' }))
      .toBe('Sonuç 2 / 5. rapor.pdf.');
  });

  it('groups thousands the Turkish way so readers speak a real number', () => {
    expect(formatCount(1234)).toBe('1.234');
    expect(getAccessibleSearchResult({
      index: 1, total: 2000, filename: 'a.doc', matchCount: 1500
    })).toContain('1.500 eşleşme.');
  });
});

describe('A11Y-D — accessible match context', () => {
  it('states the position, the searched term and the surrounding sentence', () => {
    const spoken = getAccessibleMatchContext({
      index: 2,
      total: 4,
      query: 'tahliye',
      snippet: '…Davacının kiralanana olan ihtiyacı <mark>gerçek</mark>, samimi ve zorunludur.…'
    });
    expect(spoken).toBe(
      'Eşleşme 2 / 4. Aranan ifade: tahliye. '
      + 'Bağlam: Davacının kiralanana olan ihtiyacı gerçek, samimi ve zorunludur.'
    );
  });

  it('drops the position clause when a document has a single match', () => {
    const spoken = getAccessibleMatchContext({
      index: 1, total: 1, query: 'tahliye', snippet: 'Kiracı <mark>tahliye</mark> edilmiştir.'
    });
    expect(spoken).toBe('Aranan ifade: tahliye. Bağlam: Kiracı tahliye edilmiştir.');
  });

  it('falls back to the highlighted term when no query is supplied', () => {
    const spoken = getAccessibleMatchContext({
      index: 1, total: 1, query: '', snippet: 'Kiracı <mark>tahliye</mark> edilmiştir.'
    });
    expect(spoken).toContain('Aranan ifade: tahliye.');
  });

  it('never leaves markup in the spoken text (spec §13)', () => {
    const spoken = getAccessibleMatchContext({
      index: 1, total: 2, query: 'x', snippet: 'a <mark>x</mark> b'
    });
    expect(spoken).not.toContain('<');
    expect(spoken).not.toContain('mark');
  });

  it('speaks the matched term exactly once, not twice', () => {
    const spoken = getAccessibleMatchContext({
      index: 1, total: 3, query: 'tahliye', snippet: 'karar <mark>tahliye</mark> yönünde'
    });
    // Once in "Aranan ifade", once inside the context sentence -- and the
    // visual <mark> itself is aria-hidden, so no third utterance.
    expect(spoken.match(/tahliye/g)?.length).toBe(2);
  });

  it('strips leading and trailing ellipses so the sentence starts cleanly', () => {
    const spoken = getAccessibleMatchContext({
      index: 1, total: 1, query: 'a', snippet: '…bir metin…'
    });
    expect(spoken.endsWith('Bağlam: bir metin')).toBe(true);
  });
});

describe('snippet helpers', () => {
  it('strips mark tags and collapses whitespace', () => {
    expect(stripHighlight('a  <mark>b</mark>\n c')).toBe('a b c');
  });

  it('extracts the highlighted term', () => {
    expect(extractHighlightedTerm('x <mark>tahliye</mark> y')).toBe('tahliye');
    expect(extractHighlightedTerm('no highlight')).toBe('');
  });
});

describe('A11Y-K — live announcement text', () => {
  it('uses the Turkish sentences the spec requires', () => {
    expect(SEARCH_STATUS_SEARCHING).toBe('Aranıyor.');
    expect(getAccessibleSearchStatus(18)).toBe('18 sonuç bulundu.');
    expect(getAccessibleSearchStatus(0)).toBe(SEARCH_STATUS_NO_RESULTS);
    expect(SEARCH_STATUS_NO_RESULTS).toBe('Sonuç bulunamadı.');
    expect(SEARCH_STATUS_FAILED).toBe('Arama tamamlanamadı.');
  });

  it('never announces a bare number without its noun', () => {
    expect(getAccessibleSearchStatus(1)).toBe('1 sonuç bulundu.');
    expect(getAccessibleSearchStatus(-3)).toBe(SEARCH_STATUS_NO_RESULTS);
  });

  it('describes indexing and document counts in Turkish', () => {
    expect(getAccessibleIndexingStatus(5, 100))
      .toBe('İndeksleniyor. 100 belgeden 5 tanesi tamamlandı.');
    expect(getAccessibleDocumentCount(0)).toBe('Henüz belge indekslenmedi.');
    expect(getAccessibleDocumentCount(2400)).toBe('2.400 belge indekslendi.');
  });
});

describe('A11Y-J — state is carried by text, not colour', () => {
  it('exposes selection state as words', () => {
    expect(getAccessibleFilterState('UDF', true)).toBe('UDF, seçili.');
    expect(getAccessibleFilterState('UDF', false)).toBe('UDF, seçili değil.');
  });

  it('describes the search scope in words', () => {
    expect(getAccessibleScopeState('all', 0)).toBe('Arama kapsamı: bilgisayarın tümü.');
    expect(getAccessibleScopeState('selected', 0))
      .toBe('Arama kapsamı: seçili klasörler. Henüz klasör eklenmedi.');
    expect(getAccessibleScopeState('selected', 3))
      .toBe('Arama kapsamı: seçili klasörler. 3 klasör.');
  });
});

describe('A11Y-F — error messages are Turkish and non-technical', () => {
  it('never exposes a raw exception (spec §26)', () => {
    for (const message of Object.values(ERROR_MESSAGES)) {
      expect(message).toMatch(/^[A-ZÇĞİÖŞÜ]/);
      expect(message.endsWith('.')).toBe(true);
      expect(message).not.toMatch(/Error|error|undefined|null|Exception|ENOENT/);
    }
  });
});
