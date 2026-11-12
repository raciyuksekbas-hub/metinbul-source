// Temporary files for text recognition and Windows' attribute reader.
//
// An OCR job's files hold a document's path and the text recognised in it, so
// each job gets a folder of its own with a random name (mkdtemp: mode 0700 on
// macOS; on Windows %TEMP% is inside the user's profile), and the folder goes
// as soon as the job ends. A run that ended before its cleanup (a crash, a
// forced quit) is tidied up at the next launch.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PREFIX = 'metinbul-';
// Folders made by makePrivateTempDir: metinbul-<kind>-<6 random characters>.
const JOB_DIR = /^metinbul-(ocr|attrs)-[A-Za-z0-9]{6}$/;
// Files left by versions up to 0.4.2, which wrote straight into the temp
// folder: metinbul-ocr-<pid>-<n>.json/.txt and metinbul-attrs-<pid>-<n>.txt.
const LEGACY_FILE = /^metinbul-(ocr|attrs)-\d+-\d+\.(json|txt)$/;

export function makePrivateTempDir(kind: 'ocr' | 'attrs', tempRoot = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(tempRoot, `${PREFIX}${kind}-`));
}

export function removePrivateTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort; removeStalePrivateTempFiles gets it next time.
  }
}

/**
 * Removes MetinBul's own temporary files and folders older than `maxAgeMs`
 * (a running job's are younger). Only names MetinBul uses are touched, never
 * through a link, and on macOS only entries this user owns. Returns how many
 * entries went.
 */
export function removeStalePrivateTempFiles(
  maxAgeMs = 60 * 60 * 1000,
  now = Date.now(),
  tempRoot = os.tmpdir()
): number {
  let names: string[];
  try {
    names = fs.readdirSync(tempRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const isDir = JOB_DIR.test(name);
    if (!isDir && !LEGACY_FILE.test(name)) continue;
    const target = path.join(tempRoot, name);
    try {
      const st = fs.lstatSync(target);
      if (isDir ? !st.isDirectory() : !st.isFile()) continue;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { recursive: isDir, force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}
