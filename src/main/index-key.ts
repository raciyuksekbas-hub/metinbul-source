// The Electron half of index encryption (see src/db/encryption.ts): sealing
// the key with the operating system, and encrypting an existing index off the
// main process.
import { app } from 'electron';
import { createRequire } from 'module';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { KeyProtector } from '../db/encryption.js';

// Packaged builds seal the key with safeStorage: on macOS a key in the login
// Keychain that only MetinBul's signature may read, on Windows DPAPI (this
// user's logon secret). Unpackaged development builds keep it unsealed and
// never touch the Keychain: an item an unsigned Electron created would make
// the signed app ask the user for permission later. Merely importing
// safeStorage is enough for Electron to create "MetinBul Safe Storage" in the
// Keychain (seen with Electron 43), so it is loaded only here, only when
// packaged.
export function indexKeyProtector(): KeyProtector {
  if (!app.isPackaged) {
    return {
      kind: 'development',
      isAvailable: () => true,
      protect: secret => Buffer.from(secret, 'utf8'),
      unprotect: sealed => sealed.toString('utf8')
    };
  }
  const { safeStorage } = createRequire(import.meta.url)('electron') as typeof import('electron');
  return {
    kind: 'safeStorage',
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    protect: secret => safeStorage.encryptString(secret),
    unprotect: sealed => safeStorage.decryptString(sealed)
  };
}

// Rekeying a large index takes seconds (measured: 370 MB in 6.6 s); on a
// worker thread the app stays responsive meanwhile.
export function encryptOnWorker(workerDir: string): (dbPath: string, keyHex: string) => Promise<void> {
  return (dbPath, keyHex) => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(workerDir, 'encrypt-worker.js'), { workerData: { dbPath, keyHex } });
    let settled = false;
    worker.on('message', (msg: { ok: true } | { ok: false; error: string }) => {
      settled = true;
      if (msg.ok) resolve();
      else reject(new Error(msg.error));
    });
    worker.on('error', error => {
      if (!settled) reject(error);
      settled = true;
    });
    worker.on('exit', code => {
      if (!settled) reject(new Error(`encryption worker exited with code ${code}`));
    });
  });
}
