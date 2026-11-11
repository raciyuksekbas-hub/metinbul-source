import { describe, it, expect } from 'vitest';
import { normalizeForSearch } from '../src/db/database.js';
import { generateCustomSnippet } from '../src/search/search.js';

describe('Normalization & Offset Invariance Verification (v0.2.0 Section F)', () => {
  it('should verify 1:1 character length invariance across all Turkish uppercase/lowercase characters', () => {
    const turkishChars = ['İ', 'i', 'I', 'ı', 'Ş', 'ş', 'Ğ', 'ğ', 'Ç', 'ç', 'Ö', 'ö', 'Ü', 'ü'];
    for (const ch of turkishChars) {
      const lower = ch.toLocaleLowerCase('tr-TR');
      expect(lower.length).toBe(ch.length);
      expect(lower.length).toBe(1);
    }
  });

  it('should verify correct NFC normalization of decomposed Unicode characters', () => {
    // NFD decomposed 'S' + combining cedilla (U+0327)
    const decomposedS = 'S\u0327';
    expect(decomposedS.length).toBe(2);
    const nfcS = decomposedS.normalize('NFC');
    expect(nfcS.length).toBe(1);
    expect(nfcS).toBe('Ş');

    // NFD decomposed 'I' + combining dot above (U+0307)
    const decomposedI = 'I\u0307';
    expect(decomposedI.length).toBe(2);
    const nfcI = decomposedI.normalize('NFC');
    expect(nfcI.length).toBe(1);
    expect(nfcI).toBe('İ');
    expect(nfcI.toLocaleLowerCase('tr-TR')).toBe('i');
  });

  it('should verify exact match offset mapping on real Turkish legal text', () => {
    const rawText = 'Yargıtay Hukuk Genel Kurulu Kararı uyarınca İŞBU SÖZLEŞMENİN FESHİ ve TAZMİNAT talebi değerlendirilmiştir.';
    const query = 'işbu sözleşmenin feshi';

    const snippet = generateCustomSnippet(rawText, query, 120);
    expect(snippet).toContain('<mark>İŞBU SÖZLEŞMENİN FESHİ</mark>');
  });

  it('should verify offset invariance with apostrophes and punctuation', () => {
    const text = "Ankara 4. Asliye Ticaret Mahkemesi'nin 2024/123 E. sayılı dosyasında İhtiyati Tedbir kararı verilmiştir.";
    const query = "Mahkemesi'nin";

    const snippet = generateCustomSnippet(text, query, 100);
    expect(snippet).toContain("<mark>Mahkemesi'nin</mark>");
  });

  it('should verify offset invariance with emojis and surrogate pairs', () => {
    const text = 'Belge özeti 📄⚖️ Yargıtay 11. Hukuk Dairesi ilamı.';
    const query = 'Yargıtay 11.';

    const snippet = generateCustomSnippet(text, query, 100);
    expect(snippet).toContain('<mark>Yargıtay 11.</mark>');
  });

  it('should verify case folding for Turkish dotted and dotless I in both directions', () => {
    expect(normalizeForSearch('İSTANBUL')).toBe('istanbul');
    expect(normalizeForSearch('IĞDIR')).toBe('ığdır');
    expect(normalizeForSearch('DİYARBAKIR')).toBe('diyarbakır');
    expect(normalizeForSearch('IŞIK')).toBe('ışık');
    expect(normalizeForSearch('İLİ')).toBe('ili');
  });
});
