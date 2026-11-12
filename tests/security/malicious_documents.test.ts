import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { extractUdf } from '../../src/extractors/udf.js';
import { extractDocx } from '../../src/extractors/docx.js';
import { extractDoc, docParserHardened } from '../../src/extractors/doc.js';
import { extractPdfPages } from '../../src/extractors/pdf.js';
import { extractDocxText, DEFAULT_DOCX_LIMITS } from '../../src/extractors/ooxml.js';
import {
  DOC_MAX_FILE_BYTES,
  DOCX_MAX_FILE_BYTES,
  DOCX_MAX_PART_BYTES,
  DOCX_MAX_XML_ELEMENTS,
  PDF_MAX_FILE_BYTES,
  UDF_MAX_FILE_BYTES,
  UDF_MAX_XML_BYTES,
  UDF_MAX_XML_DEPTH,
  UDF_MAX_XML_NODES,
  UDF_MAX_XML_TEXT_RUN,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_NAME_BYTES
} from '../../src/extractors/limits.js';

// Every document here is built in the test: no real or third-party file is
// read. Each must fail on its own (a rejected promise), quickly and within a
// small, fixed amount of memory, however much it claims to contain.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const TURKISH = 'İstanbul Şişli ğüşıöç';

let dir: string;
let counter = 0;

function write(name: string, data: Buffer | string): string {
  const file = path.join(dir, `${counter++}-${name}`);
  fs.writeFileSync(file, data);
  return file;
}

// A file of the given apparent size that takes no disk space (sparse).
function sparse(name: string, size: number, head?: Buffer): string {
  const file = write(name, head ?? Buffer.alloc(0));
  fs.truncateSync(file, size);
  return file;
}

// --- ZIP construction, byte by byte -----------------------------------------

interface RawEntry {
  name: string;
  data?: Buffer; // the stored bytes, already compressed for method 8
  method?: number;
  crc?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  flags?: number;
}

function buildZip(entries: RawEntry[], declaredEntries?: number): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const flags = e.flags ?? 0x0800;
    const crc = (e.crc ?? 0) >>> 0;
    const csize = e.compressedSize ?? data.length;
    const usize = e.uncompressedSize ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(csize, 20);
    header.writeUInt32LE(usize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);

    parts.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const count = declaredEntries ?? entries.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function deflated(name: string, content: Buffer | string): RawEntry {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { name, data: zlib.deflateRawSync(bytes), crc: zlib.crc32(bytes), uncompressedSize: bytes.length };
}

