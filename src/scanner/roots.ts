import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export async function discoverSearchRoots(): Promise<string[]> {
  const home = os.homedir();
  const roots: string[] = [];
  const realPaths = new Set<string>();

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
      }
    }
  }

  return roots;
}
