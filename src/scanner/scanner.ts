import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { SUPPORTED_EXTENSIONS } from '../extractors/index.js';
import {
  readWindowsFileAttributes,
  isWindowsOnlineOnlyPlaceholder,
  markContentVerifiedLocal,
  clearVerifiedLocalLedger
} from './windows-availability.js';

export interface ScannedFile {
  path: string;
  filename: string;
  extension: string;
  mtime: number;
  size: number;
}

// Optional mutable counter threaded through a scan so callers can surface
// "N supported documents were skipped because their content isn't on this
// device" without changing scanDirectory/scanDirectories' return shape
// (kept as plain ScannedFile[] for backward compatibility with existing
// callers/tests). Deliberately provider-agnostic: incremented purely from
// the existing generic SF_DATALESS/fail-closed check below, never from any
// path or provider-name match.
export interface ScanStats {
  skippedDatalessSupportedCount: number;
  // Paths of the files counted above, as the scan spells them. The indexer
  // keeps an existing index entry for these instead of treating them as
  // deleted: the file is still there, only its content has gone to the cloud.
  skippedDatalessPaths?: Set<string>;
  // Real paths (see listedDirectoryKey) of the directories whose listing this
  // scan read, with the number of entries in each. Lets the indexer tell a
  // file or folder that was deleted or moved from one that is merely
  // unreachable right now.
  listedDirectories?: Map<string, number>;
  // Folders this scan did not read, as the scan spells them: ones whose
  // content is only in the cloud, and ones that did not answer in time. The
  // indexer keeps every entry under them without touching their paths.
  cloudOnlyDirectories?: Set<string>;
  unansweredDirectories?: Set<string>;
  // Folders and files the scan would only have reached through a symbolic
  // link (or junction) into an excluded folder, as the scan spells them. They
  // are not read, and the indexer removes what an earlier version indexed
  // under them.
  refusedPaths?: Set<string>;
}

function realPathsOf(target: string): string[] {
  const out: string[] = [];
  for (const resolve of [fs.realpathSync.native, fs.realpathSync]) {
    try {
      out.push(resolve(target));
    } catch {
      // Missing or unreadable: the spelling as given still applies.
    }
  }
  return out;
}

/**
 * The excluded folders in both spellings -- as the user picked them and with
 * links resolved -- so that a folder reached through a symbolic link or a
 * junction is recognised as excluded too. (A link out of the search areas to
 * some other place, such as an external disk, is still followed: that is the
 * user's own link. A link into a folder the user excluded is not.)
 */
export function resolveExclusions(excludedPaths: string[] = []): string[] {
  const exclusions = new Set<string>();
  for (const excluded of excludedPaths) {
    if (!excluded) continue;
    exclusions.add(excluded);
    for (const real of realPathsOf(excluded)) exclusions.add(real);
  }
  return [...exclusions];
}

