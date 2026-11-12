import * as fs from 'fs';
import { DOCX_MAX_FILE_BYTES } from './limits.js';
import { extractDocxText } from './ooxml.js';
import { readFileWithinLimit } from './read-file.js';

export async function extractDocx(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    return await extractDocxText(readFileWithinLimit(filePath, DOCX_MAX_FILE_BYTES));
  } catch (error: any) {
    throw new Error(`Failed to extract DOCX (${filePath}): ${error?.message || error}`);
  }
}
