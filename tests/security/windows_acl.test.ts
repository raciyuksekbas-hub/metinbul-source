// Windows: MetinBul does not set ACLs itself. Its index lives in
// %APPDATA%\MetinBul, which inherits the user profile's ACL (the user, SYSTEM
// and Administrators). This test checks that assumption on the machine it
// runs on (the windows-2022 CI runner): an index created in the profile's
// temp folder grants nothing to Everyone, Users, Authenticated Users or
// Guests. It does not run on macOS, where db_protection.test.ts checks the
// POSIX modes instead.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppDatabase } from '../../src/db/database.js';

// Trustees that would make the index readable beyond the user, SYSTEM and
// Administrators, by SID and by their SDDL abbreviation.
const BROAD = new Map([
  ['S-1-1-0', 'Everyone'], ['WD', 'Everyone'],
  ['S-1-5-32-545', 'Users'], ['BU', 'Users'],
  ['S-1-5-11', 'Authenticated Users'], ['AU', 'Authenticated Users'],
  ['S-1-5-32-546', 'Guests'], ['BG', 'Guests'],
  ['S-1-5-7', 'Anonymous'], ['AN', 'Anonymous']
]);

// The trustees of the allow entries in a file's DACL, read with icacls as
// SDDL: SIDs and SDDL abbreviations, never the localised group names
// ("Kullanıcılar"), and no PowerShell module (Get-Acl cannot load when the
// tests run under PowerShell 7, as on the CI runner).
function allowedTrustees(target: string, scratch: string): string[] {
  const saved = path.join(scratch, `acl-${Math.random().toString(36).slice(2)}.txt`);
  execFileSync('icacls', [target, '/save', saved, '/q'], { stdio: 'ignore' });
  const sddl = fs.readFileSync(saved, 'utf16le').split(/\r?\n/)[1] ?? '';
  fs.rmSync(saved, { force: true });
  const dacl = sddl.split('S:')[0];
  return [...dacl.matchAll(/\(([^)]*)\)/g)]
    .map(match => match[1].split(';'))
    .filter(ace => ace[0] === 'A')
    .map(ace => ace[5]);
}

describe.skipIf(process.platform !== 'win32')('Windows ACL of the index', () => {
  it('grants nothing to broad groups on the folder and the database files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-acl-'));
    let db: AppDatabase | undefined;
    try {
      const dbPath = path.join(dir, 'profil', 'metinbul.db');
      db = new AppDatabase(dbPath);
      db.upsertDocument({ path: 'C:\\Belgeler\\a.udf', filename: 'a.udf', extension: '.udf', mtime: 1, size: 1, content: 'gizli', index_status: 'indexed' });
      for (const target of [path.dirname(dbPath), dbPath, `${dbPath}-wal`]) {
        const trustees = allowedTrustees(target, dir);
        expect(trustees.length, `${target} has no readable DACL`).toBeGreaterThan(0);
        expect(trustees.filter(t => BROAD.has(t)).map(t => BROAD.get(t)), target).toEqual([]);
      }
    } finally {
      db?.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
