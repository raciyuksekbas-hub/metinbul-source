import * as zlib from 'zlib';
import { ZIP_MAX_ENTRIES, ZIP_MAX_ENTRY_NAME_BYTES } from './limits.js';

// A small, bounded ZIP reader for UDF and DOCX packages, which are untrusted.
//
// adm-zip is not used here even after the 0.6.1 fixes: its getData() caps
// output only at the size the archive itself declares (an honest 1 GiB entry
// still inflates to 1 GiB), and getEntries() expands every directory prefix of
// every entry name (a single 64 KiB name with 32 000 "/" took 730 MiB). This
// reader parses the central directory itself, bounds the entry count before
// reading any entry, and inflates one entry at a time with zlib's
// maxOutputLength, so no entry can grow past the caller's cap or past its own
// declared size.

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;
const SIG_ZIP64_END_OF_CENTRAL_DIR = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const END_OF_CENTRAL_DIR_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 0x0001;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

// The same signatures word-extractor uses to decide a file is a ZIP package.
export function looksLikeZip(data: Buffer): boolean {
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
  const next = data.readUInt16BE(2);
  return next === 0x0304 || next === 0x0506 || next === 0x0708;
}

function readU64(data: Buffer, offset: number, what: string): number {
  const value = data.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`corrupt ZIP: ${what} out of range`);
  }
  return Number(value);
}

function findEndOfCentralDirectory(data: Buffer): number {
  const lowest = Math.max(0, data.length - END_OF_CENTRAL_DIR_SIZE - MAX_COMMENT_SIZE);
  for (let i = data.length - END_OF_CENTRAL_DIR_SIZE; i >= lowest; i--) {
    if (data[i] === 0x50 && data.readUInt32LE(i) === SIG_END_OF_CENTRAL_DIR) return i;
  }
  throw new Error('not a ZIP archive (no end of central directory record)');
}

export class BoundedZip {
  readonly entries: readonly ZipEntry[];
  private readonly byName = new Map<string, ZipEntry>();

  constructor(private readonly data: Buffer, maxEntries: number = ZIP_MAX_ENTRIES) {
    const eocd = findEndOfCentralDirectory(data);
    let diskNumber = data.readUInt16LE(eocd + 4);
    let centralDirDisk = data.readUInt16LE(eocd + 6);
    let entriesOnDisk = data.readUInt16LE(eocd + 8);
    let totalEntries = data.readUInt16LE(eocd + 10);
    let centralDirSize = data.readUInt32LE(eocd + 12);
    let centralDirOffset = data.readUInt32LE(eocd + 16);
    let centralDirLimit = eocd;

    if (totalEntries === U16_MAX || entriesOnDisk === U16_MAX || centralDirSize === U32_MAX || centralDirOffset === U32_MAX) {
      const locator = eocd - 20;
      if (locator < 0 || data.readUInt32LE(locator) !== SIG_ZIP64_LOCATOR) {
        throw new Error('corrupt ZIP: ZIP64 locator missing');
      }
      const record = readU64(data, locator + 8, 'ZIP64 record offset');
      if (record + 56 > locator || data.readUInt32LE(record) !== SIG_ZIP64_END_OF_CENTRAL_DIR) {
        throw new Error('corrupt ZIP: ZIP64 end of central directory missing');
      }
      diskNumber = data.readUInt32LE(record + 16);
      centralDirDisk = data.readUInt32LE(record + 20);
      entriesOnDisk = readU64(data, record + 24, 'entry count');
      totalEntries = readU64(data, record + 32, 'entry count');
      centralDirSize = readU64(data, record + 40, 'central directory size');
      centralDirOffset = readU64(data, record + 48, 'central directory offset');
      centralDirLimit = record;
    }

    if (diskNumber !== 0 || centralDirDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new Error('multi-volume ZIP archives are not supported');
    }
    // Bounded before a single entry is parsed.
    if (totalEntries > maxEntries) {
      throw new Error(`ZIP archive has ${totalEntries} entries, over the limit of ${maxEntries}`);
    }
    const centralDirEnd = centralDirOffset + centralDirSize;
    if (centralDirEnd > centralDirLimit) {
      throw new Error('corrupt ZIP: central directory lies outside the archive');
    }

    const entries: ZipEntry[] = [];
    let p = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (p + CENTRAL_HEADER_SIZE > centralDirEnd || data.readUInt32LE(p) !== SIG_CENTRAL_HEADER) {
        throw new Error('corrupt ZIP: bad central directory entry');
      }
      const flags = data.readUInt16LE(p + 8);
      const method = data.readUInt16LE(p + 10);
      const crc32 = data.readUInt32LE(p + 16);
      let compressedSize = data.readUInt32LE(p + 20);
      let uncompressedSize = data.readUInt32LE(p + 24);
      const nameLength = data.readUInt16LE(p + 28);
      const extraLength = data.readUInt16LE(p + 30);
      const commentLength = data.readUInt16LE(p + 32);
      let localHeaderOffset = data.readUInt32LE(p + 42);

      const nameStart = p + CENTRAL_HEADER_SIZE;
      const extraStart = nameStart + nameLength;
      const next = extraStart + extraLength + commentLength;
      if (next > centralDirEnd) {
        throw new Error('corrupt ZIP: central directory entry overruns the directory');
      }
      if (nameLength > ZIP_MAX_ENTRY_NAME_BYTES) {
        throw new Error(`ZIP entry name of ${nameLength} bytes is over the limit of ${ZIP_MAX_ENTRY_NAME_BYTES}`);
      }

      // ZIP64 extended information: the 64-bit values follow in this order,
      // each present only when its 32-bit field is saturated.
      if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
        let q = extraStart;
        const extraEnd = extraStart + extraLength;
        let found = false;
        while (q + 4 <= extraEnd) {
          const id = data.readUInt16LE(q);
          const size = data.readUInt16LE(q + 2);
          const body = q + 4;
          if (body + size > extraEnd) break;
          if (id === 0x0001) {
            let r = body;
            const take = (what: string) => {
              if (r + 8 > body + size) throw new Error('corrupt ZIP: short ZIP64 extra field');
              const value = readU64(data, r, what);
              r += 8;
              return value;
            };
            if (uncompressedSize === U32_MAX) uncompressedSize = take('entry size');
            if (compressedSize === U32_MAX) compressedSize = take('compressed size');
            if (localHeaderOffset === U32_MAX) localHeaderOffset = take('entry offset');
            found = true;
            break;
          }
          q = body + size;
        }
        if (!found) throw new Error('corrupt ZIP: ZIP64 sizes without a ZIP64 extra field');
      }

