import * as path from 'path';
import * as fs from 'fs';
import { extractDocx } from './docx.js';
import { extractPdf, extractPdfPages } from './pdf.js';
import { extractDoc } from './doc.js';
import { extractUdf } from './udf.js';
import { assertContentLocallyAvailable } from '../scanner/windows-availability.js';

export const SUPPORTED_EXTENSIONS = new Set(['.doc', '.docx', '.pdf', '.udf']);

export async function extract(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file extension '${ext}' for file: ${filePath}`);
  }

  // Single choke point for every format. Each extractor below opens the file's
  // content, which on Windows is what hydrates a cloud placeholder, so the
  // availability invariant is re-asserted here rather than trusted from the
  // caller. A new extractor added to the switch inherits this automatically.
  await assertContentLocallyAvailable(filePath);

  switch (ext) {
    case '.docx':
      return await extractDocx(filePath);
    case '.pdf':
      return await extractPdf(filePath);
    case '.doc':
      return await extractDoc(filePath);
    case '.udf':
      return await extractUdf(filePath);
    default:
      throw new Error(`Unhandled supported extension '${ext}' for file: ${filePath}`);
  }
}

// A PDF's text layer page by page, under the same availability rule as
// extract(): the indexer uses it to decide which pages need text recognition.
export async function extractPdfPageTexts(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  await assertContentLocallyAvailable(filePath);
  return await extractPdfPages(filePath);
}

export { extractDocx, extractPdf, extractPdfPages, extractDoc, extractUdf };
