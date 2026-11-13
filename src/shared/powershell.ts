// Windows PowerShell 5.1, by its full path. Started by name, Windows looks
// for powershell.exe in the current folder and along PATH first, so a file
// of that name dropped into either would run in its place with MetinBul's
// documents' paths and text in hand.
import * as path from 'path';

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
