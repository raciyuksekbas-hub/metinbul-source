import * as path from 'path';
import * as fs from 'fs';
import { AppDatabase, DocumentRecord, OcrState } from '../db/database.js';
import { ScannedFile, scanDirectories, isPathOrSubpath, isPathExcluded, listedDirectoryKey, resolveExclusions, ScanStats } from '../scanner/scanner.js';
import { ContentNotLocallyAvailableError } from '../scanner/windows-availability.js';
import { extract, extractPdfPageTexts } from '../extractors/index.js';
import { discoverSearchRoots } from '../scanner/roots.js';
import { OcrEngine, ocrTimeoutMs } from '../ocr/ocr.js';

export interface IndexProgress {
  total: number;
  current: number;
  currentFile?: string;
  status: 'scanning' | 'indexing' | 'completed' | 'error';
  message?: string;
  skippedDataless?: number;
}

export interface IndexSummary {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  removed: number;
  // Supported (.doc/.docx/.pdf/.udf) files skipped because their content
  // isn't present on this device: macOS SF_DATALESS, or a Windows online-only
  // cloud placeholder (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS / OFFLINE) --
  // provider-agnostic, not specific to any one cloud sync client. Counts only
  // the ones that are not searchable: see keptCloudOnly.
  skippedDataless: number;
  // Cloud-only files whose index entry from when they were local was kept,
  // so their text stays searchable. Not part of skippedDataless.
  keptCloudOnly: number;
  // Scanned PDFs that text recognition gave text to in this update, and the
  // ones left for a later update once its time budget ran out.
  ocrRecognized: number;
  ocrPending: number;
}

export interface IndexOptions {
  // Read again the files that failed last time even if they have not changed.
  // On by default; automatic updates turn it off. Applies to text
  // recognition failures too.
  retryFailed?: boolean;
  // Text recognition for the PDF pages without a real text layer, and how
  // long one update may spend on it: about half a second a page, so a first
  // run over a few thousand scanned pages is spread over several updates.
  ocr?: { engine: OcrEngine; budgetMs: number };
  // Told right before a document is read, with how long reading it may take
  // at most. The main process stops an update whose document overruns this
  // (a malformed or hostile file can send a parser into an endless loop) and
  // records that document as unreadable, so the next update gets past it.
  onReading?: (file: ScannedFile, limitMs: number) => void;
}

// How long reading one document's text layer may take: five minutes, plus a
// minute per 50 MB for a large file on a slow network share or VPN (a 512 MB
// PDF gets 16 minutes). The watchdog in the main process stops a read
// that overruns this -- meant for a parser stuck in a loop, not a slow disk.
export const DOCUMENT_READ_LIMIT_MS = 5 * 60 * 1000;
export function documentReadLimitMs(sizeBytes: number): number {
  return DOCUMENT_READ_LIMIT_MS + Math.ceil(Math.max(0, sizeBytes) / (50 * 1024 * 1024)) * 60 * 1000;
}

// A page with less text than this is treated as scanned and read by text
// recognition. A full page of text has thousands of characters; a scanned page
// often has a stamp, a page number or an e-signature footer of a few hundred.
const SPARSE_PAGE_CHARS = 400;

function visibleChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

// Whether this scan read the folder's listing (one with entries, if asked).
function wasListed(dir: string, listedDirectories: ReadonlyMap<string, number>, withEntries: boolean): boolean {
  for (const real of [fs.realpathSync.native(dir), fs.realpathSync(dir)]) {
    const entries = listedDirectories.get(listedDirectoryKey(real));
    if (entries !== undefined && (!withEntries || entries > 0)) return true;
  }
  return false;
}

