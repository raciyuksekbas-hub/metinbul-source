import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import {
  UDF_MAX_FILE_BYTES,
  UDF_MAX_XML_BYTES,
  UDF_MAX_XML_DEPTH,
  UDF_MAX_XML_NODES,
  UDF_MAX_XML_TEXT_RUN
} from './limits.js';
import { readFileWithinLimit } from './read-file.js';
import { BoundedZip } from './zip.js';

const xmlParser = new XMLParser({
  // Attributes never reach the extracted text (the walk below skips them), so
  // they are not built at all: less memory, nothing parsed for nothing.
  ignoreAttributes: true,
  trimValues: true,
  cdataPropName: '__cdata',
  htmlEntities: false,
  // Callbacks get a matcher instead of a path string rebuilt for every node.
  jPath: false,
  // A UDF is about 5 levels deep; deeper input fails instead of recursing.
  maxNestedTags: UDF_MAX_XML_DEPTH,
  processEntities: {
    // Kept on for the five predefined XML entities (&amp; &lt; &gt; &quot;
    // &apos;). Declared entities cannot occur: a DOCTYPE is refused before
    // parsing. The limits below are a second line should one ever get through.
    enabled: true,
    maxEntityCount: 16,
    maxEntitySize: 1024,
    maxExpansionDepth: 2,
    // Only replacements longer than their reference count here, which the
    // predefined entities never are.
    maxExpandedLength: 100_000,
    // Counts every &amp; as well, so it stays unbounded: those never add text.
    maxTotalExpansions: Infinity
  }
});

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_BANG = 0x21;
const CH_DQUOTE = 0x22;
const CH_SQUOTE = 0x27;
const CH_DASH = 0x2d;
const CH_SLASH = 0x2f;
const CH_GT = 0x3e;
const CH_QMARK = 0x3f;
const CH_UPPER_D = 0x44;
const CH_LBRACKET = 0x5b;

const textRunTooLong = () =>
  new Error(`UDF XML has a run of more than ${UDF_MAX_XML_TEXT_RUN} characters outside CDATA`);

// The tag body from start to its closing ">" (or "?>"), skipping quoted
// attribute values, the way fast-xml-parser reads a tag expression.
function scanTag(xml: string, start: number, processingInstruction: boolean) {
  let quote = 0;
  let tabs = 0;
  let tokens = 0;
  for (let j = start; j < xml.length; j++) {
    const c = xml.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === CH_DQUOTE || c === CH_SQUOTE) {
      quote = c;
    } else if (processingInstruction ? c === CH_QMARK && xml.charCodeAt(j + 1) === CH_GT : c === CH_GT) {
      return { end: j, tabs, tokens };
    } else {
      if (c === CH_TAB) tabs++;
      if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) tokens++;
    }
  }
  throw new Error('malformed UDF XML: a tag is not closed');
}

// One linear pass over the XML, before parsing, that walks it the way
// fast-xml-parser 5 does and refuses what would make that parser expensive:
//   - more than UDF_MAX_XML_NODES elements, CDATA sections and processing
//     instruction tokens (the parser keeps an object for each, and parses
//     every token of a processing instruction as an attribute);
//   - text it builds up one character at a time: plain text between tags
//     (a comment does not end the run) and tabs inside a tag;
//   - a DOCTYPE, and markup that is never closed.
// It allocates nothing, whatever the input.
export function assertUdfXmlWithinLimits(xml: string): void {
  const length = xml.length;
  let nodes = 0;
  let textRun = 0;
  let i = 0;
  while (i < length) {
    const lt = xml.indexOf('<', i);
    textRun += (lt === -1 ? length : lt) - i;
    if (textRun > UDF_MAX_XML_TEXT_RUN) throw textRunTooLong();
    if (lt === -1) break;

    const c1 = xml.charCodeAt(lt + 1);
    if (c1 === CH_SLASH) {
      const close = xml.indexOf('>', lt);
      if (close === -1) throw new Error('malformed UDF XML: a closing tag is not closed');
      textRun = 0;
      i = close + 1;
    } else if (c1 === CH_QMARK) {
      const tag = scanTag(xml, lt + 1, true);
      if (tag.tabs > UDF_MAX_XML_TEXT_RUN) throw textRunTooLong();
      nodes += 1 + tag.tokens;
      textRun = 0;
      i = tag.end + 2;
    } else if (c1 === CH_BANG && xml.charCodeAt(lt + 2) === CH_DASH && xml.charCodeAt(lt + 3) === CH_DASH) {
      const close = xml.indexOf('-->', lt + 4);
      if (close === -1) throw new Error('malformed UDF XML: a comment is not closed');
      i = close + 3;
    } else if (c1 === CH_BANG && xml.charCodeAt(lt + 2) === CH_UPPER_D) {
      throw new Error('XML DOCTYPE declarations are not allowed in a UDF');
    } else if (c1 === CH_BANG && xml.charCodeAt(lt + 2) === CH_LBRACKET) {
      const close = xml.indexOf(']]>', lt);
      if (close === -1) throw new Error('malformed UDF XML: a CDATA section is not closed');
      nodes++;
      textRun = 0;
      i = close + 3;
    } else {
      const tag = scanTag(xml, lt + 1, false);
      if (tag.tabs > UDF_MAX_XML_TEXT_RUN) throw textRunTooLong();
      nodes++;
      textRun = 0;
      i = tag.end + 1;
    }
    if (nodes > UDF_MAX_XML_NODES) {
      throw new Error(`UDF XML has more than ${UDF_MAX_XML_NODES} nodes`);
    }
  }
}

