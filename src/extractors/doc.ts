import * as fs from 'fs';
// word-extractor does not ship official TS types
// @ts-ignore
import WordExtractor from 'word-extractor';

const extractor = new WordExtractor();

export async function extractDoc(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    const extracted = await extractor.extract(filePath);
    const body = extracted.getBody() || '';
    return body.trim();
  } catch (error: any) {
    throw new Error(`Failed to extract DOC (${filePath}): ${error?.message || error}`);
  }
}