// A raw deflate stream of `mib` MiB of zeros, about 1 KiB per MiB, built
// without ever holding the zeros: one sync-flushed block repeated, then an
// empty final block.
function zeroBomb(mib: number): Buffer {
  const block = zlib.deflateRawSync(Buffer.alloc(MiB), { level: 9, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  return Buffer.concat([...new Array(mib).fill(block), Buffer.from([0x03, 0x00])]);
}

// --- Fixtures in the formats' own shape ---------------------------------------

function udfXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<template format_id="1.8">
  <content><![CDATA[${body}]]></content>
  <properties><pageFormat mediaSizeName="1" leftMargin="70.0"/></properties>
  <elements resolver="hvl-default">
    <paragraph><content startOffset="0" length="${body.length}"/></paragraph>
  </elements>
</template>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

function packageRels(target = 'word/document.xml'): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>
</Relationships>`;
}

function documentXml(paragraphs: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

function docxWith(entries: RawEntry[], target?: string): Buffer {
  return buildZip([deflated('[Content_Types].xml', CONTENT_TYPES), deflated('_rels/.rels', packageRels(target)), ...entries]);
}

const VALID_DOCX = () =>
  docxWith([deflated('word/document.xml', documentXml(`<w:p><w:r><w:t>${TURKISH}</w:t></w:r></w:p><w:p><w:r><w:t>Tom &amp; Jerry</w:t></w:r></w:p>`))]);

// --- OLE compound file (Word 97-2003), sector by sector ------------------------

interface CfbEntry {
  name: string;
  type: 1 | 2 | 5;
  left?: number;
  right?: number;
  child?: number;
  data?: Buffer; // at least 4096 bytes, so it lives in normal sectors
}

function buildCfb(entries: CfbEntry[], editFat?: (fat: Int32Array, layout: { dirStart: number; starts: number[] }) => void): Buffer {
  const SECTOR = 512;
  const dataSectors = entries.map(e => (e.data ? Math.ceil(e.data.length / SECTOR) : 0));
  const dirSectors = Math.ceil(entries.length / 4);
  const payload = dirSectors + dataSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (fatSectors * 128 < fatSectors + payload) fatSectors++;
  const total = fatSectors + payload;

  const fat = new Int32Array(fatSectors * 128).fill(-1);
  for (let i = 0; i < fatSectors; i++) fat[i] = -3;
  const chain = (start: number, count: number) => {
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? -2 : start + i + 1;
  };
  const dirStart = fatSectors;
  chain(dirStart, dirSectors);
  let next = dirStart + dirSectors;
  const starts = entries.map((e, i) => {
    if (!e.data) return -2;
    const start = next;
    chain(start, dataSectors[i]);
    next += dataSectors[i];
    return start;
  });
  editFat?.(fat, { dirStart, starts });

  const out = Buffer.alloc(SECTOR * (1 + total));
  Buffer.from('D0CF11E0A1B11AE1', 'hex').copy(out, 0);
  out.writeUInt16LE(0x3e, 24);
  out.writeUInt16LE(3, 26);
  out.writeUInt16LE(0xfffe, 28);
  out.writeUInt16LE(9, 30);
  out.writeUInt16LE(6, 32);
  out.writeInt32LE(fatSectors, 44);
  out.writeInt32LE(dirStart, 48);
  out.writeUInt32LE(4096, 56);
  out.writeInt32LE(-2, 60);
  out.writeInt32LE(0, 64);
  out.writeInt32LE(-2, 68);
  out.writeInt32LE(0, 72);
  for (let i = 0; i < 109; i++) out.writeInt32LE(i < fatSectors ? i : -1, 76 + i * 4);
  for (let i = 0; i < fat.length; i++) out.writeInt32LE(fat[i], SECTOR + i * 4);

  const dirBase = SECTOR * (1 + dirStart);
  for (let i = 0; i < dirSectors * 4; i++) {
    const o = dirBase + i * 128;
    const e = entries[i];
    out.writeInt32LE(e?.left ?? -1, o + 68);
    out.writeInt32LE(e?.right ?? -1, o + 72);
    out.writeInt32LE(e?.child ?? -1, o + 76);
    if (!e) continue;
    const name = Buffer.from(`${e.name}\0`, 'utf16le');
    name.copy(out, o);
    out.writeUInt16LE(name.length, o + 64);
    out.writeUInt8(e.type, o + 66);
    out.writeUInt8(1, o + 67);
    out.writeInt32LE(starts[i], o + 116);
    out.writeUInt32LE(e.data?.length ?? 0, o + 120);
  }
  entries.forEach((e, i) => {
    if (e.data) e.data.copy(out, SECTOR * (1 + starts[i]));
  });
  return out;
}

// A WordDocument stream and its 0Table holding one Unicode text piece.
function wordStreams(text: string): { word: Buffer; table: Buffer } {
  const textOffset = 2048;
  const word = Buffer.alloc(4096 + 2 * text.length);
  word.writeUInt16LE(0xa5ec, 0); // wIdent
  word.writeUInt32LE(text.length, 0x4c); // ccpText
  word.writeUInt32LE(0, 0x1a2); // fcClx
  Buffer.from(text, 'utf16le').copy(word, textOffset);
  const table = Buffer.alloc(4096);
  table.writeUInt8(2, 0); // Pcdt
  table.writeUInt32LE(16, 1); // one piece: two CPs and one PCD
  table.writeUInt32LE(0, 5);
  table.writeUInt32LE(text.length, 9);
  table.writeUInt32LE(textOffset, 15); // fc, Unicode
  return { word, table };
}

function wordFile(word: Buffer, table: Buffer, editFat?: Parameters<typeof buildCfb>[1]): Buffer {
  return buildCfb(
    [
      { name: 'Root Entry', type: 5, child: 1 },
      { name: 'WordDocument', type: 2, right: 2, data: word },
      { name: '0Table', type: 2, data: table }
    ],
    editFat
  );
}

// --- Measuring -----------------------------------------------------------------

interface Measured {
  error?: Error;
  value?: unknown;
  ms: number;
  peakGrowth: number; // growth of the process's peak resident memory
  rssGrowth: number;
}

async function measure(run: () => Promise<unknown>): Promise<Measured> {
  const peakBefore = process.resourceUsage().maxRSS * 1024;
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  let error: Error | undefined;
  let value: unknown;
  try {
    value = await run();
  } catch (e) {
    error = e as Error;
  }
  const ms = performance.now() - started;
  return {
    error,
    value,
    ms,
    peakGrowth: process.resourceUsage().maxRSS * 1024 - peakBefore,
    rssGrowth: process.memoryUsage().rss - rssBefore
  };
}

function expectBoundedFailure(m: Measured, message: RegExp, limits: { ms?: number; memory?: number } = {}) {
  expect(m.error, 'the document must be rejected').toBeInstanceOf(Error);
  expect(m.error!.message).toMatch(message);
  expect(m.ms).toBeLessThan(limits.ms ?? 5000);
  expect(m.peakGrowth).toBeLessThan(limits.memory ?? 256 * MiB);
  expect(m.rssGrowth).toBeLessThan(limits.memory ?? 256 * MiB);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-malicious-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Runs first, while the process's memory high-water mark is still low, so a
// bomb that inflated would show up in the peak.
describe('ZIP bombs in a UDF', () => {
  const bomb = zeroBomb(1024); // 1 GiB of zeros, about 1 MiB compressed

  it('uses a bomb that really inflates to 1 GiB (counted as it streams, never held)', async () => {
    expect(bomb.length).toBeLessThan(2 * MiB);
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const inflater = zlib.createInflateRaw();
      inflater.on('data', (chunk: Buffer) => (total += chunk.length));
      inflater.on('end', () => resolve());
      inflater.on('error', reject);
      inflater.end(bomb);
    });
    expect(total).toBe(GiB);
  }, 30000);

  it('refuses a content.xml that declares its 1 GiB honestly, without inflating it', async () => {
    const file = write('honest-bomb.udf', buildZip([{ name: 'content.xml', data: bomb, uncompressedSize: GiB }]));
    const m = await measure(() => extractUdf(file));
    expectBoundedFailure(m, /declares 1073741824 bytes, over the limit of 67108864/, { ms: 2000, memory: 64 * MiB });
  });

  it('stops at the declared size when the entry claims 0 or a few bytes', async () => {
    for (const declared of [0, 17]) {
      const file = write('lying-bomb.udf', buildZip([{ name: 'content.xml', data: bomb, uncompressedSize: declared }]));
      const m = await measure(() => extractUdf(file));
      expectBoundedFailure(m, new RegExp(`inflates past its declared ${declared} bytes`), { ms: 2000, memory: 64 * MiB });
    }
  });

  it('stops at the 64 MiB cap when the declared size sits right at the cap', async () => {
    const file = write('cap-bomb.udf', buildZip([{ name: 'content.xml', data: bomb, uncompressedSize: UDF_MAX_XML_BYTES }]));
    const m = await measure(() => extractUdf(file));
    expectBoundedFailure(m, /inflates past its declared 67108864 bytes/);
  });

  it('applies the same bound to any .xml entry picked when content.xml is missing', async () => {
    const file = write('other-xml-bomb.udf', buildZip([{ name: 'belge.xml', data: bomb, uncompressedSize: 0 }]));
    const m = await measure(() => extractUdf(file));
    expectBoundedFailure(m, /inflates past/);
  });
});

describe('Corrupt and hostile ZIP structure', () => {
  const validUdf = () => buildZip([deflated('content.xml', udfXml(TURKISH))]);

  it('rejects a truncated archive', async () => {
    const whole = validUdf();
    for (const cut of [whole.length - 10, Math.floor(whole.length / 2), 40]) {
      const file = write('truncated.udf', whole.subarray(0, cut));
      await expect(extractUdf(file)).rejects.toThrow(/Failed to extract UDF/);
    }
  });

  it('rejects an entry whose content does not match its CRC-32', async () => {
    const entry = deflated('content.xml', udfXml(TURKISH));
    const file = write('bad-crc.udf', buildZip([{ ...entry, crc: (entry.crc! ^ 1) >>> 0 }]));
    await expect(extractUdf(file)).rejects.toThrow(/CRC-32/);
  });

  it('rejects a corrupt deflate stream', async () => {
    const entry = deflated('content.xml', udfXml(TURKISH));
    const data = Buffer.from(entry.data!);
    data.fill(0xff, 2, 12);
    const file = write('bad-deflate.udf', buildZip([{ ...entry, data }]));
    await expect(extractUdf(file)).rejects.toThrow(/Failed to extract UDF/);
  });

  it(`refuses more than ${ZIP_MAX_ENTRIES} entries before reading any of them`, async () => {
    const file = write('many-entries.udf', buildZip([deflated('content.xml', udfXml(TURKISH))], ZIP_MAX_ENTRIES + 1));
    const m = await measure(() => extractUdf(file));
    expectBoundedFailure(m, /10001 entries, over the limit of 10000/, { ms: 1000, memory: 32 * MiB });
  });

  it('refuses encrypted entries and compression methods other than stored and deflate', async () => {
    const entry = deflated('content.xml', udfXml(TURKISH));
    await expect(extractUdf(write('enc.udf', buildZip([{ ...entry, flags: 0x0801 }])))).rejects.toThrow(/encrypted/);
    await expect(extractUdf(write('bzip2.udf', buildZip([{ ...entry, method: 12 }])))).rejects.toThrow(/compression method 12/);
  });

  it('refuses two entries with the same name', async () => {
    const entry = deflated('content.xml', udfXml(TURKISH));
    await expect(extractUdf(write('dup.udf', buildZip([entry, entry])))).rejects.toThrow(/duplicate entry/);
  });

  it(`refuses an entry name over ${ZIP_MAX_ENTRY_NAME_BYTES} bytes (adm-zip expands one into hundreds of MiB)`, async () => {
    const deep = { name: 'a/'.repeat(30000) + 'x.xml', data: Buffer.alloc(0), method: 0, uncompressedSize: 0 };
    const file = write('deep-name.udf', buildZip([deflated('content.xml', udfXml(TURKISH)), deep]));
    const m = await measure(() => extractUdf(file));
    expectBoundedFailure(m, /entry name of 60005 bytes is over the limit/, { ms: 1000, memory: 32 * MiB });
  });

  it('reads a stored (uncompressed) content.xml and ignores folder entries', async () => {
    const xml = Buffer.from(udfXml(TURKISH), 'utf8');
    const file = write(
      'stored.udf',
      buildZip([
        { name: 'folder/', method: 0, data: Buffer.alloc(0), uncompressedSize: 0 },
        { name: 'content.xml', method: 0, data: xml, crc: zlib.crc32(xml), uncompressedSize: xml.length }
      ])
    );
    expect(await extractUdf(file)).toContain(TURKISH);
  });

  it('rejects a stored entry whose declared size does not match its bytes', async () => {
    const xml = Buffer.from(udfXml(TURKISH), 'utf8');
    const file = write('stored-lie.udf', buildZip([{ name: 'content.xml', method: 0, data: xml, crc: zlib.crc32(xml), uncompressedSize: 5 }]));
    await expect(extractUdf(file)).rejects.toThrow(/over the limit|not the declared 5/);
  });
});

describe('Size limits are applied before a file is read', () => {
  const cases: Array<[string, string, number, (f: string) => Promise<unknown>]> = [
    ['PDF', 'big.pdf', PDF_MAX_FILE_BYTES, extractPdfPages],
    ['DOCX', 'big.docx', DOCX_MAX_FILE_BYTES, extractDocx],
    ['DOC', 'big.doc', DOC_MAX_FILE_BYTES, extractDoc],
    ['UDF', 'big.udf', UDF_MAX_FILE_BYTES, extractUdf]
  ];

  for (const [kind, name, limit, run] of cases) {
    it(`refuses a ${kind} one byte over ${limit / MiB} MiB without reading it`, async () => {
      const file = sparse(name, limit + 1);
      const m = await measure(() => run(file));
      expectBoundedFailure(m, new RegExp(`file is ${limit + 1} bytes, over the limit of ${limit} bytes`), {
        ms: 1000,
        memory: 16 * MiB
      });
    });
  }

  it('refuses a plain XML .udf larger than the XML limit', async () => {
    const file = sparse('big-plain.udf', UDF_MAX_XML_BYTES + 1, Buffer.from('<template>'));
    await expect(extractUdf(file)).rejects.toThrow(/XML content is 67108865 bytes, over the limit of 67108864/);
  });

  it('refuses something that is not a regular file', async () => {
    const folder = path.join(dir, 'folder.pdf');
    fs.mkdirSync(folder);
    await expect(extractPdfPages(folder)).rejects.toThrow(/not a regular file/);
  });
});

describe('UDF XML', () => {
  const udf = (xml: string) => write('doc.udf', buildZip([deflated('content.xml', xml)]));

  it('rejects a billion laughs DOCTYPE before parsing', async () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<template><content>&lol9;</content></template>`;
    const m = await measure(() => extractUdf(udf(laughs)));
    expectBoundedFailure(m, /DOCTYPE\/ENTITY declarations are not allowed/, { ms: 1000, memory: 32 * MiB });
  });

  it('rejects ENTITY declarations and lower-case doctypes too', async () => {
    await expect(extractUdf(udf('<template><!ENTITY x "y"><content>a</content></template>'))).rejects.toThrow(/not allowed/);
    await expect(extractUdf(udf('<!doctype template><template>a</template>'))).rejects.toThrow(/not allowed/);
  });

  it('rejects 100 000 levels of nesting without overflowing the stack', async () => {
    const depth = 100_000;
    const xml = '<a>'.repeat(depth) + 'metin' + '</a>'.repeat(depth);
    const m = await measure(() => extractUdf(udf(xml)));
    expectBoundedFailure(m, /Maximum nested tags exceeded/, { ms: 2000, memory: 64 * MiB });
  });

  it(`reads nesting just inside the depth limit (${UDF_MAX_XML_DEPTH})`, async () => {
    const depth = UDF_MAX_XML_DEPTH - 2;
    const xml = '<template>' + '<a>'.repeat(depth) + `<![CDATA[${TURKISH}]]>` + '</a>'.repeat(depth) + '</template>';
    expect(await extractUdf(udf(xml))).toBe(TURKISH);
  });

  it('rejects markup that is never closed', async () => {
    for (const xml of [
      `<template><content><![CDATA[${TURKISH}</content></template>`,
      '<template><content>metin</content><!-- yorum',
      '<template><content attr="x>metin</content></template>',
      '<template><content>metin</content></template',
      '<template><content>metin<'
    ]) {
      await expect(extractUdf(udf(xml)), xml).rejects.toThrow(/Failed to extract UDF/);
    }
  });

  it('fails or reads, but never crashes, on mismatched tags', async () => {
    const outcome = await extractUdf(udf('<template><content>metin</elements></template>')).then(
      text => ({ text }),
      error => ({ error })
    );
    if ('error' in outcome) expect(outcome.error).toBeInstanceOf(Error);
    else expect(outcome.text).toContain('metin');
  });

  it('rejects a file with no XML in it', async () => {
    await expect(extractUdf(write('garbage.udf', Buffer.from([0x00, 0x01, 0x02, 0x03])))).rejects.toThrow(/Failed to extract UDF/);
    await expect(extractUdf(write('noxml.udf', buildZip([deflated('sign.sgn', 'imza')])))).rejects.toThrow(/No XML content/);
  });

  it(`rejects a plain text run over ${UDF_MAX_XML_TEXT_RUN} characters (the parser builds it a character at a time)`, async () => {
    const run = 'a'.repeat(UDF_MAX_XML_TEXT_RUN / 2);
    // A comment does not end the run for the parser, so it does not here either.
    const xml = `<template><content>${run}<!-- -->${run}b</content></template>`;
    const m = await measure(() => extractUdf(udf(xml)));
    expectBoundedFailure(m, /run of more than/, { ms: 2000, memory: 64 * MiB });
  });

  it('reads a long text inside CDATA, where UDF keeps its text', async () => {
    const body = `${TURKISH} ` + 'x'.repeat(4 * UDF_MAX_XML_TEXT_RUN);
    const text = await extractUdf(udf(udfXml(body)));
    expect(text.startsWith(TURKISH)).toBe(true);
    expect(text.length).toBeGreaterThan(4 * UDF_MAX_XML_TEXT_RUN);
  });

  it(`rejects more than ${UDF_MAX_XML_NODES} nodes before building them`, async () => {
    const xml = '<template>' + '<a/>'.repeat(UDF_MAX_XML_NODES) + '</template>';
    const m = await measure(() => extractUdf(udf(xml)));
    expectBoundedFailure(m, /more than 1000000 nodes/, { ms: 3000, memory: 128 * MiB });
  });

  it('counts processing-instruction tokens, which the parser reads as attributes', async () => {
    const xml = `<?xml${' a'.repeat(UDF_MAX_XML_NODES)}?><template>metin</template>`;
    await expect(extractUdf(udf(xml))).rejects.toThrow(/nodes/);
  });

  it('rejects a tag stuffed with tabs (the parser joins them one by one)', async () => {
    const xml = `<template${'\t'.repeat(UDF_MAX_XML_TEXT_RUN + 1)}>metin</template>`;
    await expect(extractUdf(udf(xml))).rejects.toThrow(/run of more than/);
  });

  it('still reads a valid UDF with Turkish text and the predefined XML entities', async () => {
    const xml = udfXml(TURKISH).replace('</template>', '<note>Tom &amp; Jerry &lt;3</note></template>');
    const text = await extractUdf(udf(xml));
    expect(text).toContain(TURKISH);
    expect(text).toContain('Tom & Jerry <3');
  });

  it('still reads a plain XML .udf (no ZIP), with a byte order mark', async () => {
    const file = write('plain.udf', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(udfXml(TURKISH), 'utf8')]));
    expect(await extractUdf(file)).toContain(TURKISH);
  });
});