// Key for ScanStats.listedDirectories: case-insensitive on Windows, where
// two spellings of a real path can differ only in case.
export function listedDirectoryKey(realPath: string): string {
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

function recordSkippedDataless(scanStats: ScanStats | undefined, filePath: string) {
  if (!scanStats) return;
  scanStats.skippedDatalessSupportedCount++;
  scanStats.skippedDatalessPaths?.add(filePath);
}

const SF_DATALESS = 0x40000000;
const DARWIN_STAT_BATCH_SIZE = 200;

// How long an update waits for one folder's listing. A folder that does not
// answer in time -- a cloud folder whose provider hangs, a dead network share
// -- is left out of this update and its documents keep their index entries.
// Mutable so tests can shorten it.
export const directoryReadLimits = { timeoutMs: 20_000 };

async function readDirectoryWithinLimit(dir: string): Promise<fs.Dirent[] | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), directoryReadLimits.timeoutMs);
  });
  try {
    // The read itself cannot be cancelled: one that never returns keeps a
    // libuv thread (and so the worker) busy until the OS answers. Never
    // reading cloud-only folders is what keeps that rare.
    return await Promise.race([fs.promises.readdir(dir, { withFileTypes: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Depth-first order of two entries, each given as its positions along the
// path from the root.
function compareTreeOrder(a: readonly number[], b: readonly number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function parseDarwinStatFlagsOutput(output: string, filePaths: string[]): Map<string, number> {
  const flagsByPath = new Map<string, number>();

  for (const line of output.split(/\r?\n/)) {
    // BSD stat's alternate hex form includes "0x" for non-zero values but
    // prints a plain "0" when no flags are set.
    const match = line.trim().match(/^(\d+):(0x)?([0-9a-f]+)$/i);
    if (!match) continue;

    const fileIndex = Number(match[1]) - 1;
    const filePath = filePaths[fileIndex];
    const flags = Number.parseInt(match[3], 16);
    if (filePath && Number.isFinite(flags)) {
      flagsByPath.set(filePath, flags);
    }
  }

  return flagsByPath;
}

function readDarwinStatFlagsChunk(filePaths: string[]): Promise<Map<string, number>> {
  return new Promise(resolve => {
    execFile(
      '/usr/bin/stat',
      ['-L', '-f', '%@:%#Xf', '--', ...filePaths],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
      (_error, stdout) => resolve(parseDarwinStatFlagsOutput(String(stdout || ''), filePaths))
    );
  });
}

export async function readDarwinFileFlags(filePaths: string[]): Promise<Map<string, number>> {
  const flagsByPath = new Map<string, number>();
  if (process.platform !== 'darwin' || filePaths.length === 0) {
    return flagsByPath;
  }

  for (let offset = 0; offset < filePaths.length; offset += DARWIN_STAT_BATCH_SIZE) {
    const chunk = filePaths.slice(offset, offset + DARWIN_STAT_BATCH_SIZE);
    const chunkFlags = await readDarwinStatFlagsChunk(chunk);
    for (const [filePath, flags] of chunkFlags) {
      flagsByPath.set(filePath, flags);
    }
  }

  return flagsByPath;
}

/**
 * Windows content-availability pass.
 *
 * Runs once per scanned root, after the (metadata-only) directory walk and
 * before any candidate is handed to the indexer, so no online-only placeholder
 * ever reaches an extractor. It is a separate pass rather than an inline
 * per-directory check because the Windows attribute reader is a spawned
 * process: batching every candidate of a root into a small number of calls
 * keeps the cost flat, whereas one call per directory would not.
 *
 * The reader is injectable so the decision logic can be tested deterministically
 * on any platform; the OS-specific part stays behind readWindowsFileAttributes.
 */
export async function filterLocallyAvailableFiles(
  files: ScannedFile[],
  scanStats?: ScanStats,
  readAttributes: (paths: string[]) => Promise<Map<string, number>> = readWindowsFileAttributes
): Promise<ScannedFile[]> {
  if (files.length === 0) {
    return files;
  }

  const attributesByPath = await readAttributes(files.map(file => file.path));
  const locallyAvailable: ScannedFile[] = [];

  for (const file of files) {
    // Fail closed: a candidate whose attributes could not be read is treated as
    // online-only, because reading it to find out is exactly what must not happen.
    if (isWindowsOnlineOnlyPlaceholder(attributesByPath.get(file.path))) {
      recordSkippedDataless(scanStats, file.path);
      continue;
    }
    markContentVerifiedLocal(file.path);
    locallyAvailable.push(file);
  }

  return locallyAvailable;
}

export const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.cargo',
  '.rustup',
  '.venv',
  'venv',
  'env',
  '.cache',
  'caches',
  'application support',
  'containers',
  'logs',
  'applications'
]);

// macOS bundles: a program and its resources, never the user's documents. A
// .framework in a build folder inside iCloud Documents is where an update
// hung on the real profile (2026-10-29).
const BUNDLE_DIR_EXTENSIONS = new Set([
  '.app',
  '.framework',
  '.bundle',
  '.plugin',
  '.appex',
  '.xpc',
  '.kext',
  '.dsym'
]);

export function isPathOrSubpath(parent: string, candidate: string): boolean {
  if (!parent || !candidate) return false;
  const normParent = path.resolve(parent).replace(/\\/g, '/').replace(/\/+$/, '');
  const normCandidate = path.resolve(candidate).replace(/\\/g, '/');

  if (process.platform === 'win32' || parent.includes(':') || candidate.includes(':')) {
    const p = normParent.toLowerCase();
    const c = normCandidate.toLowerCase();
    return c === p || c.startsWith(p + '/');
  } else {
    const p = normParent;
    const c = normCandidate;
    return c === p || c.startsWith(p + '/');
  }
}

export function isPathExcluded(candidatePath: string, excludedPaths: string[] = []): boolean {
  if (!excludedPaths || excludedPaths.length === 0) return false;
  return excludedPaths.some(excluded => isPathOrSubpath(excluded, candidatePath));
}

export function isDatalessPlaceholder(stats?: fs.Stats, fallbackFlags?: number): boolean {
  // macOS APFS FileProvider dataless file flag (SF_DATALESS / UF_DATALESS = 0x40000000)
  const nativeFlags = stats && typeof (stats as any).flags === 'number'
    ? (stats as any).flags as number
    : undefined;
  const flags = nativeFlags ?? fallbackFlags;
  return typeof flags === 'number' && (flags & SF_DATALESS) !== 0;
}

export function shouldSkipFile(filename: string, stats?: fs.Stats, fallbackFlags?: number): boolean {
  const lower = filename.toLowerCase();
  // 1. Office lock files (e.g. ~$document.docx, ~$test.doc)
  if (filename.startsWith('~$')) {
    return true;
  }
  // 2. Temp files (*.tmp)
  if (lower.endsWith('.tmp')) {
    return true;
  }
  // 3. System meta files
  if (filename.startsWith('._') || lower === '.ds_store' || lower === 'thumbs.db') {
    return true;
  }
  // 4. Dataless / online-only cloud placeholders
  if (isDatalessPlaceholder(stats, fallbackFlags)) {
    return true;
  }
  return false;
}

export function shouldSkipDirectory(
  dirName: string,
  fullPath: string,
  excludedPaths: string[] = [],
  explicitIncludes: string[] = []
): boolean {
  // INVARIANT: USER EXCLUDE > USER EXPLICIT INCLUDE > SYSTEM / GLOBAL EXCLUDE
  
  // 1. User Explicit Exclude (Highest Priority)
  if (isPathExcluded(fullPath, excludedPaths)) {
    return true;
  }

  // 2. User Explicit Include (Overrides system/global exclusions for this branch)
  const isExplicitBranch = explicitIncludes.length > 0 && explicitIncludes.some(inc => 
    isPathOrSubpath(fullPath, inc) || isPathOrSubpath(inc, fullPath)
  );

  const lowerName = dirName.toLowerCase();
  const home = os.homedir();
  const libraryPath = path.join(home, 'Library');

  // If this directory is part of an explicit user include branch (e.g. ~/Library/CloudStorage/GoogleDrive-X):
  // Global Library rule or system folder exclusions must NOT block it.
  if (isExplicitBranch) {
    // Only skip critical low-level source control / trash dirs inside custom include
    if (lowerName === '.git' || lowerName === '.trash' || lowerName === '.trashes') {
      return true;
    }
    return false;
  }

  // 3. System / Global Exclude (Default fallback)
  if (EXCLUDED_DIR_NAMES.has(lowerName)) {
    return true;
  }

  if (BUNDLE_DIR_EXTENSIONS.has(path.extname(lowerName))) {
    return true;
  }

  if (fullPath.toLowerCase() === libraryPath.toLowerCase()) {
    return true;
  }

  return false;
}

export async function scanDirectory(
  dirPath: string,
  visitedDirs = new Set<string>(),
  excludedPaths: string[] = [],
  explicitIncludes: string[] = [],
  scanStats?: ScanStats,
  exclusions: string[] = resolveExclusions(excludedPaths)
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];
  const refuse = (lexicalPath: string) => scanStats?.refusedPaths?.add(lexicalPath);

  let realRoot: string;
  try {
    if (!fs.existsSync(dirPath)) {
      return results;
    }
    realRoot = fs.realpathSync(dirPath);
  } catch {
    return results;
  }

  // Check if directory itself is user-excluded
  if (isPathExcluded(dirPath, exclusions) || isPathExcluded(realRoot, exclusions)) {
    return results;
  }

  // Folders below are recorded under fs.promises.realpath, the native
  // resolver, which can spell a path differently (Windows 8.3 short names
  // such as RUNNER~1, letter case): the root goes in under both spellings,
  // or a link back to it would be walked once more.
  const rootSpellings = [realRoot];
  try {
    const nativeRoot = fs.realpathSync.native(dirPath);
    if (nativeRoot !== realRoot) rootSpellings.push(nativeRoot);
  } catch {
    // The spelling above stands.
  }
  if (rootSpellings.some(spelling => visitedDirs.has(spelling))) {
    return results;
  }
  for (const spelling of rootSpellings) visitedDirs.add(spelling);

  // A root whose content is only in the cloud is not read either (see below).
  if (isDatalessPlaceholder(undefined, (await readDarwinFileFlags([dirPath])).get(dirPath))) {
    scanStats?.cloudOnlyDirectories?.add(dirPath);
    return results;
  }

  // Folders are read one level at a time, so that the macOS file flags --
  // which only /usr/bin/stat can read -- come in a few calls per level rather
  // than one per folder. A folder whose content is only in the cloud (iCloud
  // "Optimize Mac Storage" offloads whole folders too) has to be recognised
  // before it is read: reading its listing makes the provider fetch it, and
  // the read hangs for as long as the provider does. `order` is an entry's
  // position along the path from the root, so the documents still come out
  // in the order of a depth-first walk.
  interface Found { path: string; order: number[]; stats?: fs.Stats }
  const candidates: Array<Found & { filename: string; extension: string; stats: fs.Stats }> = [];
  let level: Array<{ dir: string; realDir: string; order: number[] }> = [{ dir: dirPath, realDir: realRoot, order: [] }];

  while (level.length > 0) {
    const subfolders: Found[] = [];
    for (const { dir: currentDir, realDir, order } of level) {
      let entries: fs.Dirent[] | 'timeout';
      try {
        entries = await readDirectoryWithinLimit(currentDir);
      } catch {
        // Ignore directories that cannot be read (permission, broken link, offline cloud placeholder)
        continue;
      }
      if (entries === 'timeout') {
        scanStats?.unansweredDirectories?.add(currentDir);
        continue;
      }
      // Empty listings are recorded too (a folder whose last file was deleted is
      // empty), but the indexer does not take an empty folder as proof that a
      // missing subfolder was deleted: an unmounted mount point or a signed-out
      // cloud folder looks exactly like that.
      scanStats?.listedDirectories?.set(listedDirectoryKey(realDir), entries.length);

      for (const [index, entry] of entries.entries()) {
        // Skip office lock files (~$*), temp files (*.tmp), and system metadata
        if (shouldSkipFile(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        const entryOrder = [...order, index];
        const ext = path.extname(entry.name).toLowerCase();

        if (entry.isDirectory()) {
          if (!shouldSkipDirectory(entry.name, fullPath, excludedPaths, explicitIncludes)) {
            subfolders.push({ path: fullPath, order: entryOrder });
          }
        } else if (entry.isSymbolicLink()) {
          // A link into an excluded folder is not followed: the exclusion is
          // judged on where the link really leads, not on its own name.
          try {
            const target = await fs.promises.realpath(fullPath);
            if (isPathExcluded(target, exclusions)) {
              refuse(fullPath);
              continue;
            }
            const stat = await fs.promises.stat(target);
            if (stat.isDirectory()) {
              if (!shouldSkipDirectory(entry.name, fullPath, excludedPaths, explicitIncludes)
                && !shouldSkipDirectory(path.basename(target), target, excludedPaths, explicitIncludes)) {
                subfolders.push({ path: fullPath, order: entryOrder, stats: stat });
              }
            } else if (stat.isFile() && SUPPORTED_EXTENSIONS.has(ext)
              // The file it leads to has to be a document too: a link named
              // "Dilekce.pdf" to a program or a script is not one.
              && SUPPORTED_EXTENSIONS.has(path.extname(target).toLowerCase())) {
              candidates.push({ path: fullPath, filename: entry.name, extension: ext, stats: stat, order: entryOrder });
            }
          } catch {
            // Skip broken symlinks and link loops (ELOOP)
          }
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(ext)) {
          try {
            const stats = await fs.promises.stat(fullPath);
            candidates.push({ path: fullPath, filename: entry.name, extension: ext, stats, order: entryOrder });
          } catch {
            // Ignore files that cannot be stated (e.g. offline cloud placeholders, permission)
          }
        }
      }
    }

    const folderFlags = await readDarwinFileFlags(subfolders.map(folder => folder.path));
    const next: typeof level = [];
    for (const folder of subfolders) {
      if (isDatalessPlaceholder(folder.stats, folderFlags.get(folder.path))) {
        scanStats?.cloudOnlyDirectories?.add(folder.path);
        continue;
      }
      try {
        const realSub = await fs.promises.realpath(folder.path);
        // The same rule for a folder whose path runs through a link higher up.
        if (isPathExcluded(realSub, exclusions)) {
          refuse(folder.path);
          continue;
        }
        if (!visitedDirs.has(realSub)) {
          visitedDirs.add(realSub);
          next.push({ dir: folder.path, realDir: realSub, order: folder.order });
        }
      } catch {
        // If realpath fails (e.g. broken symlink, permission), skip
      }
    }
    level = next;
  }

  candidates.sort((a, b) => compareTreeOrder(a.order, b.order));
  const fileFlags = await readDarwinFileFlags(candidates.map(file => file.path));
  for (const file of candidates) {
    const fallbackFlags = fileFlags.get(file.path);
    // Fail closed on macOS when kernel flags cannot be read: opening an unknown
    // FileProvider item could hydrate remote-only content.
    if ((process.platform === 'darwin' && fallbackFlags === undefined) || isDatalessPlaceholder(file.stats, fallbackFlags)) {
      recordSkippedDataless(scanStats, file.path);
      continue;
    }
    results.push({
      path: file.path,
      filename: file.filename,
      extension: file.extension,
      mtime: Math.floor(file.stats.mtimeMs),
      size: file.stats.size
    });
  }

  // Windows cloud placeholders are invisible to stat(); resolve their content
  // availability from file attributes before these candidates go any further.
  if (process.platform === 'win32') {
    return await filterLocallyAvailableFiles(results, scanStats);
  }

  return results;
}

export async function scanDirectories(
  dirPaths: string[],
  excludedPaths: string[] = [],
  explicitIncludes: string[] = [],
  scanStats?: ScanStats
): Promise<ScannedFile[]> {
  // Availability is re-established from scratch on every scan: a file that was
  // locally available during the previous run may have been dehydrated since.
  clearVerifiedLocalLedger();

  const seenPaths = new Set<string>();
  const visitedDirs = new Set<string>();
  const combined: ScannedFile[] = [];
  const exclusions = resolveExclusions(excludedPaths);

  for (const dir of dirPaths) {
    const files = await scanDirectory(dir, visitedDirs, excludedPaths, explicitIncludes, scanStats, exclusions);
    for (const file of files) {
      if (!seenPaths.has(file.path)) {
        seenPaths.add(file.path);
        combined.push(file);
      }
    }
  }

  return combined;
}
