import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppDatabase } from '../src/db/database.js';
import { search, isExactPhraseQuery, extractExactPhrase, hasExactWordMatch } from '../src/search/search.js';

describe('Quoted Exact / Whole-Word Search (spec §8)', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = new AppDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function seed(path: string, content: string) {
    db.upsertDocument({
      path,
      filename: path.split('/').pop() || path,
      extension: '.docx',
      mtime: Date.now(),
      size: content.length,
      content,
      index_status: 'indexed'
    });
  }

  describe('isExactPhraseQuery / extractExactPhrase', () => {
    it('detects a fully-quoted query as exact mode', () => {
      expect(isExactPhraseQuery('"zilyet"')).toBe(true);
      expect(isExactPhraseQuery('  "zilyet"  ')).toBe(true);
      expect(isExactPhraseQuery('"ortaklığın giderilmesi"')).toBe(true);
    });

    it('does not treat a partially-quoted or unquoted query as exact mode', () => {
      expect(isExactPhraseQuery('zilyet')).toBe(false);
      expect(isExactPhraseQuery('foo "bar baz" qux')).toBe(false);
      expect(isExactPhraseQuery('"zilyet')).toBe(false);
      expect(isExactPhraseQuery('zilyet"')).toBe(false);
      expect(isExactPhraseQuery('')).toBe(false);
    });

    it('extracts the inner phrase without the surrounding quotes', () => {
      expect(extractExactPhrase('"zilyet"')).toBe('zilyet');
      expect(extractExactPhrase('  "ortaklığın giderilmesi"  ')).toBe('ortaklığın giderilmesi');
    });
  });

  describe('single-word exact match (§8 example: "zilyet")', () => {
    beforeEach(() => {
      seed('/docs/a.docx', 'Taraf zilyet olarak kabul edilmiştir.');
      seed('/docs/b.docx', 'Bu husus zilyetlik iddiasına dayanmaktadır.');
      seed('/docs/c.docx', 'Zilyetliğin devri söz konusu değildir.');
      seed('/docs/d.docx', 'Zilyetliğe ilişkin talep reddedilmiştir.');
    });

    it('"zilyet" (exact) matches only the standalone word', () => {
      const results = search('"zilyet"', db);
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('/docs/a.docx');
    });

    it('zilyet (no quotes) keeps the existing infix behavior and matches all four', () => {
      const results = search('zilyet', db);
      const paths = results.map(r => r.path).sort();
      expect(paths).toEqual(['/docs/a.docx', '/docs/b.docx', '/docs/c.docx', '/docs/d.docx']);
    });
  });

  describe('single-word exact match (§8 example: "doktor")', () => {
    beforeEach(() => {
      seed('/docs/a.docx', 'Muayene sonrası doktor raporu düzenlenmiştir.');
      seed('/docs/b.docx', 'Doktorun görüşü alınmıştır.');
      seed('/docs/c.docx', 'Hasta doktora sevk edilmiştir.');
      seed('/docs/d.docx', 'Doktorluk mesleği icra edilmektedir.');
    });

    it('"doktor" (exact) matches only the standalone word, not doktorun/doktora/doktorluk', () => {
      const results = search('"doktor"', db);
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('/docs/a.docx');
    });
  });

  describe('exact phrase match (§8 example: "ortaklığın giderilmesi")', () => {
    it('matches only the exact word sequence, not a reordered or partial one', () => {
      seed('/docs/exact.docx', 'Başvurucu tarafından ortaklığın giderilmesi talep edilmiştir.');
      seed('/docs/partial.docx', 'Ortaklığın sona erdirilmesi ve giderilmesi ayrı taleplerdir.');
      seed('/docs/unrelated.docx', 'Tazminat davası açılmıştır.');

      const results = search('"ortaklığın giderilmesi"', db);
      expect(results.length).toBe(1);
      expect(results[0].path).toBe('/docs/exact.docx');
    });
  });

  describe('punctuation boundaries', () => {
    it('"doktor" matches when immediately followed by a comma ("Doktor,")', () => {
      seed('/docs/comma.docx', 'Doktor, hastayı muayene etti.');
      const results = search('"doktor"', db);
      expect(results.length).toBe(1);
    });

    it('"doktor" does not match "doktorun" even with surrounding punctuation', () => {
      seed('/docs/comma2.docx', 'Doktorun, hastayı muayene ettiği belirtildi.');
      const results = search('"doktor"', db);
      expect(results.length).toBe(0);
    });
  });

  describe('Turkish case (İ/I/ı/i) and Unicode normalization', () => {
    it('matches case-insensitively per Turkish locale rules', () => {
      seed('/docs/upper.docx', 'İSTANBUL şehrinde ikamet etmektedir.');
      const results = search('"istanbul"', db);
      expect(results.length).toBe(1);
    });

    it('does not conflate dotted İ/i with dotless I/ı as substrings across word boundaries', () => {
      seed('/docs/dotless.docx', 'Bu konuda ılık bir yaklaşım sergilenmiştir.');
      // "ılık" must not satisfy an exact search for "ılı" (would be a
      // substring-inside-a-larger-word match, same rule as zilyet/zilyetlik).
      const results = search('"ılı"', db);
      expect(results.length).toBe(0);
    });

    it('handles NFC vs NFD input equivalently', () => {
      const nfc = 'Çiçek'.normalize('NFC');
      const nfd = 'Çiçek'.normalize('NFD');
      seed('/docs/nfc.docx', `Bahçede ${nfc} yetişmektedir.`);

      const resultsFromNfd = search(`"${nfd}"`, db);
      expect(resultsFromNfd.length).toBe(1);
    });
  });

  describe('security / robustness', () => {
    it('does not throw or misbehave on FTS-special characters inside an exact query', () => {
      seed('/docs/special.docx', 'Normal bir belge içeriği.');
      expect(() => search('"NEAR(tazminat, 5)"', db)).not.toThrow();
      expect(() => search('"NOT AND OR"', db)).not.toThrow();
      expect(() => search('"karar::column"', db)).not.toThrow();
      expect(() => search('""', db)).not.toThrow();
      expect(() => search('"', db)).not.toThrow();
    });

    it('a bare 2-character exact phrase (below trigram minimum) returns no results, not an error', () => {
      seed('/docs/short.docx', 'ab test içeriği.');
      expect(search('"ab"', db)).toEqual([]);
    });
  });

  describe('hasExactWordMatch (unit-level)', () => {
    it('mirrors the search()-level behavior directly', () => {
      expect(hasExactWordMatch('zilyet olarak kabul edildi', 'zilyet')).toBe(true);
      expect(hasExactWordMatch('zilyetlik iddiası', 'zilyet')).toBe(false);
      expect(hasExactWordMatch('', 'zilyet')).toBe(false);
      expect(hasExactWordMatch('zilyet', '')).toBe(false);
    });
  });
});
