// "Bilgisayarın Tümü" on Windows: the user folder without AppData, plus the
// other local fixed disks -- not Google Drive's streamed disk, and never a
// recycle bin or Windows' own folders.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverSearchRoots, windowsSearchVolumeRoots } from '../../src/scanner/roots.js';
import { isGoogleDriveVolume, parseVolumeList, volumeOfPath } from '../../src/scanner/windows-volumes.js';
import { shouldSkipDirectory, scanDirectories } from '../../src/scanner/scanner.js';
import { windowsPowerShellPath } from '../../src/shared/powershell.js';

const isWindows = process.platform === 'win32';

// What Get-CimInstance Win32_LogicalDisk gave on the reviewed office computer,
// plus a DVD drive, a USB stick and a mapped network share.
const OFFICE_DISKS = [
  'C:|3|NTFS|',
  'D:|3|NTFS|Veri',
  'E:|5||',
  'F:|2|FAT32|USB BELLEK',
  'G:|3|FAT32|Google Drive',
  'Z:|4|NTFS|Büro|Paylaşım',
  'gibberish'
].join('\r\n');

describe('the disks Windows reports', () => {
  it('are read from the PowerShell listing, labels and all', () => {
    const volumes = parseVolumeList(OFFICE_DISKS);
    expect(volumes.map(v => v.root)).toEqual(['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'Z:\\']);
    expect(volumes[4]).toEqual({ root: 'G:\\', driveType: 3, fileSystem: 'FAT32', label: 'Google Drive' });
    expect(volumes[5].label).toBe('Büro|Paylaşım');
  });

  it('Google Drive is recognised by its label', () => {
    expect(isGoogleDriveVolume({ label: 'Google Drive', fileSystem: 'FAT32' })).toBe(true);
    expect(isGoogleDriveVolume({ label: 'google drive (ali@ornek.com)', fileSystem: 'FAT32' })).toBe(true);
    expect(isGoogleDriveVolume({ label: 'Veri', fileSystem: 'NTFS' })).toBe(false);
  });

  it('"Bilgisayarın Tümü" adds the other local fixed disks only', () => {
    expect(windowsSearchVolumeRoots(parseVolumeList(OFFICE_DISKS), 'C:')).toEqual(['D:\\']);
    // The system disk is the user folder's; whatever letter it has.
    expect(windowsSearchVolumeRoots(parseVolumeList('C:|3|NTFS|\r\nD:|3|NTFS|Sistem'), 'D:')).toEqual(['C:\\']);
  });

  it('finds the disk a folder is on', () => {
    const volumes = parseVolumeList(OFFICE_DISKS);
    expect(volumeOfPath('G:\\Drive\'ım\\Davalar', volumes)?.label).toBe('Google Drive');
    expect(volumeOfPath('d:\\Davalar', volumes)?.root).toBe('D:\\');
    expect(volumeOfPath('\\\\sunucu\\pay', volumes)).toBeUndefined();
  });

  it('PowerShell is started by its full path', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'C:\\WINDOWS' })).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it.skipIf(!isWindows)('on this Windows, the roots are the user folder and local fixed disks', async () => {
    const roots = await discoverSearchRoots(async () => parseVolumeList(OFFICE_DISKS));
    expect(roots[0]).toBe(fs.realpathSync(os.homedir()));
    // D: only if the runner has one.
    for (const root of roots.slice(1)) expect(root).toBe('D:\\');
  });
});

describe('folders that are never searched', () => {
  it('recycle bins and Windows\' bookkeeping, on any disk and below any chosen folder', () => {
    for (const name of ['$RECYCLE.BIN', 'System Volume Information', 'RECYCLER']) {
      expect(shouldSkipDirectory(name, path.join('/Volumes/Harici', name))).toBe(true);
      expect(shouldSkipDirectory(name, path.join('/Volumes/Harici', name), [], ['/Volumes/Harici'])).toBe(true);
    }
  });

  it.skipIf(!isWindows)('Windows\' and programs\' folders at the top of a disk, unless chosen', () => {
    expect(shouldSkipDirectory('Program Files', 'D:\\Program Files')).toBe(true);
    expect(shouldSkipDirectory('Windows', 'D:\\Windows', [], ['D:\\'])).toBe(true);
    expect(shouldSkipDirectory('ProgramData', 'D:\\ProgramData', [], ['D:\\ProgramData\\Belgeler'])).toBe(false);
    // Deeper down, a folder called "Windows" is the user's.
    expect(shouldSkipDirectory('Windows', 'D:\\Davalar\\Windows')).toBe(false);
  });

  it.skipIf(!isWindows)('AppData in the user folder, even when the user folder was chosen', async () => {
    const home = os.homedir();
    expect(shouldSkipDirectory('AppData', path.join(home, 'AppData'))).toBe(true);
    expect(shouldSkipDirectory('AppData', path.join(home, 'AppData'), [], [home])).toBe(true);
    expect(shouldSkipDirectory('AppData', path.join(home, 'AppData'), [], [path.join(home, 'AppData', 'Roaming', 'Belgeler')])).toBe(false);
    // Elsewhere a folder of that name is an ordinary one.
    expect(shouldSkipDirectory('AppData', 'D:\\Yedek\\AppData')).toBe(false);
  });

  it('a scan of a disk-like folder leaves its recycle bin alone, even when that folder was chosen', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mbdisk-')));
    try {
      fs.mkdirSync(path.join(base, '$RECYCLE.BIN', 'S-1-5-21'), { recursive: true });
      fs.writeFileSync(path.join(base, '$RECYCLE.BIN', 'S-1-5-21', '$R1A2B3C.udf'), '<udf>silindi</udf>');
      fs.writeFileSync(path.join(base, 'dilekçe.udf'), '<udf>dava</udf>');
      const files = await scanDirectories([base], [], [base]);
      expect(files.map(f => path.basename(f.path))).toEqual(['dilekçe.udf']);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

