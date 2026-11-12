import * as fs from 'fs';
import { createRequire } from 'module';
import { DOC_MAX_FILE_BYTES } from './limits.js';
import { extractDocxText } from './ooxml.js';
import { readFileWithinLimit } from './read-file.js';
import { looksLikeZip } from './zip.js';

// word-extractor (no TypeScript types) is loaded through require so that the
// class and the internal modules patched below are the same module instances.
const requireCjs = createRequire(import.meta.url);
const WordExtractor = requireCjs('word-extractor');

const extractor = new WordExtractor();

// word-extractor 1.0.4 trusts the structure of an OLE file. Three spots let a
// few KiB of crafted .doc take the whole process down with a fatal
// out-of-memory error instead of failing the one document:
//   - a sector chain that loops (A -> B -> A) is followed forever, growing an
//     array until the heap runs out (only a sector pointing to itself is
//     caught);
//   - the directory tree is walked recursively without remembering visited
//     entries, so entries that share children multiply the walk (2^depth);
//   - text pieces may all point at the same bytes, each copied as a new
//     string, so a small file expands to gigabytes of text.
// Each is replaced or wrapped here with a bounded equivalent. If the internals
// are not where they should be (a changed word-extractor), .doc files are
// refused rather than parsed unprotected.
const HARDENED = Symbol.for('metinbul.wordExtractorHardened');

function hardenWordExtractor(): boolean {
  try {
    const AllocationTable = requireCjs('word-extractor/lib/ole-allocation-table.js');
    const DirectoryTree = requireCjs('word-extractor/lib/ole-directory-tree.js');
    const WordOleExtractor = requireCjs('word-extractor/lib/word-ole-extractor.js');
    const tableProto = AllocationTable?.prototype;
    const treeProto = DirectoryTree?.prototype;
    const wordProto = WordOleExtractor?.prototype;
    if (
      typeof tableProto?.getSecIdChain !== 'function' ||
      typeof treeProto?._getChildIds !== 'function' ||
      typeof treeProto?._buildHierarchy !== 'function' ||
      typeof wordProto?.writePieces !== 'function'
    ) {
      return false;
    }
    if (tableProto[HARDENED]) {
      return true;
    }

    // Same walk as the original, which stops at a sector pointing to itself;
    // any longer loop is now an error instead of an endless chain.
    tableProto.getSecIdChain = function (this: { _table: number[] }, startSecId: number): number[] {
      const table = this._table;
      const secIds: number[] = [];
      const seen = new Set<number>();
      let secId = startSecId;
      while (secId > -1) {
        if (seen.has(secId)) {
          throw new Error('corrupt OLE file: a sector chain loops');
        }
        seen.add(secId);
        secIds.push(secId);
        const next = table[secId];
        if (next === secId) break;
        secId = next;
      }
      return secIds;
    };

    // The same pre-order walk (entry, left subtree, right subtree) with an
    // explicit stack, each entry at most once.
    treeProto._getChildIds = function (
      this: { _entries: Array<{ left: number; right: number } | undefined> },
      storageEntry: { storageDirId: number }
    ): number[] {
      const childIds: number[] = [];
      if (storageEntry.storageDirId > -1) {
        const seen = new Set<number>();
        const stack = [storageEntry.storageDirId];
        while (stack.length > 0) {
          const id = stack.pop() as number;
          const entry = this._entries[id];
          if (entry === undefined) {
            throw new Error('corrupt OLE file: directory entry out of range');
          }
          if (seen.has(id)) {
            throw new Error('corrupt OLE file: directory tree reaches an entry twice');
          }
          seen.add(id);
          childIds.push(id);
          if (entry.right !== -1) stack.push(entry.right);
          if (entry.left !== -1) stack.push(entry.left);
        }
      }
      return childIds;
    };

    // Each storage is expanded once per document.
    const buildHierarchy = treeProto._buildHierarchy;
    treeProto._buildHierarchy = function (this: { [HARDENED]?: Set<unknown> }, storageEntry: unknown) {
      const built = (this[HARDENED] ??= new Set<unknown>());
      if (built.has(storageEntry)) {
        throw new Error('corrupt OLE file: a storage is reached twice');
      }
      built.add(storageEntry);
      return buildHierarchy.call(this, storageEntry);
    };

    // Pieces of a real document cover distinct parts of the WordDocument
    // stream, so their text cannot add up to more characters than the stream
    // has bytes.
    const writePieces = wordProto.writePieces;
    wordProto.writePieces = function (this: { _pieces: Array<{ text?: string }> }, buffer: Buffer, tableBuffer: Buffer) {
      const pieces = this._pieces;
      const limit = buffer.length + 4096;
      let total = 0;
      const push = pieces.push;
      pieces.push = function (this: typeof pieces, ...items: Array<{ text?: string }>) {
        for (const item of items) total += item?.text?.length ?? 0;
        if (total > limit) {
          throw new Error('corrupt Word file: text pieces overlap');
        }
        return push.apply(this, items);
      };
      try {
        return writePieces.call(this, buffer, tableBuffer);
      } finally {
        delete (pieces as { push?: unknown }).push;
      }
    };

    tableProto[HARDENED] = true;
    return true;
  } catch {
    return false;
  }
}

