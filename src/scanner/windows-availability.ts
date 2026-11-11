// Windows content-availability guard for cloud "Files On-Demand" placeholders.
//
// PROBLEM
// -------
// On Windows, a sync engine built on the Cloud Files API (cldflt.sys) exposes
// online-only files as *dehydrated placeholders*: the directory entry, name,
// size and timestamps are all present locally, but the file data is not. Any
// normal read of the file's data transparently triggers hydration -- Windows
// downloads the whole file and shows the user an "Automatic file downloads"
// toast naming the app that caused it. Indexing must never do that.
//
// DETECTION
// ---------
// The reparse point that implements the placeholder is deliberately hidden by
// the platform from every process except sync engines and processes under
// %systemroot% (see RtlSetProcessPlaceholderCompatibilityMode), so reparse-tag
// inspection is not available to us. The documented, app-visible signal is the
// file attribute bitmask:
//
//   FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS (0x00400000)
//     "the file or directory is not fully present locally. For a file that
//      means that not all of its data is on local storage [...] Reading the
//      file will be more expensive than normal, e.g. it will cause at least
//      some of the file content to be fetched from a remote store."
//     This bit is set on a dehydrated placeholder and cleared once the file
//     has been hydrated, so it distinguishes an online-only file from a
//     locally available cloud file. Only kernel-mode callers can set it.
//
//   FILE_ATTRIBUTE_OFFLINE (0x00001000)
//     "The data of a file is not available immediately. This attribute
//      indicates that the file data is physically moved to offline storage."
//     Used by hierarchical storage management software. Included so that
//     non-CFAPI HSM providers are covered too.
//
// Reading attributes does not open the file for data access and therefore
// cannot hydrate it.
//
// DELIBERATELY NOT USED
// ---------------------
//   FILE_ATTRIBUTE_RECALL_ON_OPEN (0x00040000)
//     Numerically identical to FILE_ATTRIBUTE_EA (0x00040000). Microsoft
//     documents that the recall meaning "only appears in directory enumeration
//     classes"; from a per-path attribute query the same bit means "file has
//     extended attributes". Acting on it here would skip ordinary local files
//     that merely carry EAs, so it is excluded. See DOCUMENTED AMBIGUITY below.
//
//   FILE_ATTRIBUTE_PINNED (0x00080000) / FILE_ATTRIBUTE_UNPINNED (0x00100000)
//     These record the *user's pin intent*, not the current hydration state.
//     Microsoft's own Files On-Demand documentation maps "online-only" to
//     `attrib +u` and notes that unpinning only frees space -- an unpinned file
//     stays hydrated until the system actually reclaims it. Skipping on
//     UNPINNED would therefore skip locally available files.
//
//   FILE_ATTRIBUTE_REPARSE_POINT (0x00000400)
//     Hydrated cloud files remain reparse points, and junctions/symlinks are
//     reparse points too. Not an availability signal.
//
//   Allocation-size / sparse heuristics (size > 0 && blocks === 0)
//     Also true of small NTFS files stored resident in the MFT, so this would
//     silently drop ordinary local documents.
//
// DOCUMENTED AMBIGUITY
// --------------------
// Bit 0x00040000 is genuinely ambiguous when read per-path (EA vs.
// RECALL_ON_OPEN). The least-surprising safe behavior for that narrowly
// identified class is to ignore the bit: a dehydrated CFAPI placeholder always
// also carries RECALL_ON_DATA_ACCESS, so no online-only OneDrive file is missed
// by excluding it, while ordinary local files with extended attributes keep
// being indexed.
//
// This module is provider-agnostic on purpose: it never looks at path names,
// never special-cases "OneDrive", and never talks to any cloud service.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Documented Windows file attribute constants (WinNT.h). */
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
export const FILE_ATTRIBUTE_OFFLINE = 0x00001000;
/** Same numeric value as FILE_ATTRIBUTE_EA -- see DELIBERATELY NOT USED above. */
export const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000;
export const FILE_ATTRIBUTE_PINNED = 0x00080000;
export const FILE_ATTRIBUTE_UNPINNED = 0x00100000;
export const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000;

/**
 * The bits that positively identify "content is not on this device".
 * Intentionally narrow: only attributes whose documented meaning is that a
 * read would fetch data from a remote store.
 */
export const WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK =
  FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

