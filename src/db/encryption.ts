// Encryption of the index at rest.
//
// The index holds the text of every document MetinBul read. It is encrypted
// with SQLite3 Multiple Ciphers (ChaCha20-Poly1305, the `better-sqlite3`
// dependency is the better-sqlite3-multiple-ciphers build) under a random
// 256-bit key. The key never sits next to the database in the clear: it is
// kept in metinbul.key, sealed by the operating system (Electron's
// safeStorage: the macOS Keychain, Windows DPAPI). See KeyProtector.
//
// What it protects against: someone who has the index file but not the
// user's logged-in session -- another user of the computer, a copied
// profile, a backup disk, a stolen disk without FileVault/BitLocker. What it
// does not: a program already running as the user while MetinBul runs (on
// Windows DPAPI admits any program of the same user, and any such program can
// read what MetinBul shows).
//
// No Electron import here, so tests can drive all of it.
import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensurePrivateDirectory } from './private-files.js';

export const KEY_FILE_NAME = 'metinbul.key';
const SQLITE_HEADER = 'SQLite format 3\0';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Seals the key with something only this user's session can open. */
export interface KeyProtector {
  // 'safeStorage' in packaged builds; 'development' (no protection at all)
  // in unpackaged ones, so a developer's Keychain is never touched.
  readonly kind: 'safeStorage' | 'development';
  isAvailable(): boolean;
  protect(secret: string): Buffer;
  unprotect(sealed: Buffer): string;
}

export class KeyUnavailableError extends Error {}

// A key sealed by the packaged app (Keychain/DPAPI) met by a development
// build, which has no way to unseal it: not a lost key, so nothing is moved.
export class KeyProtectorMismatchError extends Error {}

