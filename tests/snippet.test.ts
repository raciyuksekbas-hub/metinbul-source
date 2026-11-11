import { describe, it, expect } from 'vitest';
import { generateCustomSnippet, generateSnippets } from '../src/search/search.js';

describe('Custom Snippet Engine (v0.2.0)', () => {
  it('should generate clean deterministic snippet for user acceptance sample', () => {
    const documentText = `Başvurucu tarafın belirtmiş olduğu aşağıdaki taşınmazlar hakkında ortaklığın giderilmesi talepli uyuşmazlık konusunda; karşı tarafların iletişim bilgileri başvurucudan ve bürodan istenmiş olup iletişime geçilmiştir.`;
    const query = 'ortaklığın giderilmesi';

    const snippet = generateCustomSnippet(documentText, query, 140);

    expect(snippet).toContain('<mark>ortaklığın giderilmesi</mark>');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('aşağıdaki taşınmazlar hakkında <mark>ortaklığın giderilmesi</mark> talepli uyuşmazlık konusunda;');
  });

  it('should handle Turkish case-insensitive matching correctly', () => {
    const text = 'Bu kararda İSTANBUL BÖLGE ADLİYE MAHKEMESİ tarafından verilen hüküm incelenmiştir.';
    const query = 'istanbul bölge';

    const snippet = generateCustomSnippet(text, query, 100);
    expect(snippet).toContain('<mark>İSTANBUL BÖLGE</mark>');
    expect(snippet).toContain('MAHKEMESİ');
  });

  it('should collapse newlines, tabs, and multi-spaces into single clean spaces', () => {
    const text = `İlk satır metni\n\r\n\t  burada yer alan    önemli bilgi   \n  sonuç cümlesi.`;
    const query = 'önemli bilgi';

    const snippet = generateCustomSnippet(text, query, 80);
    expect(snippet).toContain('<mark>önemli bilgi</mark>');
    expect(snippet).not.toContain('\n');
    expect(snippet).not.toContain('\t');
    expect(snippet).not.toContain('   ');
    expect(snippet).toContain('burada yer alan <mark>önemli bilgi</mark> sonuç cümlesi.');
  });

  it('should not add leading ellipsis when match is near the beginning of text', () => {
    const text = 'Sözleşmenin feshi nedeniyle açılan tazminat davasında tarafların iddiaları dinlenmiştir.';
    const query = 'Sözleşmenin feshi';

    const snippet = generateCustomSnippet(text, query, 100);
    expect(snippet.startsWith('<mark>Sözleşmenin feshi</mark>')).toBe(true);
    expect(snippet.startsWith('…')).toBe(false);
  });

  it('should not add trailing ellipsis when match is near the end of text', () => {
    const text = 'Tüm dosya kapsamı incelenerek davanın kabulüne karar verildi.';
    const query = 'karar verildi';

    const snippet = generateCustomSnippet(text, query, 100);
    expect(snippet.endsWith('<mark>karar verildi</mark>.')).toBe(true);
    expect(snippet.endsWith('…')).toBe(false);
  });

  it('should snap to whole word boundaries without cutting words in half', () => {
    const text = 'Uzun bir hukuki inceleme neticesinde hakkaniyet kuralları gereğince karar tesis edilmiştir.';
    const query = 'hakkaniyet kuralları';

    const snippet = generateCustomSnippet(text, query, 60);
    expect(snippet).toContain('<mark>hakkaniyet kuralları</mark>');
    expect(snippet.startsWith('…inceleme') || snippet.startsWith('…neticesinde') || snippet.startsWith('…hakkaniyet')).toBe(true);
  });

  it('should handle empty or missing content/query gracefully', () => {
    expect(generateCustomSnippet('', 'test')).toBe('');
    expect(generateCustomSnippet('   ', 'test')).toBe('');
    expect(generateCustomSnippet('Herhangi bir metin', '')).toBe('Herhangi bir metin');
  });
});

describe('Multiple Match Passages (generateSnippets, spec §9)', () => {
  it('one document with distinct matches ("hemşire" and "hemşirelik") produces multiple distinct passages', () => {
    const filler = 'Dosya kapsamında yer alan diğer hususlar ayrıca değerlendirilmiş olup taraflarca sunulan deliller incelenmiştir. ';
    const text = 'Davacı taraf hemşire olarak görev yapmaktadır. ' + filler.repeat(4) +
      'Uzman hemşirelik hizmetlerinin sunulduğu süreçte hastane kayıtları incelenmiştir. ' + filler.repeat(4) +
      'Yeniden değerlendirmede uzman hemşire tarafından takip edildiği tespit edilmiştir.';
    const { snippets, matchCount } = generateSnippets(text, 'hemşire', { maxSnippets: 3 });

    expect(matchCount).toBeGreaterThanOrEqual(2);
    expect(snippets.length).toBeGreaterThanOrEqual(2);
    expect(snippets.length).toBeLessThanOrEqual(3);
    for (const s of snippets) {
      expect(s.toLowerCase()).toContain('<mark>hemşire');
    }
  });

  it('defaults to a max of 3 displayed snippets even with many occurrences, but reports the true matchCount', () => {
    const repeated = Array(10).fill('tazminat davası açıldı ve tazminat talebi incelendi.').join(' ');
    const { snippets, matchCount } = generateSnippets(repeated, 'tazminat', { maxSnippets: 3 });

    expect(snippets.length).toBeLessThanOrEqual(3);
    expect(matchCount).toBeGreaterThan(3);
  });

  it('does not duplicate/collapse near-identical overlapping windows into separate snippets', () => {
    const text = 'kısa metin tazminat kısa metin';
    const { snippets } = generateSnippets(text, 'tazminat', { maxSnippets: 3, budget: 200 });
    // Only one real occurrence in a short doc -> exactly one snippet, not
    // an artificially duplicated one from re-scanning the same window.
    expect(snippets.length).toBe(1);
  });

  it('falls back to a single non-highlighted snippet when there is no match at all', () => {
    const { snippets, matchCount } = generateSnippets('Bu belgede aranan ifade yok.', 'bulunamayan_ifade');
    expect(matchCount).toBe(0);
    expect(snippets.length).toBe(1);
    expect(snippets[0]).not.toContain('<mark>');
  });

  it('exact mode only counts boundary-valid occurrences (not substring hits inside a larger word)', () => {
    const text = 'zilyet olarak kabul edildi. Ancak zilyetlik iddiası reddedildi. Yeniden zilyet sayıldı.';
    const inexact = generateSnippets(text, 'zilyet', { exact: false, maxSnippets: 5 });
    const exact = generateSnippets(text, 'zilyet', { exact: true, maxSnippets: 5 });

    // Infix mode: "zilyet" is a substring of "zilyetlik" too -> 3 occurrences.
    expect(inexact.matchCount).toBe(3);
    // Exact mode: "zilyetlik" is excluded -> only the 2 standalone occurrences.
    expect(exact.matchCount).toBe(2);
  });
});