describe('DOCX', () => {
  const bomb = zeroBomb(1024);

  it('refuses word/document.xml inflating past the 64 MiB part limit', async () => {
    const file = write('bomb.docx', docxWith([{ name: 'word/document.xml', data: bomb, uncompressedSize: DOCX_MAX_PART_BYTES }]));
    const m = await measure(() => extractDocx(file));
    expectBoundedFailure(m, /word\/document\.xml" inflates past its declared 67108864 bytes/);
  });

  it('refuses a part declaring more than the part limit, without inflating it', async () => {
    const file = write('honest-bomb.docx', docxWith([{ name: 'word/document.xml', data: bomb, uncompressedSize: GiB }]));
    const m = await measure(() => extractDocx(file));
    expectBoundedFailure(m, /declares 1073741824 bytes, over the limit of 67108864/, { ms: 2000, memory: 64 * MiB });
  });

  it('bounds the main document even when the package names a part that is not .xml', async () => {
    const file = write(
      'renamed-part.docx',
      docxWith([{ name: 'word/payload.bin', data: bomb, uncompressedSize: 0 }], 'word/payload.bin')
    );
    const m = await measure(() => extractDocx(file));
    expectBoundedFailure(m, /payload\.bin" inflates past its declared 0 bytes/, { ms: 2000, memory: 64 * MiB });
  });

  it('refuses a DOCTYPE in a part (Office Open XML forbids DTDs)', async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE w [<!ENTITY a "aaaaaaaaaa">]>` + documentXml('<w:p><w:r><w:t>&a;</w:t></w:r></w:p>');
    const file = write('doctype.docx', docxWith([deflated('word/document.xml', xml)]));
    await expect(extractDocx(file)).rejects.toThrow(/declares a DOCTYPE or ENTITY/);
  });

  it(`refuses more than ${DOCX_MAX_XML_ELEMENTS} elements before mammoth builds them`, async () => {
    const xml = documentXml('<w:p/>'.repeat(DOCX_MAX_XML_ELEMENTS));
    const file = write('elements.docx', docxWith([deflated('word/document.xml', xml)]));
    const m = await measure(() => extractDocx(file));
    expectBoundedFailure(m, /more than 1000000 XML elements/, { ms: 3000, memory: 128 * MiB });
  });

  it('applies the attribute and total-size budgets across all parts read', async () => {
    const docx = VALID_DOCX();
    await expect(extractDocxText(docx, { ...DEFAULT_DOCX_LIMITS, maxXmlAttributes: 3 })).rejects.toThrow(/XML attributes/);
    await expect(extractDocxText(docx, { ...DEFAULT_DOCX_LIMITS, maxTotalPartBytes: 600 })).rejects.toThrow(/add up to more than 600 bytes/);
    await expect(extractDocxText(docx, { ...DEFAULT_DOCX_LIMITS, maxPartBytes: 100 })).rejects.toThrow(/over the limit of 100/);
  });

  it('rejects a corrupt package', async () => {
    const docx = VALID_DOCX();
    await expect(extractDocx(write('cut.docx', docx.subarray(0, docx.length - 30)))).rejects.toThrow(/Failed to extract DOCX/);
    await expect(extractDocx(write('notzip.docx', 'NOT A VALID DOCX ZIP FILE'))).rejects.toThrow(/Failed to extract DOCX/);
  });

  it('still reads a valid DOCX with Turkish text', async () => {
    const text = await extractDocx(write('valid.docx', VALID_DOCX()));
    expect(text).toContain(TURKISH);
    expect(text).toContain('Tom & Jerry');
  });
});

describe('DOC', () => {
  it('has its word-extractor safeguards in place', () => {
    expect(docParserHardened).toBe(true);
  });

  it('still reads a valid Word 97-2003 document with Turkish text', async () => {
    const { word, table } = wordStreams(`${TURKISH}\r`);
    expect(await extractDoc(write('valid.doc', wordFile(word, table)))).toBe(TURKISH);
  });

  it('rejects a sector chain that loops (unprotected: endless loop, fatal out of memory)', async () => {
    const { word, table } = wordStreams(TURKISH);
    const looped = wordFile(word, table, (fat, { dirStart, starts }) => {
      fat[dirStart] = starts[1];
      fat[starts[1]] = dirStart;
    });
    const m = await measure(() => extractDoc(write('loop.doc', looped)));
    expectBoundedFailure(m, /sector chain loops/, { ms: 2000, memory: 64 * MiB });
  });

  it('rejects a directory tree whose entries share children (unprotected: 2^30 visits)', async () => {
    const entries: CfbEntry[] = [{ name: 'Root Entry', type: 5, child: 1 }];
    for (let i = 1; i <= 30; i++) entries.push({ name: `S${i}`, type: 2, left: i + 1, right: i + 1 });
    entries.push({ name: 'S31', type: 2 });
    const m = await measure(() => extractDoc(write('tree.doc', buildCfb(entries))));
    expectBoundedFailure(m, /reaches an entry twice/, { ms: 2000, memory: 64 * MiB });
  });

  it('rejects text pieces that all point at the same bytes (unprotected: gigabytes of text)', async () => {
    const pieces = 40_000;
    const word = Buffer.alloc(64 * 1024);
    word.writeUInt16LE(0xa5ec, 0);
    word.writeUInt32LE(0, 0x1a2);
    const table = Buffer.alloc(5 + 12 * pieces + 4);
    table.writeUInt8(2, 0);
    table.writeUInt32LE(12 * pieces + 4, 1);
    for (let x = 0; x <= pieces; x++) table.writeUInt32LE(x * word.length, 5 + 4 * x);
    for (let x = 0; x < pieces; x++) table.writeUInt32LE(0x40000000, 5 + 4 * (pieces + 1) + 8 * x + 2);
    const m = await measure(() => extractDoc(write('pieces.doc', wordFile(word, table))));
    expectBoundedFailure(m, /text pieces overlap/, { ms: 2000, memory: 64 * MiB });
  });

  it('rejects header fields that do not fit the file', async () => {
    const { word, table } = wordStreams(TURKISH);
    const huge = wordFile(word, table);
    huge.writeUInt16LE(30, 30); // 1 GiB sectors
    await expect(extractDoc(write('sector.doc', huge))).rejects.toThrow(/sector size 2\^30/);
    const fat = wordFile(word, table);
    fat.writeInt32LE(0x7fffffff, 44); // FAT sector count
    await expect(extractDoc(write('fat.doc', fat))).rejects.toThrow(/FAT sectors/);
  });

  it('reads a DOCX saved with a .doc name through the bounded DOCX reader', async () => {
    expect(await extractDoc(write('renamed.doc', VALID_DOCX()))).toContain(TURKISH);
    const bomb = docxWith([{ name: 'word/document.xml', data: zeroBomb(64), uncompressedSize: 0 }]);
    const m = await measure(() => extractDoc(write('renamed-bomb.doc', bomb)));
    expectBoundedFailure(m, /inflates past its declared 0 bytes/, { ms: 2000, memory: 64 * MiB });
  });

  it('rejects a file that is neither OLE nor ZIP', async () => {
    await expect(extractDoc(write('text.doc', 'NON OLE2 CONTENT'))).rejects.toThrow(/Failed to extract DOC/);
  });
});
