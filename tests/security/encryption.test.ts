// Encryption of the index at rest (src/db/encryption.ts). Synthetic data
// only. The key protector here is a stand-in for Electron's safeStorage.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppDatabase, normalizeForSearch } from '../../src/db/database.js';
import {
  databaseFormat,
  decryptInPlace,
  encryptionSpaceNeeded,
  encryptInPlace,
  KEY_FILE_NAME,
  KeyProtector,
  KeyProtectorMismatchError,
  KeyUnavailableError,
  keyOpens,
  newKeyHex,
  prepareDatabaseKey,
  readKey,
  writeKey
} from '../../src/db/encryption.js';

const ROOT = path.resolve(__dirname, '../..');
const isWindows = process.platform === 'win32';
const MARKER = 'GİZLİ MÜVEKKİL Ayşe Yılmaz 4471';

// Seals by XOR with a per-"user" byte, so a protector of another user (or a
// reset keychain) cannot unseal it.
function fakeProtector(userByte = 0x5a, kind: KeyProtector['kind'] = 'safeStorage', available = true): KeyProtector {
  if (kind === 'development') {
    // As in src/main/index-key.ts: no sealing at all.
    return { kind, isAvailable: () => available, protect: s => Buffer.from(s, 'utf8'), unprotect: b => b.toString('utf8') };
  }
  const xor = (b: Buffer) => Buffer.from(b.map(x => x ^ userByte));
  return {
    kind,
    isAvailable: () => available,
    protect: secret => Buffer.concat([Buffer.from('SEAL'), xor(Buffer.from(secret, 'utf8'))]),
    unprotect: sealed => {
      if (sealed.subarray(0, 4).toString() !== 'SEAL') throw new Error('not sealed by this protector');
      const out = xor(sealed.subarray(4)).toString('utf8');
      if (!/^[0-9a-f]{64}$/.test(out)) throw new Error('wrong user');
      return out;
    }
  };
}

let base: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-enc-')));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function doc(docPath: string, content: string) {
  return { path: docPath, filename: path.basename(docPath), extension: path.extname(docPath), mtime: 1, size: content.length, content, index_status: 'indexed' as const };
}

function fillIndex(dbPath: string, keyHex?: string, documents = 30) {
  const db = new AppDatabase(dbPath, { keyHex });
  db.db.transaction(() => {
    for (let i = 0; i < documents; i++) db.upsertDocument(doc(`/Belgeler/dava-${i}.udf`, `dilekçe ${i} tazminat istinaf `.repeat(80)));
    db.upsertDocument(doc('/Belgeler/gizli.udf', `başlangıç ${MARKER} bitiş`));
  })();
  db.truncateWriteAheadLog();
  db.close();
}

const filesHold = (dbPath: string, text: string) => ['', '-wal', '-shm', '-journal']
  .some(suffix => fs.existsSync(dbPath + suffix) && fs.readFileSync(dbPath + suffix).includes(Buffer.from(text, 'utf8')));

function searchCount(db: AppDatabase, term: string): number {
  return (db.db.prepare('SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH ?').get(`"${normalizeForSearch(term)}"`) as { n: number }).n;
}

// Filling and encrypting an index takes a few seconds on a busy Windows CI
// runner, past vitest's 5 s default.
describe('an encrypted index', { timeout: 30_000 }, () => {
  it('keeps no document text readable in its files, and searches as before', () => {
    const dbPath = path.join(base, 'metinbul.db');
    const key = newKeyHex();
    fillIndex(dbPath, key);

    expect(databaseFormat(dbPath)).toBe('encrypted');
    for (const text of [MARKER, normalizeForSearch(MARKER), 'tazminat istinaf', 'gizli.udf']) {
      expect(filesHold(dbPath, text), text).toBe(false);
    }
    const db = new AppDatabase(dbPath, { keyHex: key });
    expect(searchCount(db, 'Ayşe Yılmaz')).toBe(1);
    expect(searchCount(db, 'tazminat')).toBe(30);
    db.close();
  });

  it('does not open without its key, or with another one', () => {
    const dbPath = path.join(base, 'metinbul.db');
    const key = newKeyHex();
    fillIndex(dbPath, key);

    expect(() => new AppDatabase(dbPath)).toThrow(/not a database/);
    expect(() => new AppDatabase(dbPath, { keyHex: newKeyHex() })).toThrow(/not a database/);
    expect(() => new AppDatabase(dbPath, { queryOnly: true, keyHex: newKeyHex() })).toThrow(/not a database/);
    expect(keyOpens(dbPath, key)).toBe(true);
    // A read-only search connection with the key works.
    const reader = new AppDatabase(dbPath, { queryOnly: true, keyHex: key });
    expect(searchCount(reader, 'tazminat')).toBe(30);
    reader.close();
  });

  it('control: a plain index does show the text in its file', () => {
    const dbPath = path.join(base, 'duz.db');
    fillIndex(dbPath);
    expect(databaseFormat(dbPath)).toBe('plain');
    expect(filesHold(dbPath, MARKER)).toBe(true);
  });
});