export const docParserHardened = hardenWordExtractor();

// Header fields word-extractor sizes its buffers and loops by, checked
// against [MS-CFB] 2.2 and the file's real size so that none of them can ask
// for more memory than the file could describe.
function assertCompoundFileHeader(data: Buffer): void {
  if (data.length < 512) {
    throw new Error('corrupt OLE file: shorter than its header');
  }
  const sectorShift = data.readUInt16LE(30);
  const miniSectorShift = data.readUInt16LE(32);
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new Error(`corrupt OLE file: sector size 2^${sectorShift}`);
  }
  if (miniSectorShift !== 6) {
    throw new Error(`corrupt OLE file: mini sector size 2^${miniSectorShift}`);
  }
  const sectorSize = 1 << sectorShift;
  // Sector n starts at (n + 1) * sectorSize: the header fills sector -1.
  const sectors = Math.ceil(Math.max(0, data.length - sectorSize) / sectorSize);
  const fatSectorsNeeded = Math.ceil(sectors / (sectorSize / 4));
  const fatSectors = data.readInt32LE(44);
  const directoryStart = data.readInt32LE(48);
  const miniFatSectors = data.readInt32LE(64);
  const difatSectors = data.readInt32LE(72);
  if (fatSectors < 1 || fatSectors > 2 * fatSectorsNeeded + 2) {
    throw new Error(`corrupt OLE file: ${fatSectors} FAT sectors for ${sectors} sectors`);
  }
  if (difatSectors < 0 || difatSectors > sectors || miniFatSectors < 0 || miniFatSectors > sectors) {
    throw new Error('corrupt OLE file: allocation table sizes do not fit the file');
  }
  if (directoryStart < 0 || directoryStart >= sectors) {
    throw new Error('corrupt OLE file: directory outside the file');
  }
}

export async function extractDoc(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    const data = readFileWithinLimit(filePath, DOC_MAX_FILE_BYTES);
    if (looksLikeZip(data)) {
      // A Word 2007+ package with a .doc name. word-extractor would inflate
      // its parts with no limit; it goes through the bounded DOCX reader.
      return await extractDocxText(data);
    }
    if (!docParserHardened) {
      throw new Error('the .doc reader could not be secured (unexpected word-extractor version)');
    }
    if (data.length >= 2 && data.readUInt16BE(0) === 0xd0cf) {
      assertCompoundFileHeader(data);
    }
    const extracted = await extractor.extract(data);
    const body = extracted.getBody() || '';
    return body.trim();
  } catch (error: any) {
    throw new Error(`Failed to extract DOC (${filePath}): ${error?.message || error}`);
  }
}
