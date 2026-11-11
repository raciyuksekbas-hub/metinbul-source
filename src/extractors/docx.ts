import mammoth from 'mammoth';
import * as fs from 'fs';

export async function extractDocx(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return (result.value || '').trim();
  } catch (error: any) {
    throw new Error(`Failed to extract DOCX (${filePath}): ${error?.message || error}`);
  }
}
