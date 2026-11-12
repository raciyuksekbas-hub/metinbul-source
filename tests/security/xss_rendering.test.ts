// A document's name, folder and text come from whoever wrote the document.
// What the result list puts into innerHTML must never become markup -- except
// the <mark> MetinBul itself adds around a match.
import { describe, it, expect } from 'vitest';
import { AppDatabase } from '../../src/db/database.js';
import { runSearch } from '../../src/search/search-outcome.js';
import { escapeHtml, sanitizeSnippet } from '../../src/renderer/result-card.js';

const PAYLOADS = [
  '<img src=x onerror="alert(1)">',
  '<script>alert(document.domain)</script>',
  '<svg/onload=alert(1)>',
  '"><iframe src="javascript:alert(1)">',
  "'><a href='javascript:alert(1)'>tıkla</a>",
  '<mark onclick="alert(1)">işaret</mark>',
  '</mark><img src=x onerror=alert(1)><mark>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '<style>body{display:none}</style>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'
];

// Any tag left after rendering, other than a bare <mark> or </mark>.
const FOREIGN_TAG = /<(?!\/?mark>)/i;

describe('what reaches innerHTML', () => {
  it('escapeHtml leaves no tag and no way out of an attribute', () => {
    for (const payload of PAYLOADS) {
      const out = escapeHtml(payload);
      expect(out, payload).not.toMatch(/[<>"']/);
    }
  });

  it('sanitizeSnippet lets through only a bare <mark>', () => {
    for (const payload of PAYLOADS) {
      expect(sanitizeSnippet(`önce ${payload} sonra`), payload).not.toMatch(FOREIGN_TAG);
    }
    expect(sanitizeSnippet('a <mark>b</mark> c')).toBe('a <mark>b</mark> c');
  });

  it('a hostile document found by search renders as text', () => {
    const db = new AppDatabase(':memory:');
    const hostileName = '<img src=x onerror=alert(1)>dilekçe.udf';
    db.upsertDocument({
      path: `/Belgeler/<svg onload=alert(1)>/${hostileName}`,
      filename: hostileName,
      extension: '.udf',
      mtime: 1,
      size: 1,
      content: `Sayın Mahkeme ${PAYLOADS.join(' tazminat ')} tazminat talebimiz`,
      index_status: 'indexed'
    });

    for (const query of ['tazminat', 'onerror', 'alert', 'script', 'mark']) {
      const outcome = runSearch(query, db);
      expect(outcome.results.length, query).toBeGreaterThan(0);
      for (const result of outcome.results) {
        for (const snippet of [result.snippet, ...(result.snippets ?? [])]) {
          expect(sanitizeSnippet(snippet), `${query}: ${snippet}`).not.toMatch(FOREIGN_TAG);
        }
        expect(escapeHtml(result.filename)).not.toMatch(/[<>"']/);
        expect(escapeHtml(result.path)).not.toMatch(/[<>"']/);
      }
    }
    db.close();
  });
});