/**
 * Pure decision logic, split out from the OS reader so it can be tested
 * deterministically on any platform.
 *
 * `undefined` means "attributes could not be read". That is treated as
 * online-only (fail closed), mirroring the existing macOS policy: an unknown
 * item may be a placeholder, and the cost of guessing wrong is an involuntary
 * download of the user's cloud data.
 */
export function isWindowsOnlineOnlyPlaceholder(attributes: number | undefined): boolean {
  if (typeof attributes !== 'number' || !Number.isFinite(attributes)) {
    return true;
  }
  return (attributes & WINDOWS_ONLINE_ONLY_ATTRIBUTE_MASK) !== 0;
}

/**
 * Parses the attribute reader's output. One `index:value` pair per line, where
 * `index` is the 1-based position of the path in the request batch (paths are
 * never echoed back, so paths containing odd characters cannot corrupt the
 * mapping) and `value` is the raw attribute DWORD in decimal.
 */
export function parseWindowsAttributeOutput(
  output: string,
  filePaths: string[]
): Map<string, number> {
  const attributesByPath = new Map<string, number>();

  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+):(\d+)$/);
    if (!match) continue;

    const filePath = filePaths[Number(match[1]) - 1];
    const attributes = Number(match[2]);
    if (filePath !== undefined && Number.isFinite(attributes)) {
      attributesByPath.set(filePath, attributes);
    }
  }

  return attributesByPath;
}

/**
 * Windows rejects paths longer than MAX_PATH (260) through the classic API that
 * PowerShell 5.1 uses, while Node's fs already handles them. Without this, a
 * deeply nested -- but perfectly local -- document would come back with
 * unreadable attributes and be skipped by the fail-closed rule. The extended
 * length prefix lifts that limit.
 */
export function toExtendedLengthPath(filePath: string): string {
  if (filePath.length < 248 || filePath.startsWith('\\\\?\\')) {
    return filePath;
  }
  const normalized = filePath.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\')) {
    // UNC: \\server\share -> \\?\UNC\server\share
    return '\\\\?\\UNC\\' + normalized.slice(2);
  }
  if (/^[A-Za-z]:\\/.test(normalized)) {
    return '\\\\?\\' + normalized;
  }
  return filePath;
}

// Reads one attribute DWORD per input line and emits "<1-based index>:<value>".
//
// `Get-Item` resolves to GetFileAttributesEx-class metadata only: it never opens
// the file for data access, so it cannot hydrate a placeholder. `.value__` is
// the enum's backing integer, read without a locale-dependent ToString of the
// flag names.
//
// Paths are passed through a UTF-8 temp file read with an explicit `-Encoding
// UTF8` rather than through stdin or argv: stdin in Windows PowerShell is
// decoded with the console's OEM code page, which would corrupt the Turkish
// characters that are common in this app's corpus, and argv is capped at ~32k.
// Only the batch index is echoed back, so no path can corrupt the mapping.
export function buildAttributeReaderScript(listPath: string): string {
  // Single-quoted PowerShell literal: the only character needing escaping is
  // the quote itself, which a user name like C:\Users\O'Brien\... can contain.
  const quoted = `'${listPath.replace(/'/g, "''")}'`;
  return (
    '$i = 0; ' +
    `Get-Content -LiteralPath ${quoted} -Encoding UTF8 | ForEach-Object { ` +
    // $i advances for every input line, including ones Get-Item cannot read,
    // so the emitted index always refers to the right entry of the batch.
    '$i++; ' +
    '$a = (Get-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue).Attributes; ' +
    'if ($null -ne $a) { $i.ToString() + ":" + $a.value__.ToString() } }'
  );
}

const POWERSHELL_CANDIDATES = ['powershell.exe', 'pwsh.exe'];
const WINDOWS_ATTRIBUTE_BATCH_SIZE = 1000;
const ATTRIBUTE_READER_TIMEOUT_MS = 30000;

let listFileCounter = 0;

