import * as fs from 'fs';
import { PDF_MAX_FILE_BYTES } from './limits.js';
import { readFileWithinLimit } from './read-file.js';
import { preparePdfjsForTextOnly } from './pdfjs-env.js';

// The PDF's text layer, page by page. Text recognition decides per page:
// a scanned page often carries a line or two of real text (a scanner stamp,
// a page number, an e-signature footer) on top of the picture of its content.
export async function extractPdfPages(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    const fileData = readFileWithinLimit(filePath, PDF_MAX_FILE_BYTES);
    // A plain Uint8Array over the file's own memory: pdf-parse copies a Buffer
    // before handing it on, which would hold the PDF in memory twice.
    const dataBuffer = new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength);

    preparePdfjsForTextOnly();
    const pdfModule = await import('pdf-parse');
    const pdf = (pdfModule as any).default || pdfModule;

    // Check if pdf-parse v2 PDFParse class exists
    if (pdf.PDFParse || (pdfModule as any).PDFParse) {
      const PDFParseClass = pdf.PDFParse || (pdfModule as any).PDFParse;
      const parser = new PDFParseClass({
        data: dataBuffer,
        // Never compile document-supplied code (pdf.js uses eval only as a
        // speed-up for PDF functions, which plain text extraction does not
        // need; CVE-2024-4367 came through that path).
        isEvalSupported: false
      });
      try {
        const result = await parser.getText();
        if (result && Array.isArray(result.pages)) {
          return result.pages.map((p: any) => (p.text || '').trim());
        }
        return [(result?.text || '').trim()];
      } finally {
        if (typeof parser.destroy === 'function') {
          await parser.destroy();
        }
      }
    } else if (typeof pdf === 'function') {
      // Legacy pdf-parse v1 function: no page boundaries.
      const data = await pdf(fileData);
      return [(data.text || '').trim()];
    } else {
      throw new Error('Unsupported pdf-parse module interface');
    }
  } catch (error: any) {
    throw new Error(`Failed to extract PDF (${filePath}): ${error?.message || error}`);
  }
}

export async function extractPdf(filePath: string): Promise<string> {
  return (await extractPdfPages(filePath)).join('\n').trim();
}
