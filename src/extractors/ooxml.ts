import mammoth from 'mammoth';
import {
  DOCX_MAX_PART_BYTES,
  DOCX_MAX_TOTAL_PART_BYTES,
  DOCX_MAX_XML_ATTRIBUTES,
  DOCX_MAX_XML_ELEMENTS
} from './limits.js';
import { BoundedZip } from './zip.js';

// Text of a Word (.docx) package already in memory.
//
// mammoth normally opens the package with JSZip, which inflates any part it
// is asked for with no limit. Which parts it asks for is decided by the
// package's own relationships, so a check on, say, every *.xml entry would
// not do: the main document can be any entry the package names. Instead
// mammoth is handed this reader (its `file` input, the same exists/read
// interface it builds around JSZip), and every part mammoth opens comes
// through the bounded ZIP reader and the budgets below.

export interface DocxLimits {
  maxPartBytes: number;
  maxTotalPartBytes: number;
  maxXmlElements: number;
  maxXmlAttributes: number;
}

export const DEFAULT_DOCX_LIMITS: DocxLimits = {
  maxPartBytes: DOCX_MAX_PART_BYTES,
  maxTotalPartBytes: DOCX_MAX_TOTAL_PART_BYTES,
  maxXmlElements: DOCX_MAX_XML_ELEMENTS,
  maxXmlAttributes: DOCX_MAX_XML_ATTRIBUTES
};

// Elements are counted as "<" followed by a name, attributes as "=" anywhere
// in the part. Both can over-count (an "=" in the text), never under-count, so
// the DOM mammoth builds stays within the budget.
function countMarkup(xml: string): { elements: number; attributes: number } {
  let elements = 0;
  for (let i = xml.indexOf('<'); i !== -1; i = xml.indexOf('<', i + 1)) {
    const next = xml.charCodeAt(i + 1);
    if (next !== 0x2f /* / */ && next !== 0x21 /* ! */ && next !== 0x3f /* ? */) elements++;
  }
  let attributes = 0;
  for (let i = xml.indexOf('='); i !== -1; i = xml.indexOf('=', i + 1)) attributes++;
  return { elements, attributes };
}

export function openDocxPackage(zip: BoundedZip, limits: DocxLimits = DEFAULT_DOCX_LIMITS) {
  let totalBytes = 0;
  let elements = 0;
  let attributes = 0;

  // Like JSZip's zip.file(name): a file entry, never a directory.
  const fileEntry = (name: string) => {
    const entry = zip.get(name);
    return entry && !entry.isDirectory ? entry : undefined;
  };

  const readPart = (name: string, encoding?: string): string | Uint8Array => {
    const entry = fileEntry(name);
    if (!entry) throw new Error(`DOCX part "${name}" is missing`);
    const data = zip.read(entry, limits.maxPartBytes);
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalPartBytes) {
      throw new Error(`DOCX parts add up to more than ${limits.maxTotalPartBytes} bytes`);
    }
    if (encoding === 'base64') {
      return data.toString('base64');
    }
    if (!encoding) {
      return data;
    }
    const text = new TextDecoder(encoding).decode(data);
    // Office Open XML forbids DTDs in a package (ECMA-376 Part 2), so a
    // DOCTYPE or ENTITY can only be an attack.
    if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) {
      throw new Error(`DOCX part "${name}" declares a DOCTYPE or ENTITY, which is not allowed`);
    }
    const markup = countMarkup(text);
    elements += markup.elements;
    attributes += markup.attributes;
    if (elements > limits.maxXmlElements) {
      throw new Error(`DOCX has more than ${limits.maxXmlElements} XML elements`);
    }
    if (attributes > limits.maxXmlAttributes) {
      throw new Error(`DOCX has more than ${limits.maxXmlAttributes} XML attributes`);
    }
    return text;
  };

  return {
    exists(name: string): boolean {
      return fileEntry(name) !== undefined;
    },
    read(name: string, encoding?: string): Promise<string | Uint8Array> {
      return new Promise(resolve => resolve(readPart(name, encoding)));
    },
    write(): never {
      throw new Error('DOCX package is read-only');
    },
    toArrayBuffer(): never {
      throw new Error('DOCX package is read-only');
    }
  };
}

export async function extractDocxText(data: Buffer, limits: DocxLimits = DEFAULT_DOCX_LIMITS): Promise<string> {
  const docxFile = openDocxPackage(new BoundedZip(data), limits);
  // `file` is mammoth's own input for an opened package (lib/unzip.js); its
  // typings list only path/buffer/arrayBuffer. Should a mammoth update drop
  // it, every DOCX fails with "Could not find file in options" (tested).
  const input = { file: docxFile } as unknown as { buffer: Buffer };
  const result = await mammoth.extractRawText(input);
  return (result.value || '').trim();
}
