// Where the index lives.
//
// Windows: %LOCALAPPDATA%\MetinBul. Electron keeps an app's data in
// %APPDATA% (Roaming), which in a domain-joined office follows the user
// around: copied to a server at every sign-out and back at every sign-in --
// a colleague's review of 0.4.3 found 0.4.2's index at 722 MB there -- and
// often redirected to a network share, where SQLite's write-ahead log is not
// safe. The index is a cache of the documents on this computer; it belongs to
// this computer. MetinBul's settings stay where they are (they are inside the
// index file, which moves with it). Started with --user-data-dir (the smoke
// tests' scratch profiles), the index stays in that folder.
//
// macOS: in the user-data folder, as before.
import * as fs from 'fs';
import * as path from 'path';

export const INDEX_FILES = ['metinbul.db', 'metinbul.db-wal', 'metinbul.db-shm', 'metinbul.db-journal', 'metinbul.key'];

export interface IndexLocationInput {
  platform: NodeJS.Platform;
  userData: string;
  // Electron's default user-data folder (appData + app name).
  defaultUserData: string;
  localAppData: string | undefined;
}

export function indexDirectory(input: IndexLocationInput): string {
  const usesDefaultProfile = path.resolve(input.userData).toLowerCase() === path.resolve(input.defaultUserData).toLowerCase();
  if (input.platform === 'win32' && usesDefaultProfile && input.localAppData) {
    return path.join(input.localAppData, 'MetinBul');
  }
  return input.userData;
}

export type IndexMoveResult = 'nothing-to-move' | 'moved' | 'already-there' | { failed: string };

/**
 * Moves the index files from `from` to `to` once: when `to` has no index yet
 * and `from` has one. File by file with rename (the same disk: an instant
 * move); across disks, copied and then removed. If any step fails, what was
 * moved goes back and the index stays where it was for this start (the
 * caller keeps using `from`).
 */
export function moveIndexFiles(from: string, to: string): IndexMoveResult {
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return 'nothing-to-move';
  const present = (dir: string) => INDEX_FILES.filter(name => fs.existsSync(path.join(dir, name)));
  if (present(to).some(name => name === 'metinbul.db' || name === 'metinbul.key')) return 'already-there';
  const toMove = present(from);
  if (!toMove.includes('metinbul.db')) return 'nothing-to-move';

  fs.mkdirSync(to, { recursive: true });
  const moved: string[] = [];
  try {
    for (const name of toMove) {
      const source = path.join(from, name);
      const target = path.join(to, name);
      try {
        fs.renameSync(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.rmSync(source);
      }
      moved.push(name);
    }
    return 'moved';
  } catch (error) {
    for (const name of moved.reverse()) {
      try {
        fs.renameSync(path.join(to, name), path.join(from, name));
      } catch {
        try {
          fs.copyFileSync(path.join(to, name), path.join(from, name));
          fs.rmSync(path.join(to, name));
        } catch {
          // Left where it is; the next start finds the rest and tries again.
        }
      }
    }
    return { failed: (error as Error).message };
  }
}
