import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { extract, extractDocx, extractPdf, extractUdf, extractDoc } from '../../src/extractors/index.js';
import { setupFixtures, FIXTURES_DIR } from '../fixtures/create_fixtures.js';

describe('Text Extractors Core (Phase 1)', () => {
  beforeAll(() => {
    setupFixtures();
  });

  describe('DOCX Extractor', () => {
    it('should extract characteristic Turkish text from a valid DOCX file', async () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.docx');
      const text = await extract(filePath);
      expect(text).toContain('İSTANBUL BÖLGE ADLİYE MAHKEMESİ');
      expect(text).toContain('kıdem ve ihbar tazminatı');
    });

    it('should throw when extracting a corrupted DOCX file', async () => {
      const filePath = path.join(FIXTURES_DIR, 'corrupt.docx');
      await expect(extract(filePath)).rejects.toThrow();
    });
  });

  describe('PDF Extractor', () => {
    it('should extract characteristic text from a valid PDF file', async () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.pdf');
      const text = await extract(filePath);
      expect(text).toContain('ANKARA NOBETCI IS MAHKEMESINE');
    });

    it('should throw when extracting a corrupted PDF file', async () => {
      const filePath = path.join(FIXTURES_DIR, 'corrupt.pdf');
      await expect(extract(filePath)).rejects.toThrow();
    });
  });

  describe('UDF Extractor', () => {
    it('should extract characteristic Turkish text from a valid UDF file (ZIP + XML)', async () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.udf');
      const text = await extract(filePath);
      expect(text).toContain('İZMİR 3. İCRA HUKUK MAHKEMESİ GEREKÇELİ KARAR');
      expect(text).toContain('haczedilmezlik şikayetinin');
    });

    it('should throw when extracting a corrupted UDF file', async () => {
      const filePath = path.join(FIXTURES_DIR, 'corrupt.udf');
      await expect(extract(filePath)).rejects.toThrow();
    });
  });

  describe('DOC Extractor', () => {
    it('should throw on a corrupted or non-existent DOC file', async () => {
      const filePath = path.join(FIXTURES_DIR, 'corrupt.doc');
      fs.writeFileSync(filePath, 'NON OLE2 CONTENT');
      await expect(extractDoc(filePath)).rejects.toThrow();
      fs.unlinkSync(filePath);
    });

    it('should extract text if a real sample.doc is present', async () => {
      const filePath = path.join(FIXTURES_DIR, 'sample.doc');
      if (fs.existsSync(filePath)) {
        const text = await extract(filePath);
        expect(text.length).toBeGreaterThan(0);
      }
    });
  });

  describe('General Extractor Dispatcher & Error Handling', () => {
    it('should throw on a non-existent file', async () => {
      const nonExistent = path.join(FIXTURES_DIR, 'does_not_exist.docx');
      await expect(extract(nonExistent)).rejects.toThrow(/not found/i);
    });

    it('should throw on an unsupported extension', async () => {
      const unsupported = path.join(FIXTURES_DIR, 'unsupported.txt');
      await expect(extract(unsupported)).rejects.toThrow(/unsupported file extension/i);
    });
  });
});
