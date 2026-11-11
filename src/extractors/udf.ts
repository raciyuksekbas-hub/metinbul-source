import * as fs from 'fs';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  cdataPropName: '__cdata'
});

function collectTextFromXmlObject(node: any, list: string[] = []): string[] {
  if (node === null || node === undefined) {
    return list;
  }
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed) {
      list.push(trimmed);
    }
  } else if (typeof node === 'number' || typeof node === 'boolean') {
    list.push(String(node));
  } else if (Array.isArray(node)) {
    for (const item of node) {
      collectTextFromXmlObject(item, list);
    }
  } else if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_')) {
        // Skip XML attributes
        continue;
      }
      collectTextFromXmlObject(value, list);
    }
  }
  return list;
}

export async function extractUdf(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    let xmlContent = '';

    // Attempt 1: Try reading as a ZIP archive (standard UYAP UDF format)
    try {
      const zip = new AdmZip(filePath);
      const zipEntries = zip.getEntries();
      
      // First look for content.xml
      let contentEntry = zipEntries.find(e => e.entryName.toLowerCase() === 'content.xml');
      
      // If not found, look for any .xml entry
      if (!contentEntry) {
        contentEntry = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.xml'));
      }

      if (contentEntry) {
        xmlContent = contentEntry.getData().toString('utf8');
      }
    } catch {
      // If AdmZip fails, file might be direct uncompressed XML
    }

    // Attempt 2: If not in zip, check if file is raw XML
    if (!xmlContent) {
      const rawContent = fs.readFileSync(filePath, 'utf8');
      if (rawContent.trim().startsWith('<')) {
        xmlContent = rawContent;
      }
    }

    if (!xmlContent) {
      throw new Error('Invalid UDF file format: No XML content found inside archive or file');
    }

    // Parse XML using fast-xml-parser
    const parsedXml = xmlParser.parse(xmlContent);
    const textPieces = collectTextFromXmlObject(parsedXml);
    return textPieces.join(' ').trim();
  } catch (error: any) {
    throw new Error(`Failed to extract UDF (${filePath}): ${error?.message || error}`);
  }
}
