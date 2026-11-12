// Keeps the index -- which holds the text of every document MetinBul read --
// readable by its owner only.
//
// On macOS and Linux that means 0700 on the folder and 0600 on the database
// and SQLite's companion files (-wal, -shm, -journal). The folder in
// Application Support is already private on a stock macOS, but the files in it
// were created world-readable (0644), and copies of them (a backup disk, a
// migrated profile) keep that mode. On Windows the folder sits in the user's
// profile (%APPDATA%), whose inherited ACL already admits only the user,
// SYSTEM and Administrators; MetinBul leaves it as it is, and
// tests/security/windows_acl.test.ts checks it on the Windows CI runner.
//
// Nothing here throws on a permission it cannot change: MetinBul must still
// start (an index on a disk that ignores ownership, a folder owned by someone
// else). It never follows a link to change a file, and never loosens a mode.
import * as fs from 'fs';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const SQLITE_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

type Kind = 'directory' | 'file';

// Changes the mode by path, after lstat has shown a real file or folder that
// this user owns: a link is never followed. The files are deliberately not
// opened -- POSIX record locks belong to the process, and closing any
// descriptor of a database file drops the locks every SQLite connection in
// MetinBul (main process, indexer and search threads) holds on it.
function restrictMode(target: string, mode: number, kind: Kind): void {
  try {
    const st = fs.lstatSync(target);
    if (kind === 'directory' ? !st.isDirectory() : !st.isFile()) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    const current = st.mode & 0o777;
    const wanted = current & mode;
    if (wanted !== current) fs.chmodSync(target, wanted);
  } catch {
    // Missing, or a volume that does not keep POSIX modes (exFAT, SMB).
  }
}

/**
 * Creates the folder with mode 0700, or narrows an existing one to it. A
 * folder the user replaced with a link (Application Support moved to another
 * disk) is followed once, to the real folder, and narrowed there if it is
 * theirs.
 */
export function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform === 'win32') return;
  let real = dir;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) real = fs.realpathSync(dir);
  } catch {
    return;
  }
  restrictMode(real, PRIVATE_DIR_MODE, 'directory');
}

/** Narrows the database and its companion files to 0600 where they exist. */
export function restrictDatabaseFiles(dbPath: string): void {
  if (process.platform === 'win32' || dbPath === ':memory:') return;
  for (const suffix of SQLITE_FILE_SUFFIXES) {
    restrictMode(`${dbPath}${suffix}`, PRIVATE_FILE_MODE, 'file');
  }
}