export function newKeyHex(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** 'missing' (no file or an empty one), 'plain' or 'encrypted'. */
export function databaseFormat(dbPath: string): 'missing' | 'plain' | 'encrypted' {
  let fd: number;
  try {
    fd = fs.openSync(dbPath, 'r');
  } catch {
    return 'missing';
  }
  try {
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    if (read === 0) return 'missing';
    return header.subarray(0, read).toString('latin1') === SQLITE_HEADER ? 'plain' : 'encrypted';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keys a fresh connection. Has to come before anything else touches the
 * file; a wrong key shows at the first read as SQLITE_NOTADB, which this
 * provokes right away.
 */
export function applyKey(db: DatabaseType, keyHex: string): void {
  if (!KEY_PATTERN.test(keyHex)) throw new Error('malformed index key');
  db.pragma("cipher = 'chacha20'");
  db.pragma(`key = 'raw:${keyHex}'`);
  db.prepare('SELECT count(*) FROM sqlite_master').get();
}

interface KeyFile {
  version: 1;
  protector: KeyProtector['kind'];
  sealed: string; // base64
}

/** The key, or null when there is no key file. Throws KeyUnavailableError when there is one that cannot be opened. */
export function readKey(keyPath: string, protector: KeyProtector): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(keyPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new KeyUnavailableError(`key file unreadable: ${(error as Error).message}`);
  }
  let file: KeyFile;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new KeyUnavailableError('key file corrupt');
  }
  if (file.protector !== 'development' && protector.kind === 'development') {
    throw new KeyProtectorMismatchError('the key is sealed by the installed app');
  }
  let keyHex: string;
  try {
    const sealed = Buffer.from(file.sealed, 'base64');
    // A key a development build left in the clear is taken over and sealed.
    keyHex = file.protector === 'development' && protector.kind !== 'development'
      ? sealed.toString('utf8')
      : protector.unprotect(sealed);
  } catch (error) {
    throw new KeyUnavailableError(`key cannot be unsealed: ${(error as Error).message}`);
  }
  if (!KEY_PATTERN.test(keyHex)) throw new KeyUnavailableError('key file corrupt');
  if (file.protector !== protector.kind) writeKey(keyPath, keyHex, protector);
  return keyHex;
}

/** Writes the sealed key next to the database: a new file, 0600, renamed into place. */
export function writeKey(keyPath: string, keyHex: string, protector: KeyProtector): void {
  const file: KeyFile = { version: 1, protector: protector.kind, sealed: protector.protect(keyHex).toString('base64') };
  ensurePrivateDirectory(path.dirname(keyPath));
  const temp = `${keyPath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(file));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, keyPath);
}

/**
 * Encrypts a plain index in place. SQLite3MC's rekey rewrites every page in
 * one transaction under a rollback journal: if it is interrupted (power
 * loss, a forced quit) the next open rolls back and the index is the plain
 * one it was, untouched. Rekeying is not possible in WAL mode, so the index
 * leaves it for the rewrite and returns to it after.
 *
 * Note on what is left on disk: the pages are overwritten in place, but on
 * APFS and SSDs the old blocks are not erased by the file system; only disk
 * encryption (FileVault, BitLocker) covers them.
 */
export function encryptInPlace(dbPath: string, keyHex: string): void {
  if (!KEY_PATTERN.test(keyHex)) throw new Error('malformed index key');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.pragma("cipher = 'chacha20'");
    db.pragma(`rekey = 'raw:${keyHex}'`);
  } finally {
    db.close();
  }
  const check = new Database(dbPath, { fileMustExist: true });
  try {
    applyKey(check, keyHex);
    check.pragma('journal_mode = WAL');
  } finally {
    check.close();
  }
}

/** The way back: decrypts an encrypted index in place (same transaction guarantee). */
export function decryptInPlace(dbPath: string, keyHex: string): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    applyKey(db, keyHex);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.pragma("rekey = ''");
  } finally {
    db.close();
  }
  const check = new Database(dbPath, { fileMustExist: true });
  try {
    check.prepare('SELECT count(*) FROM sqlite_master').get();
    check.pragma('journal_mode = WAL');
  } finally {
    check.close();
  }
}

/**
 * MetinBul leaves WAL mode only to rekey, so a rollback journal left beside
 * the index means a rekey was cut short (a forced quit, a power cut). The
 * journal holds the pages as they were before: opening the index lets SQLite
 * put them back. Until that has happened the first page may already look
 * encrypted while the rest is not, so this runs before the format is judged.
 */
export function recoverInterruptedRekey(dbPath: string, keyHex: string | null): void {
  const journal = `${dbPath}-journal`;
  if (!fs.existsSync(journal) || fs.statSync(journal).size === 0) return;
  // Without a key first: the rollback copies the saved pages back as they
  // are, whichever way the rekey was going. Then with the key, for a rekey
  // that started from an encrypted index.
  for (const key of [null, keyHex]) {
    let db: DatabaseType | undefined;
    try {
      db = new Database(dbPath, { fileMustExist: true });
      if (key) applyKey(db, key);
      else db.prepare('SELECT count(*) FROM sqlite_master').get();
      return;
    } catch {
      // Try the next way in.
    } finally {
      db?.close();
    }
  }
}

/** Whether the key opens the index. */
export function keyOpens(dbPath: string, keyHex: string): boolean {
  let db: DatabaseType | undefined;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    applyKey(db, keyHex);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Moves an index nobody can open any more out of the way -- never deletes it:
 * should the key come back (a Keychain restored from a backup), it can be put
 * back. Returns where it went.
 */
export function moveAsideUnreadable(dbPath: string, stamp: string): string {
  const target = `${dbPath}.unreadable-${stamp}`;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (fs.existsSync(`${dbPath}${suffix}`)) fs.renameSync(`${dbPath}${suffix}`, `${target}${suffix}`);
  }
  return target;
}

export type KeyPreparation =
  // Open with this key: a new index, an encrypted one, or one just encrypted.
  | { status: 'new' | 'encrypted' | 'migrated'; keyHex: string }
  // The encrypted index could not be opened with any key there is: it was
  // moved aside and a new, empty one is started (the documents themselves
  // are untouched, only the index has to be rebuilt).
  | { status: 'key-lost'; keyHex: string; movedTo: string; reason: string }
  // Stays plain for now: encrypting it failed (tried again at the next start),
  // or nothing can seal a key on this system.
  | { status: 'migration-failed'; error: string; reason?: 'disk-full' }
  | { status: 'no-protector' }
  // Encrypted, but the system cannot unseal keys right now (a locked
  // keychain): nothing is touched and MetinBul cannot open its index.
  | { status: 'protector-unavailable' };

export interface PrepareOptions {
  dbPath: string;
  protector: KeyProtector;
  // Runs encryptInPlace -- in the app on a worker thread, so the windows
  // stay responsive for the few seconds a large index takes.
  encryptExisting: (dbPath: string, keyHex: string) => Promise<void>;
  stamp?: string;
  // Free space where the index lives (null if unknown); for tests.
  freeBytes?: (dir: string) => number | null;
}

/** The index's size and its write-ahead log's, plus 64 MB to spare. */
export function encryptionSpaceNeeded(dbPath: string): number {
  let size = 0;
  for (const suffix of ['', '-wal']) {
    try {
      size += fs.statSync(`${dbPath}${suffix}`).size;
    } catch {
      // Not there.
    }
  }
  return size + 64 * 1024 * 1024;
}

function freeBytesAt(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** Decides, at start, how the index is opened, and does what that takes. */
export async function prepareDatabaseKey(options: PrepareOptions): Promise<KeyPreparation> {
  const { dbPath, protector } = options;
  const keyPath = path.join(path.dirname(dbPath), KEY_FILE_NAME);
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');

  let existing: string | null = null;
  let unsealError: string | null = null;
  let mismatch = false;
  if (protector.isAvailable()) {
    try {
      existing = readKey(keyPath, protector);
    } catch (error) {
      if (error instanceof KeyProtectorMismatchError) mismatch = true;
      else unsealError = (error as Error).message;
    }
  }

  recoverInterruptedRekey(dbPath, existing);
  const format = databaseFormat(dbPath);

  if (!protector.isAvailable() || mismatch) {
    return format === 'encrypted' ? { status: 'protector-unavailable' } : { status: 'no-protector' };
  }

  if (format === 'encrypted') {
    if (existing && keyOpens(dbPath, existing)) return { status: 'encrypted', keyHex: existing };
    const reason = unsealError ?? (existing ? 'the key does not open the index' : 'the key file is missing');
    const movedTo = moveAsideUnreadable(dbPath, stamp);
    // The old key file goes along with the index it belongs to, under the
    // same stamp, instead of being overwritten by the new key: should the
    // system that sealed it come back (a restored keychain, the profile back
    // on its own computer), the old index can still be opened with it.
    if (fs.existsSync(keyPath)) fs.renameSync(keyPath, `${keyPath}.unreadable-${stamp}`);
    const keyHex = newKeyHex();
    writeKey(keyPath, keyHex, protector);
    return { status: 'key-lost', keyHex, movedTo, reason };
  }

  // A key file that cannot be unsealed guards nothing yet (the index is
  // plain or missing): it is replaced.
  let keyHex = existing;
  if (!keyHex) {
    keyHex = newKeyHex();
    writeKey(keyPath, keyHex, protector);
  }
  if (format === 'missing') return { status: 'new', keyHex };

  // Rewriting the index in place keeps its old pages in a journal until it
  // is done: it needs about the index's size again in free space. Without
  // it, it would fail part way through (and roll back) at every start.
  const needed = encryptionSpaceNeeded(dbPath);
  const free = (options.freeBytes ?? freeBytesAt)(path.dirname(dbPath));
  if (free !== null && free < needed) {
    return { status: 'migration-failed', error: `not enough free disk space (${Math.round(free / 1024 ** 2)} MB free, ${Math.round(needed / 1024 ** 2)} MB needed)`, reason: 'disk-full' };
  }

  try {
    await options.encryptExisting(dbPath, keyHex);
  } catch (error) {
    // Rekeying is all or nothing; check which it was.
    if (databaseFormat(dbPath) === 'encrypted' && keyOpens(dbPath, keyHex)) return { status: 'migrated', keyHex };
    return { status: 'migration-failed', error: (error as Error).message };
  }
  return { status: 'migrated', keyHex };
}