// The text of the parsed tree in document order (depth first, children left
// to right, attributes skipped), with an explicit stack so that no input can
// overflow the call stack.
function collectTextFromXmlObject(root: unknown): string[] {
  const list: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined) {
      continue;
    }
    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (trimmed) {
        list.push(trimmed);
      }
    } else if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') {
      list.push(String(node));
    } else if (Array.isArray(node)) {
      for (let k = node.length - 1; k >= 0; k--) {
        stack.push(node[k]);
      }
    } else if (typeof node === 'object') {
      const entries = Object.entries(node);
      for (let k = entries.length - 1; k >= 0; k--) {
        const [key, value] = entries[k];
        if (key.startsWith('@_')) {
          // Skip XML attributes
          continue;
        }
        stack.push(value);
      }
    }
  }
  return list;
}

// A plain XML .udf: after an optional UTF-8 byte order mark and whitespace,
// the first character is "<".
function looksLikeXml(data: Buffer): boolean {
  let i = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  while (i < data.length && (data[i] === CH_SPACE || data[i] === CH_TAB || data[i] === CH_LF || data[i] === CH_CR)) {
    i++;
  }
  return i < data.length && data[i] === 0x3c;
}

function udfXmlFromFile(data: Buffer): string {
  // Not a ZIP: a plain XML file, held to the same size as an archived one.
  if (looksLikeXml(data)) {
    if (data.length > UDF_MAX_XML_BYTES) {
      throw new Error(`XML content is ${data.length} bytes, over the limit of ${UDF_MAX_XML_BYTES}`);
    }
    return data.toString('utf8');
  }

  // The standard UYAP UDF: a ZIP archive holding content.xml.
  const zip = new BoundedZip(data);
  const files = zip.entries.filter(e => !e.isDirectory);
  const contentEntry =
    files.find(e => e.name.toLowerCase() === 'content.xml') ??
    files.find(e => e.name.toLowerCase().endsWith('.xml'));
  if (!contentEntry) {
    throw new Error('Invalid UDF file format: No XML content found inside archive or file');
  }
  return zip.read(contentEntry, UDF_MAX_XML_BYTES).toString('utf8');
}

export async function extractUdf(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    const xmlContent = udfXmlFromFile(readFileWithinLimit(filePath, UDF_MAX_FILE_BYTES));
    if (!xmlContent) {
      throw new Error('Invalid UDF file format: No XML content found inside archive or file');
    }
    // UYAP never uses a DTD; refusing one rules out entity expansion bombs.
    if (/<!(?:DOCTYPE|ENTITY)/i.test(xmlContent)) {
      throw new Error('XML DOCTYPE/ENTITY declarations are not allowed in a UDF');
    }
    assertUdfXmlWithinLimits(xmlContent);

    const parsedXml = xmlParser.parse(xmlContent);
    const textPieces = collectTextFromXmlObject(parsedXml);
    return textPieces.join(' ').trim();
  } catch (error: any) {
    throw new Error(`Failed to extract UDF (${filePath}): ${error?.message || error}`);
  }
}
