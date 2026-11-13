// Windows keeps the index out of the roaming profile: %LOCALAPPDATA%\MetinBul,
// moved there once from %APPDATA%\MetinBul. A failed move changes nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexDirectory, moveIndexFiles } from '../src/main/index-location.js';

let base: string;
let roaming: string;
let local: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbloc-')));
  roaming = path.join(base, 'Roaming', 'MetinBul');
  local = path.join(base, 'Local', 'MetinBul');
  fs.mkdirSync(roaming, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('where the index lives', () => {
  const input = { userData: 'C:\\Users\\Ali\\AppData\\Roaming\\MetinBul', defaultUserData: 'C:\\Users\\Ali\\AppData\\Roaming\\MetinBul', localAppData: 'C:\\Users\\Ali\\AppData\\Local' };

  it('on Windows, in the local (not roaming) application data', () => {
    expect(indexDirectory({ ...input, platform: 'win32' })).toBe(path.join('C:\\Users\\Ali\\AppData\\Local', 'MetinBul'));
  });

  it('in a profile given with --user-data-dir, and on macOS, in the user-data folder', () => {
    expect(indexDirectory({ ...input, platform: 'win32', userData: 'D:\\Test\\profil' })).toBe('D:\\Test\\profil');
    expect(indexDirectory({ platform: 'darwin', userData: '/Users/ali/Library/Application Support/MetinBul', defaultUserData: '/Users/ali/Library/Application Support/MetinBul', localAppData: undefined }))
      .toBe('/Users/ali/Library/Application Support/MetinBul');
  });
});

describe('moving the index', () => {
  const write = (dir: string, name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);

  it('takes the database, its companion files and the key, and leaves the rest', () => {
    write(roaming, 'metinbul.db', 'dizin');
    write(roaming, 'metinbul.db-wal', 'wal');
    write(roaming, 'metinbul.key', 'anahtar');
    write(roaming, 'Preferences', '{}');

    expect(moveIndexFiles(roaming, local)).toBe('moved');
    expect(fs.readdirSync(local).sort()).toEqual(['metinbul.db', 'metinbul.db-wal', 'metinbul.key']);
    expect(fs.readFileSync(path.join(local, 'metinbul.db'), 'utf8')).toBe('dizin');
    expect(fs.readdirSync(roaming)).toEqual(['Preferences']);
  });

  it('happens once: an index already in place is left alone, and so is the old one', () => {
    write(roaming, 'metinbul.db', 'eski');
    fs.mkdirSync(local, { recursive: true });
    write(local, 'metinbul.db', 'yeni');
    expect(moveIndexFiles(roaming, local)).toBe('already-there');
    expect(fs.readFileSync(path.join(local, 'metinbul.db'), 'utf8')).toBe('yeni');
    expect(fs.existsSync(path.join(roaming, 'metinbul.db'))).toBe(true);
  });

  it('has nothing to do for a new install', () => {
    expect(moveIndexFiles(roaming, local)).toBe('nothing-to-move');
    expect(fs.existsSync(local)).toBe(false);
  });

  it('puts everything back when a file cannot be moved', () => {
    write(roaming, 'metinbul.db', 'dizin');
    write(roaming, 'metinbul.db-wal', 'wal');
    write(roaming, 'metinbul.key', 'anahtar');
    // Something in the way of the second file: a folder of that name.
    fs.mkdirSync(path.join(local, 'metinbul.db-wal'), { recursive: true });
    fs.writeFileSync(path.join(local, 'metinbul.db-wal', 'engel'), '');

    const result = moveIndexFiles(roaming, local);

    expect(result).toMatchObject({ failed: expect.any(String) });
    expect(fs.readdirSync(roaming).sort()).toEqual(['metinbul.db', 'metinbul.db-wal', 'metinbul.key']);
    expect(fs.readFileSync(path.join(roaming, 'metinbul.db'), 'utf8')).toBe('dizin');
    expect(fs.readdirSync(local)).toEqual(['metinbul.db-wal']);
  });
});
