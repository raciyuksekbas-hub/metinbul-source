import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { listWindowsVolumes, WindowsVolume, isGoogleDriveVolume } from './windows-volumes.js';

/**
 * The disks "Bilgisayarın Tümü" covers on Windows besides the user folder:
 * the computer's other local fixed disks (D:, E:, an external disk that
 * Windows counts as fixed), as macOS covers its mounted volumes. Not the
 * system disk -- the user folder stands for it, as on macOS -- nor network,
 * removable or optical drives, nor Google Drive's streamed disk (see
 * windows-volumes.ts): reading a file there downloads it.
 */
export function windowsSearchVolumeRoots(volumes: WindowsVolume[], systemDrive: string): string[] {
  const system = systemDrive.replace(/[\\/]+$/, '').toUpperCase();
  return volumes
    .filter(volume => volume.driveType === 3)
    .filter(volume => volume.root.replace(/[\\/]+$/, '').toUpperCase() !== system)
    .filter(volume => !isGoogleDriveVolume(volume))
    .map(volume => volume.root);
}

export async function discoverSearchRoots(
  readVolumes: () => Promise<WindowsVolume[] | null> = listWindowsVolumes
): Promise<string[]> {
  return (await discoverSearchScope(readVolumes)).roots;
}

/**
 * The roots of "Bilgisayarın Tümü", and whether the list is complete: false
 * when Windows did not say which disks it has, or /Volumes could not be read.
 * An incomplete list is still searched, but documents outside it are not
 * taken for out of scope (see removeOutOfScopeDocuments).
 */
export async function discoverSearchScope(
  // Injectable for tests; the real list comes from Windows.
  readVolumes: () => Promise<WindowsVolume[] | null> = listWindowsVolumes
): Promise<{ roots: string[]; complete: boolean }> {
  const home = os.homedir();
  const roots: string[] = [];
  const realPaths = new Set<string>();
  let complete = true;

  function addRoot(targetPath: string) {
    try {
      if (!targetPath || !fs.existsSync(targetPath)) {
        return;
      }
      const real = fs.realpathSync(targetPath);
      if (!realPaths.has(real)) {
        realPaths.add(real);
        roots.push(real);
      }
    } catch {
      // Ignore inaccessible directories
    }
  }

  // 1. User Home Directory
  addRoot(home);

  if (process.platform === 'win32') {
    const volumes = await readVolumes();
    if (volumes === null) complete = false;
    for (const root of windowsSearchVolumeRoots(volumes ?? [], process.env.SystemDrive || 'C:')) {
      addRoot(root);
    }
  }

  // 2. macOS specific cloud and mounted volume locations
  if (process.platform === 'darwin') {
    // Cloud document areas in ~/Library
    const icloudDocs = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    addRoot(icloudDocs);

    const cloudStorage = path.join(home, 'Library', 'CloudStorage');
    if (fs.existsSync(cloudStorage)) {
      try {
        const cloudEntries = fs.readdirSync(cloudStorage, { withFileTypes: true });
        for (const entry of cloudEntries) {
          if (entry.isDirectory()) {
            addRoot(path.join(cloudStorage, entry.name));
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // 3. Mounted Volumes in /Volumes
    const volumesDir = '/Volumes';
    if (fs.existsSync(volumesDir)) {
      try {
        let rootReal = '/';
        try {
          rootReal = fs.realpathSync('/');
        } catch {}

        const volumeEntries = fs.readdirSync(volumesDir, { withFileTypes: true });
        for (const entry of volumeEntries) {
          const volumePath = path.join(volumesDir, entry.name);
          try {
            if (fs.existsSync(volumePath)) {
              const real = fs.realpathSync(volumePath);
              // Skip root volume (/) if real path is root
              if (real === '/' || real === rootReal) {
                continue;
              }
              addRoot(volumePath);
            }
          } catch {
            // Skip inaccessible volumes
          }
        }
      } catch {
        // Skip if /Volumes is inaccessible
        complete = false;
      }
    }
  }

  return { roots, complete };
}