describe('moving an existing plain index over', { timeout: 30_000 }, () => {
  it('encrypts it in place with every document and setting kept, and can go back', () => {
    const dbPath = path.join(base, 'metinbul.db');
    fillIndex(dbPath);
    const before = new AppDatabase(dbPath);
    before.setAppSetting('theme', 'dark');
    before.addSearchArea('/Belgeler', 'include');
    const paths = before.getAllDocumentPaths().map(d => d.path).sort();
    before.close();

    const key = newKeyHex();
    encryptInPlace(dbPath, key);

    expect(databaseFormat(dbPath)).toBe('encrypted');
    expect(filesHold(dbPath, MARKER)).toBe(false);
    const after = new AppDatabase(dbPath, { keyHex: key });
    try {
      expect(after.getAllDocumentPaths().map(d => d.path).sort()).toEqual(paths);
      expect(after.getAppSetting('theme')).toBe('dark');
      // Stored resolved: D:\\Belgeler on a Windows runner.
      expect(after.getIncludedFolders()).toEqual([path.resolve('/Belgeler')]);
      expect(searchCount(after, 'Ayşe Yılmaz')).toBe(1);
      expect(after.db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      after.close();
    }

    decryptInPlace(dbPath, key);
    expect(databaseFormat(dbPath)).toBe('plain');
    const plain = new AppDatabase(dbPath);
    expect(searchCount(plain, 'Ayşe Yılmaz')).toBe(1);
    plain.close();
  });

  describe('when the process is killed in the middle', () => {
    let bundle: string;
    beforeAll(async () => {
      // The real encryptInPlace, run in a child process that can be killed.
      const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.encryption-test-'));
      bundle = path.join(dir, 'encryption.mjs');
      await esbuild.build({
        entryPoints: [path.join(ROOT, 'src/db/encryption.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20',
        outfile: bundle, external: ['better-sqlite3'], logLevel: 'silent'
      });
    });
    afterAll(() => {
      fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
    });

    it('leaves either the intact plain index or the intact encrypted one', async () => {
      const outcomes: string[] = [];
      // Spread over the child's start, the rewrite and after it; on this
      // Mac 120 ms lands mid-rewrite, with a hot journal left behind.
      for (const killAfterMs of [5, 40, 80, 120, 160, 250, 400, 5000]) {
        const dbPath = path.join(base, `kesinti-${killAfterMs}.db`);
        fillIndex(dbPath, undefined, 600);
        // As MetinBul does: the sealed key is written before encrypting.
        const key = newKeyHex();
        writeKey(path.join(base, KEY_FILE_NAME), key, fakeProtector());
        const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(path.toNamespacedPath(bundle).replace(/\\/g, '/').replace(/^/, 'file://' + (isWindows ? '/' : '')))}).then(m => m.encryptInPlace(${JSON.stringify(dbPath)}, ${JSON.stringify(key)}))`], { stdio: 'ignore', cwd: ROOT });
        const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
        await new Promise(resolve => setTimeout(resolve, killAfterMs));
        child.kill('SIGKILL');
        await exited;

        const journalLeft = fs.existsSync(`${dbPath}-journal`);
        const formatLeft = databaseFormat(dbPath);

        // What MetinBul does at the next start (prepareDatabaseKey): find out
        // which it is, and open it.
        const result = await prepareDatabaseKey({
          dbPath, protector: fakeProtector(),
          encryptExisting: async (p, k) => encryptInPlace(p, k)
        });
        expect(['migrated', 'encrypted'], `killed after ${killAfterMs} ms (journal ${journalLeft}, header ${formatLeft})`).toContain(result.status);
        expect((result as { keyHex: string }).keyHex).toBe(key);
        const keyHex = (result as { keyHex: string }).keyHex;
        const db = new AppDatabase(dbPath, { keyHex });
        expect(db.getAllDocumentPaths().length).toBe(601);
        expect(searchCount(db, 'Ayşe Yılmaz')).toBe(1);
        expect(db.db.pragma('integrity_check', { simple: true })).toBe('ok');
        db.close();
        outcomes.push(`${killAfterMs}ms:${result.status}${journalLeft ? '+journal' : ''}`);
        fs.rmSync(path.join(base, KEY_FILE_NAME), { force: true });
      }
      // At least one kill landed before the rewrite was done.
      expect(outcomes.some(o => o.endsWith('migrated'))).toBe(true);
    }, 120_000);
  });
});

describe('the key file', { timeout: 30_000 }, () => {
  it('holds the key sealed, never in the clear, readable by this user only', () => {
    const keyPath = path.join(base, 'profil', KEY_FILE_NAME);
    const key = newKeyHex();
    writeKey(keyPath, key, fakeProtector());

    expect(fs.readFileSync(keyPath, 'utf8')).not.toContain(key);
    if (!isWindows) expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(readKey(keyPath, fakeProtector())).toBe(key);
    expect(readKey(path.join(base, 'yok.key'), fakeProtector())).toBeNull();
  });

  it('cannot be opened by another user, and a broken one is reported as such', () => {
    const keyPath = path.join(base, KEY_FILE_NAME);
    writeKey(keyPath, newKeyHex(), fakeProtector(0x5a));
    expect(() => readKey(keyPath, fakeProtector(0x33))).toThrow(KeyUnavailableError);
    fs.writeFileSync(keyPath, '{bozuk');
    expect(() => readKey(keyPath, fakeProtector())).toThrow(KeyUnavailableError);
  });

  it('a key a development build left unsealed is sealed by the installed app; the other way round is refused', () => {
    const keyPath = path.join(base, KEY_FILE_NAME);
    const key = newKeyHex();
    writeKey(keyPath, key, fakeProtector(0, 'development'));
    expect(readKey(keyPath, fakeProtector())).toBe(key);
    expect(JSON.parse(fs.readFileSync(keyPath, 'utf8')).protector).toBe('safeStorage');
    expect(() => readKey(keyPath, fakeProtector(0, 'development'))).toThrow(KeyProtectorMismatchError);
  });
});

describe('what happens at start', { timeout: 30_000 }, () => {
  const encryptExisting = async (p: string, k: string) => encryptInPlace(p, k);

  it('a new install starts with an encrypted index', async () => {
    const dbPath = path.join(base, 'metinbul.db');
    const result = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting });
    expect(result.status).toBe('new');
    fillIndex(dbPath, (result as { keyHex: string }).keyHex);
    expect(databaseFormat(dbPath)).toBe('encrypted');
  });

  it('an existing plain index is encrypted once, then simply opened', async () => {
    const dbPath = path.join(base, 'metinbul.db');
    fillIndex(dbPath);
    const first = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting });
    expect(first.status).toBe('migrated');
    const second = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting });
    expect(second).toEqual({ status: 'encrypted', keyHex: (first as { keyHex: string }).keyHex });
  });

  it('a failed encryption leaves the index plain and as it was, and is tried again next time', async () => {
    const dbPath = path.join(base, 'metinbul.db');
    fillIndex(dbPath);
    const failed = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting: async () => { throw new Error('disk dolu'); } });
    expect(failed).toEqual({ status: 'migration-failed', error: 'disk dolu' });
    expect(databaseFormat(dbPath)).toBe('plain');
    const plain = new AppDatabase(dbPath);
    expect(searchCount(plain, 'Ayşe Yılmaz')).toBe(1);
    plain.close();
    const retried = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting });
    expect(retried.status).toBe('migrated');
  });

  it('a lost key moves the unreadable index aside -- never deletes it -- and starts a new one', async () => {
    const dbPath = path.join(base, 'metinbul.db');
    const first = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting });
    fillIndex(dbPath, (first as { keyHex: string }).keyHex);

    // The keychain was reset: the same key file, but nothing can unseal it.
    const result = await prepareDatabaseKey({ dbPath, protector: fakeProtector(0x33), encryptExisting, stamp: 'T1' });

    expect(result.status).toBe('key-lost');
    const { movedTo, keyHex } = result as { movedTo: string; keyHex: string };
    expect(movedTo).toBe(`${dbPath}.unreadable-T1`);
    expect(databaseFormat(movedTo)).toBe('encrypted');
    expect(keyOpens(movedTo, (first as { keyHex: string }).keyHex)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(keyHex).not.toBe((first as { keyHex: string }).keyHex);
    // The old key file is kept beside it, not overwritten: should the system
    // that sealed it come back, the old index opens again.
    const oldKeyPath = path.join(base, `${KEY_FILE_NAME}.unreadable-T1`);
    expect(readKey(oldKeyPath, fakeProtector())).toBe((first as { keyHex: string }).keyHex);
    expect(readKey(path.join(base, KEY_FILE_NAME), fakeProtector(0x33))).toBe(keyHex);
  });

  it('a plain index is not encrypted without the free space it takes, and says so', async () => {
    const dbPath = path.join(base, 'metinbul.db');
    fillIndex(dbPath);
    const before = fs.readFileSync(dbPath);
    let tried = false;
    const result = await prepareDatabaseKey({
      dbPath, protector: fakeProtector(),
      encryptExisting: async () => { tried = true; },
      freeBytes: () => 10 * 1024 * 1024
    });
    expect(result).toMatchObject({ status: 'migration-failed', reason: 'disk-full' });
    expect(tried).toBe(false);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    // With the space it needs, it goes ahead.
    const later = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting, freeBytes: () => encryptionSpaceNeeded(dbPath) });
    expect(later.status).toBe('migrated');
  });

  it('a system that cannot unseal keys right now (a locked keychain) touches nothing', async () => {
    const dbPath = path.join(base, 'metinbul.db');
    const first = await prepareDatabaseKey({ dbPath, protector: fakeProtector(), encryptExisting });
    fillIndex(dbPath, (first as { keyHex: string }).keyHex);
    const listing = fs.readdirSync(base).sort();

    expect(await prepareDatabaseKey({ dbPath, protector: fakeProtector(0x5a, 'safeStorage', false), encryptExisting })).toEqual({ status: 'protector-unavailable' });
    // A development build meeting the installed app's key: the same.
    expect(await prepareDatabaseKey({ dbPath, protector: fakeProtector(0, 'development'), encryptExisting })).toEqual({ status: 'protector-unavailable' });
    expect(fs.readdirSync(base).sort()).toEqual(listing);
  });
});

describe('how the app uses it', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8').replace(/\r\n/g, '\n');
  const keyModule = fs.readFileSync(path.join(ROOT, 'src/main/index-key.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('settles the key before anything opens the index, and hands it to every connection', () => {
    expect(main).toMatch(/const index = await prepareIndex\(\);[\s\S]{0,200}indexReady = true;[\s\S]{0,400}const appDb = getDb\(\);/);
    expect(main).toMatch(/function getDb\(\)[\s\S]{0,80}if \(!indexReady\) throw/);
    expect(main).toContain('new AppDatabase(getDbPath(), { keyHex: indexKeyHex })');
    expect(main).toMatch(/search-worker\.js'[\s\S]{0,120}keyHex: indexKeyHex/);
    expect(main).toMatch(/indexer-worker\.js'[\s\S]{0,1500}keyHex: indexKeyHex/);
    expect(fs.readFileSync(path.join(ROOT, 'scripts/build.mjs'), 'utf8')).toContain("src/main/encrypt-worker.ts");
  });

  it('seals the key with safeStorage in the installed app, and never touches the Keychain from a development build', () => {
    expect(keyModule).toMatch(/if \(!app\.isPackaged\) \{\s*return \{\s*kind: 'development'/);
    expect(keyModule).toMatch(/kind: 'safeStorage',\s*isAvailable: \(\) => safeStorage\.isEncryptionAvailable\(\)/);
    // Not even imported at the top: importing it alone creates a Keychain item.
    expect(keyModule).not.toMatch(/import \{[^}]*safeStorage[^}]*\} from 'electron'/);
    expect(fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8')).not.toMatch(/import \{[^}]*safeStorage[^}]*\} from 'electron'/);
  });
});