      const name = data.toString('utf8', nameStart, extraStart);
      if (this.byName.has(name)) {
        // Two entries with one name: refuse the ambiguity rather than pick one.
        throw new Error(`corrupt ZIP: duplicate entry "${name}"`);
      }
      const entry: ZipEntry = {
        name,
        isDirectory: name.endsWith('/') || name.endsWith('\\'),
        flags,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      };
      entries.push(entry);
      this.byName.set(name, entry);
      p = next;
    }
    this.entries = entries;
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  // The entry's bytes, never more than maxBytes and never more than the size
  // the archive declares for it, checked against the declared CRC-32.
  read(entry: ZipEntry, maxBytes: number): Buffer {
    const label = `ZIP entry "${entry.name}"`;
    if (entry.isDirectory) throw new Error(`${label} is a directory`);
    if (entry.flags & FLAG_ENCRYPTED) throw new Error(`${label} is encrypted`);
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) {
      throw new Error(`${label} uses unsupported compression method ${entry.method}`);
    }
    if (entry.uncompressedSize > maxBytes) {
      throw new Error(`${label} declares ${entry.uncompressedSize} bytes, over the limit of ${maxBytes}`);
    }

    const data = this.data;
    const header = entry.localHeaderOffset;
    if (header + LOCAL_HEADER_SIZE > data.length || data.readUInt32LE(header) !== SIG_LOCAL_HEADER) {
      throw new Error(`${label}: bad local header`);
    }
    const start = header + LOCAL_HEADER_SIZE + data.readUInt16LE(header + 26) + data.readUInt16LE(header + 28);
    const end = start + entry.compressedSize;
    if (end > data.length) throw new Error(`${label} is truncated`);
    const raw = data.subarray(start, end);

    let content: Buffer;
    if (entry.method === METHOD_STORED) {
      content = raw;
    } else {
      try {
        // The output may not exceed the declared size, which is itself no more
        // than maxBytes: a bomb that declares 0 or a tiny size stops at once.
        // zlib needs a limit of at least 1 byte.
        content = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
      } catch (error: any) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error(`${label} inflates past its declared ${entry.uncompressedSize} bytes`);
        }
        throw new Error(`${label} could not be decompressed: ${error?.message || error}`);
      }
    }
    if (content.length !== entry.uncompressedSize) {
      throw new Error(`${label} holds ${content.length} bytes, not the declared ${entry.uncompressedSize}`);
    }
    if (zlib.crc32(content) >>> 0 !== entry.crc32 >>> 0) {
      throw new Error(`${label} fails its CRC-32 check`);
    }
    return content;
  }
}