// Whether the document lies in one of these folders, decided on the path
// alone: looking a name up inside a folder the scan did not read can hang the
// same way reading it does.
function isInAnyFolder(docPath: string, folders: ReadonlySet<string>): boolean {
  if (folders.size === 0) return false;
  for (let dir = path.dirname(docPath); ; dir = path.dirname(dir)) {
    if (folders.has(dir)) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// Whether a document this scan did not find has really been deleted or moved,
// rather than sitting somewhere that is unreachable right now.
function isGoneFromScannedTree(docPath: string, listedDirectories: ReadonlyMap<string, number>): boolean {
  let dir = path.dirname(docPath);
  try {
    // The folder is still there: the file was deleted or moved -- provided
    // this scan could read the folder. One it could not read (permissions, a
    // cloud folder that failed to load) proves nothing, and with an update
    // every few minutes such a hiccup would otherwise empty its entries.
    if (fs.existsSync(dir)) return wasListed(dir, listedDirectories, false);
    // The folder is gone too. Walk up to the closest path that still exists:
    // if it is a folder this scan listed with something in it, the missing
    // folder was deleted or moved. Anything else -- a disk that is not
    // connected, a dangling link to one, a folder that could not be read --
    // keeps the entry.
    for (;;) {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
      let present = false;
      try {
        fs.lstatSync(dir);
        present = true;
      } catch {
        // Missing as well: keep walking up.
      }
      if (present) {
        // statSync follows a link; a dangling one throws and keeps the entry.
        if (!fs.statSync(dir).isDirectory()) return false;
        return wasListed(dir, listedDirectories, true);
      }
    }
  } catch {
    return false;
  }
}

export async function indexFolders(
  folders: string[],
  appDb: AppDatabase,
  onProgress?: (progress: IndexProgress) => void,
  excludedPaths: string[] = [],
  explicitIncludes: string[] = [],
  options: IndexOptions = {}
): Promise<IndexSummary> {
  const summary: IndexSummary = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    removed: 0,
    skippedDataless: 0,
    keptCloudOnly: 0,
    ocrRecognized: 0,
    ocrPending: 0
  };

  if (folders.length === 0) {
    onProgress?.({ total: 0, current: 0, status: 'completed' });
    return summary;
  }

  onProgress?.({ total: 0, current: 0, status: 'scanning' });

  // 1. Scan filesystem
  const scanStats: ScanStats = {
    skippedDatalessSupportedCount: 0,
    skippedDatalessPaths: new Set(),
    listedDirectories: new Map(),
    cloudOnlyDirectories: new Set(),
    unansweredDirectories: new Set(),
    refusedPaths: new Set()
  };
  const scannedFiles = await scanDirectories(folders, excludedPaths, explicitIncludes, scanStats);
  summary.scanned = scannedFiles.length;
  const cloudOnlyPaths = scanStats.skippedDatalessPaths ?? new Set<string>();
  const listedDirectories = scanStats.listedDirectories ?? new Map<string, number>();
  const cloudOnlyDirectories = scanStats.cloudOnlyDirectories ?? new Set<string>();
  const unansweredDirectories = scanStats.unansweredDirectories ?? new Set<string>();
  const refusedPaths = scanStats.refusedPaths ?? new Set<string>();
  const exclusions = resolveExclusions(excludedPaths);

  const scannedPathSet = new Set(scannedFiles.map(f => f.path));

  // 2. Detect and remove deleted / excluded files for these folders.
  // Path-only projection: this reconciliation only ever compares doc.path,
  // so loading every document's full content here (SELECT *) would be a
  // large, unnecessary synchronous read for big corpora.
  const allDbDocs = appDb.getAllDocumentPaths();
  const pathsToRemove: string[] = [];
  // Entries kept for cloud-only files the scan saw. Only these come off the
  // "yalnızca bulutta" figure below: the documents in a folder the scan did
  // not read were never counted in it.
  let keptCloudOnlyFiles = 0;

  for (const doc of allDbDocs) {
    // If document is under an excluded path, remove it immediately -- also
    // when an earlier version reached it through a link into an excluded
    // folder, which the scan now refuses.
    if (isPathExcluded(doc.path, excludedPaths)
      || refusedPaths.has(doc.path) || isInAnyFolder(doc.path, refusedPaths)) {
      pathsToRemove.push(doc.path);
      continue;
    }

    const belongsToMonitoredFolder = folders.some(folder => isPathOrSubpath(folder, doc.path));

    if (belongsToMonitoredFolder && !scannedPathSet.has(doc.path)) {
      // The file is still there; only its content has gone to the cloud
      // (iCloud "Optimize Mac Storage", OneDrive "Free up space"). Its text is
      // already in the index and cannot be read again without downloading the
      // file, so the entry stays searchable instead of counting as deleted.
      if (cloudOnlyPaths.has(doc.path)) {
        summary.keptCloudOnly++;
        keptCloudOnlyFiles++;
        continue;
      }
      // The same for a document in a folder that went to the cloud as a
      // whole, which the scan did not read. A folder that did not answer in
      // time keeps its entries too.
      if (isInAnyFolder(doc.path, cloudOnlyDirectories)) {
        summary.keptCloudOnly++;
        continue;
      }
      if (isInAnyFolder(doc.path, unansweredDirectories)) {
        continue;
      }
      // A disconnected disk or an unreadable folder keeps its entries; a
      // deleted or moved file or folder does not.
      if (isGoneFromScannedTree(doc.path, listedDirectories)) {
        pathsToRemove.push(doc.path);
      }
    }
  }

  if (pathsToRemove.length > 0) {
    appDb.deleteDocuments(pathsToRemove);
    summary.removed = pathsToRemove.length;
    // Their text must not stay behind: not in the search index's segments,
    // and not in the write-ahead log until the next checkpoint.
    appDb.compactSearchIndex();
    appDb.truncateWriteAheadLog();
  }
  summary.skippedDataless = Math.max(0, scanStats.skippedDatalessSupportedCount - keptCloudOnlyFiles);

  // 3. Process each scanned file (incremental)
  const ocr = options.ocr;
  let ocrSpentMs = 0;
  const ocrBudgetLeft = () => ocr !== undefined && ocrSpentMs < ocr.budgetMs;

  // A PDF's text: its text layer, with the pages that carry almost none read
  // by text recognition when this update has budget left for it. Otherwise
  // the document keeps what its text layer has and waits.
  async function readPdf(file: ScannedFile): Promise<{ content: string; ocr: OcrState }> {
    const filePath = file.path;
    const pages = await extractPdfPageTexts(filePath);
    const sparse = pages.flatMap((text, i) => (visibleChars(text) < SPARSE_PAGE_CHARS ? [i + 1] : []));
    const joined = () => pages.join('\n').trim();
    if (sparse.length === 0) return { content: joined(), ocr: 'none' };
    if (!ocr) return { content: joined(), ocr: 'pending' };
    if (!ocrBudgetLeft()) {
      summary.ocrPending++;
      return { content: joined(), ocr: 'pending' };
    }
    const started = Date.now();
    // The recognizer has its own timeout per page; this is the backstop.
    options.onReading?.(file, ocrTimeoutMs(sparse.length) + 2 * 60 * 1000);
    try {
      const recognized = await ocr.engine.recognizePdfPages(filePath, sparse);
      let added = false;
      sparse.forEach((pageNumber, i) => {
        // A short page with real text reads the same either way, so
        // recognition only counts when it finds more. Even then it is added,
        // not swapped in: what the text layer has is exact, and a stamp or a
        // file number must stay searchable as written.
        if (visibleChars(recognized[i] ?? '') > visibleChars(pages[pageNumber - 1])) {
          pages[pageNumber - 1] = `${pages[pageNumber - 1]}\n${recognized[i]}`.trim();
          added = true;
        }
      });
      if (added) summary.ocrRecognized++;
      return { content: joined(), ocr: added ? 'text' : 'empty' };
    } catch (error) {
      if (error instanceof ContentNotLocallyAvailableError) {
        summary.ocrPending++;
        return { content: joined(), ocr: 'pending' };
      }
      return { content: joined(), ocr: 'failed' };
    } finally {
      ocrSpentMs += Date.now() - started;
    }
  }

  function isStillReadable(filePath: string): boolean {
    try {
      return !isPathExcluded(fs.realpathSync(filePath), exclusions);
    } catch {
      return false;
    }
  }

  let currentIdx = 0;
  for (const file of scannedFiles) {
    currentIdx++;
    onProgress?.({
      total: scannedFiles.length,
      current: currentIdx,
      currentFile: file.filename,
      status: 'indexing'
    });

    const existing = appDb.getDocumentByPath(file.path);
    const isPdf = file.extension === '.pdf';

    // Incremental check: mtime + size unchanged. A file that could not be read
    // is tried again unless the caller said not to (automatic updates). A PDF
    // is not settled until its pages have been checked (older indexes), nor
    // while text recognition still has work on it and is available.
    const unchanged = existing && existing.mtime === file.mtime && existing.size === file.size;
    const awaitsOcr = isPdf && ocr !== undefined
      && (existing?.ocr === 'pending' || (existing?.ocr === 'failed' && options.retryFailed !== false));
    const uncheckedPdf = isPdf && existing !== undefined && existing.ocr == null && existing.index_status !== 'failed';
    const settled = !awaitsOcr && !uncheckedPdf && (
      existing?.index_status === 'indexed' || existing?.index_status === 'no_text'
      || (existing?.index_status === 'failed' && options.retryFailed === false));
    if (unchanged && settled) {
      summary.skipped++;
      continue;
    }

    // Reading the text layer again only makes sense when it can be recognized now.
    if (unchanged && awaitsOcr && !ocrBudgetLeft()) {
      if (existing?.ocr === 'pending') summary.ocrPending++;
      continue;
    }

    // The file is read only if it still leads where the scan saw it lead: a
    // file swapped for a link (into an excluded folder, say) since the scan is
    // left alone.
    if (!isStillReadable(file.path)) {
      summary.skipped++;
      continue;
    }

    options.onReading?.(file, documentReadLimitMs(file.size));

    // Extract text
    let content = '';
    let status: 'indexed' | 'failed' | 'no_text' = 'indexed';
    let ocrState: OcrState | null = null;

    try {
      if (isPdf) {
        const read = await readPdf(file);
        content = read.content;
        ocrState = read.ocr;
      } else {
        content = await extract(file.path);
      }
      if (!content || !content.trim()) {
        status = 'no_text';
      } else {
        status = 'indexed';
      }
    } catch (error) {
      if (error instanceof ContentNotLocallyAvailableError) {
        // The scanner's availability pass should already have filtered this
        // file out; reaching here means the extractor boundary caught it. Count
        // it as a cloud skip rather than an extraction failure, and leave any
        // existing index entry alone instead of overwriting it with no text.
        summary.skippedDataless++;
        continue;
      }
      // An unchanged document that was read before is only being looked at
      // again for text recognition: a read that fails now says nothing about
      // the text already in the index, which must not be wiped.
      if (unchanged && existing?.index_status !== 'failed') {
        summary.skipped++;
        continue;
      }
      // Extraction failed for this specific file, mark failed and continue
      status = 'failed';
      content = '';
      summary.failed++;
    }

    const docRecord: DocumentRecord = {
      path: file.path,
      filename: file.filename,
      extension: file.extension,
      mtime: file.mtime,
      size: file.size,
      content,
      index_status: status,
      ocr: ocrState
    };

    appDb.upsertDocument(docRecord);

    if (status !== 'failed') {
      summary.indexed++;
    }
  }

  onProgress?.({
    total: scannedFiles.length,
    current: scannedFiles.length,
    status: 'completed',
    skippedDataless: summary.skippedDataless
  });

  return summary;
}

export async function indexAccessibleDocuments(
  appDb: AppDatabase,
  onProgress?: (progress: IndexProgress) => void,
  options: IndexOptions = {}
): Promise<IndexSummary> {
  const mode = appDb.getSearchScopeMode();
  const excludedPaths = appDb.getExcludedFolders();
  const userIncludes = appDb.getIncludedFolders();

  if (mode === 'selected') {
    if (userIncludes.length === 0) {
      onProgress?.({ total: 0, current: 0, status: 'completed' });
      return { scanned: 0, indexed: 0, skipped: 0, failed: 0, removed: 0, skippedDataless: 0, keptCloudOnly: 0, ocrRecognized: 0, ocrPending: 0 };
    }
    return await indexFolders(userIncludes, appDb, onProgress, excludedPaths, userIncludes, options);
  } else {
    const defaultRoots = await discoverSearchRoots();
    return await indexFolders(defaultRoots, appDb, onProgress, excludedPaths, userIncludes, options);
  }
}
