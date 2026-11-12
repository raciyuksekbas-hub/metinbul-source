// Worker-thread entry point: encrypts a plain index in place (see
// encryptInPlace in src/db/encryption.ts) without holding up the main process.
import { parentPort, workerData } from 'node:worker_threads';
import { encryptInPlace } from '../db/encryption.js';

const { dbPath, keyHex } = workerData as { dbPath: string; keyHex: string };
try {
  encryptInPlace(dbPath, keyHex);
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
