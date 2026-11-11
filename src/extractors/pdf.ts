import * as fs from 'fs';

// The PDF's text layer, page by page. Text recognition decides per page:
// a scanned page often carries a line or two of real text (a scanner stamp,
// a page number, an e-signature footer) on top of the picture of its content.
export async function extractPdfPages(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const dataBuffer = fs.readFileSync(filePath);

  try {
    const pdfModule = await import('pdf-parse');
    const pdf = (pdfModule as any).default || pdfModule;

    // Check if pdf-parse v2 PDFParse class exists
    if (pdf.PDFParse || (pdfModule as any).PDFParse) {
      const PDFParseClass = pdf.PDFParse || (pdfModule as any).PDFParse;
      const parser = new PDFParseClass({ data: dataBuffer });
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
      const data = await pdf(dataBuffer);
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