function runAttributeReader(executable: string, filePaths: string[]): Promise<string | null> {
  // ASCII-only, quote-free name so it can be embedded in the script literal.
  const listPath = path.join(
    os.tmpdir(),
    `metinbul-attrs-${process.pid}-${listFileCounter++}.txt`
  );

  try {
    fs.writeFileSync(
      listPath,
      filePaths.map(toExtendedLengthPath).join('\r\n') + '\r\n',
      { encoding: 'utf8' }
    );
  } catch {
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(
        executable,
        [
          '-NoProfile', '-NonInteractive', '-NoLogo',
          '-ExecutionPolicy', 'Bypass',
          '-Command', buildAttributeReaderScript(listPath)
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
    } catch {
      try { fs.unlinkSync(listPath); } catch { /* best effort */ }
      resolve(null);
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(listPath); } catch { /* best effort */ }
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, ATTRIBUTE_READER_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.on('error', () => finish(null));
    child.on('close', () => finish(stdout));
  });
}

// Which PowerShell host actually worked, resolved once per process so a missing
// powershell.exe does not cost a failed spawn on every batch.
let resolvedExecutable: string | null | undefined;

/**
 * Reads Windows file attributes for a batch of paths without opening file
 * content. Returns an empty/partial map when attributes cannot be read; callers
 * must treat a missing entry as online-only (see isWindowsOnlineOnlyPlaceholder).
 */
export async function readWindowsFileAttributes(filePaths: string[]): Promise<Map<string, number>> {
  const attributesByPath = new Map<string, number>();
  if (process.platform !== 'win32' || filePaths.length === 0) {
    return attributesByPath;
  }

  for (let offset = 0; offset < filePaths.length; offset += WINDOWS_ATTRIBUTE_BATCH_SIZE) {
    const chunk = filePaths.slice(offset, offset + WINDOWS_ATTRIBUTE_BATCH_SIZE);

    let output: string | null = null;
    if (resolvedExecutable) {
      output = await runAttributeReader(resolvedExecutable, chunk);
    } else if (resolvedExecutable === undefined) {
      for (const candidate of POWERSHELL_CANDIDATES) {
        output = await runAttributeReader(candidate, chunk);
        if (output !== null) {
          resolvedExecutable = candidate;
          break;
        }
      }
      if (output === null) {
        // No usable attribute reader on this machine. Remember it so the rest
        // of the scan does not re-probe, and fail closed for every file.
        resolvedExecutable = null;
      }
    }

    if (output === null) continue;

    for (const [filePath, attributes] of parseWindowsAttributeOutput(output, chunk)) {
      attributesByPath.set(filePath, attributes);
    }
  }

  return attributesByPath;
}

// ---------------------------------------------------------------------------
// Verified-local ledger
//
// The scanner is the single place that decides availability in bulk. It records
// the paths it positively cleared here so that the extractor boundary can
// re-assert the invariant for free. Any path that reaches an extractor without
// having been cleared is re-checked individually rather than trusted, which is
// what makes it structurally hard for a future extractor or code path to read
// placeholder content by accident.
// ---------------------------------------------------------------------------

const VERIFIED_LOCAL_CAP = 250_000;
const verifiedLocalPaths = new Set<string>();

function ledgerKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

export function markContentVerifiedLocal(filePath: string): void {
  if (process.platform !== 'win32') return;
  if (verifiedLocalPaths.size >= VERIFIED_LOCAL_CAP) return;
  verifiedLocalPaths.add(ledgerKey(filePath));
}

export function clearVerifiedLocalLedger(): void {
  verifiedLocalPaths.clear();
}

export function isContentVerifiedLocal(filePath: string): boolean {
  return verifiedLocalPaths.has(ledgerKey(filePath));
}

/**
 * Thrown instead of reading the content of a file whose data is not on this
 * device. The indexer maps this to the existing "content isn't on this device"
 * skip counter rather than to a generic extraction failure.
 */
export class ContentNotLocallyAvailableError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`Content is not available on this device: ${filePath}`);
    this.name = 'ContentNotLocallyAvailableError';
    this.filePath = filePath;
  }
}

/**
 * Last line of defence, executed at the single extractor dispatch point before
 * any format-specific code receives the path. On a normal indexing run every
 * path has already been cleared by the scanner, so this is a Set lookup; an
 * uncleared path costs one metadata-only attribute read.
 */
export async function assertContentLocallyAvailable(filePath: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (isContentVerifiedLocal(filePath)) return;

  const attributes = (await readWindowsFileAttributes([filePath])).get(filePath);
  if (isWindowsOnlineOnlyPlaceholder(attributes)) {
    throw new ContentNotLocallyAvailableError(filePath);
  }
  markContentVerifiedLocal(filePath);
}
