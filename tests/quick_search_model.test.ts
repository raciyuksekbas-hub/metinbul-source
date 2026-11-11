import { describe, it, expect } from 'vitest';
import {
  formatFolderLocation,
  describeCoverage,
  isCoveragePartial,
  formatIndexTimestamp,
  nextPanelHeight
} from '../src/shared/quick-search-model.js';

describe('formatFolderLocation — where a result lives', () => {
  it('drops the home prefix and joins the folders with " / "', () => {
    expect(formatFolderLocation('/Users/raci/Müvekkiller/2026/Dava/Dava Dilekçesi.docx'))
      .toBe('Müvekkiller / 2026 / Dava');
  });

  it('keeps the deepest folders when the path is longer than the limit', () => {
    expect(formatFolderLocation('/Users/raci/Documents/Büro/Müvekkiller/2026/Dava/x.pdf'))
      .toBe('… / Müvekkiller / 2026 / Dava');
  });

  it('handles Windows paths, drive letter and home included', () => {
    expect(formatFolderLocation('C:\\Users\\Raci\\Belgeler\\Bilirkişi Raporları\\rapor.pdf'))
      .toBe('Belgeler / Bilirkişi Raporları');
  });

  it('drops the mount point for external volumes', () => {
    expect(formatFolderLocation('/Volumes/Arşiv/2019/Karar.udf')).toBe('Arşiv / 2019');
  });

  it('names the home folder itself instead of returning nothing', () => {
    expect(formatFolderLocation('/Users/raci/not.docx')).toBe('Ana klasör');
  });

  it('is empty for an empty path', () => {
    expect(formatFolderLocation('')).toBe('');
  });
});

describe('describeCoverage — "bulamadım" is not "okuyamadım"', () => {
  // The real profile behind the P0 report: the old single sum turned these
  // four numbers into "2.845 belge aranamadı" although 1,791 were searched.
  const realProfile = { indexed: 1791, failed: 16, noText: 259, dataless: 2570 };

  it('states each fact as itself instead of one alarming sum', () => {
    expect(describeCoverage(realProfile)).toBe(
      '1.791 belge arandı · 16 belge işlenemedi · 259 belgede metin yok · 2.570 belge yalnızca bulutta'
    );
    expect(describeCoverage(realProfile)).not.toContain('2.845');
  });

  it('counts only real extraction failures as "işlenemedi"', () => {
    expect(describeCoverage({ indexed: 10, failed: 0, noText: 3, dataless: 5 })).not.toContain('işlenemedi');
  });

  it('has a spoken form with commas and a full stop for the live region', () => {
    expect(describeCoverage(realProfile, { spoken: true })).toBe(
      '1.791 belge arandı, 16 belge işlenemedi, 259 belgede metin yok, 2.570 belge yalnızca bulutta.'
    );
  });

  it('says only what was searched when everything could be read', () => {
    expect(describeCoverage({ indexed: 42, failed: 0, noText: 0, dataless: 0 })).toBe('42 belge arandı');
    expect(isCoveragePartial({ indexed: 42, failed: 0, noText: 0, dataless: 0 })).toBe(false);
    expect(isCoveragePartial(realProfile)).toBe(true);
  });

  it('ignores negative and non-finite input instead of reporting nonsense', () => {
    expect(describeCoverage({ indexed: 5, failed: -1, noText: Number.NaN, dataless: 2 })).toBe('5 belge arandı · 2 belge yalnızca bulutta');
  });
});

describe('formatIndexTimestamp — "Son güncelleme"', () => {
  const now = new Date(2026, 9, 2, 18, 0).getTime(); // 2 Ekim 2026 18:00 local

  it('says "Bugün" for today', () => {
    expect(formatIndexTimestamp(new Date(2026, 9, 2, 14, 32).getTime(), now)).toBe('Bugün 14:32');
  });

  it('says "Dün" for yesterday, with a zero-padded clock', () => {
    expect(formatIndexTimestamp(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe('Dün 09:05');
  });

  it('uses the Turkish month name within the same year', () => {
    expect(formatIndexTimestamp(new Date(2026, 8, 12, 14, 32).getTime(), now)).toBe('12 Eylül 14:32');
  });

  it('shows the year instead of the clock for older dates', () => {
    expect(formatIndexTimestamp(new Date(2025, 11, 30, 10, 0).getTime(), now)).toBe('30 Aralık 2025');
  });

  it('returns nothing for a missing timestamp', () => {
    expect(formatIndexTimestamp(0, now)).toBe('');
    expect(formatIndexTimestamp(Number.NaN, now)).toBe('');
  });
});

describe('nextPanelHeight — grows to a maximum, never jitters', () => {
  const bounds = { min: 58, max: 480 };

  it('fits the content between the compact and maximum heights', () => {
    expect(nextPanelHeight(58, 230.4, bounds, true)).toBe(230);
    expect(nextPanelHeight(58, 10, bounds, true)).toBe(58);
  });

  it('never grows past the maximum, however many results there are', () => {
    expect(nextPanelHeight(58, 4000, bounds, true)).toBe(480);
  });

  it('does not shrink on a selection-only change', () => {
    expect(nextPanelHeight(300, 260, bounds, false)).toBe(300);
    expect(nextPanelHeight(300, 340, bounds, false)).toBe(340);
  });

  it('shrinks again when the result set itself changes', () => {
    expect(nextPanelHeight(300, 120, bounds, true)).toBe(120);
  });
});

describe('Quick Search passages are shown as search() cut them', () => {
  it('adds no ellipsis of its own (search() marks trimmed ends itself)', async () => {
    const fs = await import('fs');
    const card = fs.readFileSync(new URL('../src/renderer/result-card.ts', import.meta.url), 'utf-8');
    expect(card).toContain('aria-hidden="true">${sanitizeSnippet(sn)}</div>');
    const search = fs.readFileSync(new URL('../src/search/search.ts', import.meta.url), 'utf-8');
    expect(search).toContain("${hasLeftEllipsis ? '…' : ''}");
  });
});

import { isQueryTooShort, MIN_QUERY_LENGTH } from '../src/shared/quick-search-model.js';
import { buildFtsQuery } from '../src/search/search.js';

describe('isQueryTooShort — "not searched" is not "not found"', () => {
  const samples = ['', ' ', 'a', 'ab', 'abc', ' ab ', '"ab"', "'a'", 'İz', 'iş', 'işe', 'a b', '  söz  ', '"söz"', 'x y z',
    '“ab”', '“söz”', '„ab“', '«ab»', '“ortaklığın giderilmesi”'];

  it('agrees with the search engine on every sample: too short exactly when buildFtsQuery refuses a non-empty query', () => {
    for (const q of samples) {
      const engineRefuses = buildFtsQuery(q) === null;
      const nonEmpty = q.trim().length > 0;
      expect(isQueryTooShort(q), JSON.stringify(q)).toBe(nonEmpty && engineRefuses);
    }
  });

  it('uses the trigram minimum of three characters', () => {
    expect(MIN_QUERY_LENGTH).toBe(3);
    expect(isQueryTooShort('ab')).toBe(true);
    expect(isQueryTooShort('abc')).toBe(false);
  });

  it('treats an empty field as idle, not as too short', () => {
    expect(isQueryTooShort('')).toBe(false);
    expect(isQueryTooShort('   ')).toBe(false);
  });
});
