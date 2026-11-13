// The disks Windows has, for "Bilgisayarın Tümü" and for warning about
// Google Drive.
//
// Google Drive for desktop, in its default "stream files" mode, shows the
// user's Drive as a disk of its own (G: by default) that Windows reports as a
// local fixed FAT32 disk labelled "Google Drive". It does not use the Cloud
// Files API, so its files carry none of the attributes that mark a cloud
// placeholder (windows-availability.ts): a colleague's review found only
// 0x80 and 0x82 on 400 of them. Reading one makes Drive download it. The only
// sign is the disk itself.
import { spawn } from 'child_process';
import * as path from 'path';
import { windowsPowerShellPath } from '../shared/powershell.js';

export interface WindowsVolume {
  /** "D:\\" */
  root: string;
  /** Win32_LogicalDisk.DriveType: 2 removable, 3 local fixed, 4 network, 5 optical. */
  driveType: number;
  fileSystem: string;
  label: string;
}

export function isGoogleDriveVolume(volume: Pick<WindowsVolume, 'label' | 'fileSystem'>): boolean {
  return /^google drive\b/i.test(volume.label.trim());
}

// One line per disk: "D:|3|NTFS|Veri". A label may hold a "|": the label is
// whatever follows the third one.
export function parseVolumeList(output: string): WindowsVolume[] {
  const volumes: WindowsVolume[] = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z]):\|(\d+)\|([^|]*)\|(.*)$/);
    if (!match) continue;
    volumes.push({
      root: `${match[1].toUpperCase()}:\\`,
      driveType: Number(match[2]),
      fileSystem: match[3],
      label: match[4]
    });
  }
  return volumes;
}

const VOLUME_LIST_SCRIPT =
  "Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction SilentlyContinue | ForEach-Object { " +
  "$_.DeviceID + '|' + $_.DriveType + '|' + $_.FileSystem + '|' + $_.VolumeName }";
const VOLUME_LIST_TIMEOUT_MS = 20_000;

/**
 * The disks Windows knows: empty elsewhere, null when Windows did not answer
 * (the caller then cannot tell a disk that is gone from one it was not told
 * about).
 */
export function listWindowsVolumes(): Promise<WindowsVolume[] | null> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(
        windowsPowerShellPath(),
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(
            // Labels can be Turkish: written out as UTF-8, not the console code page.
            `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${VOLUME_LIST_SCRIPT}`, 'utf16le'
          ).toString('base64')],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (volumes: WindowsVolume[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(volumes);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, VOLUME_LIST_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { output += chunk; });
    child.on('error', () => finish(null));
    child.on('close', code => {
      // Windows always has its own disk: an empty answer is no answer.
      const volumes = parseVolumeList(output);
      finish(code === 0 && volumes.length > 0 ? volumes : null);
    });
  });
}

/** The disk a path is on, when it has a drive letter. */
export function volumeOfPath(folderPath: string, volumes: WindowsVolume[]): WindowsVolume | undefined {
  const match = path.win32.resolve(folderPath).match(/^([A-Za-z]):/);
  if (!match) return undefined;
  const root = `${match[1].toUpperCase()}:\\`;
  return volumes.find(volume => volume.root === root);
}
