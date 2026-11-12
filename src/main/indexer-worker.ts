// Worker-thread entry point for background indexing.
//
// indexAccessibleDocuments/AppDatabase have no Electron dependency, so this
// file just re-runs the same pure indexing pipeline used by the unit tests,
// on its own thread with its own SQLite connection to the same DB file
// (WAL mode already allows a single writer + concurrent readers). This keeps
// the Electron main process's event loop (which owns every other IPC
// handler: search, open file, folder picker) free during large scans.
import { parentPort, workerData } from 'node:worker_threads';
import { AppDatabase } from '../db/database.js';
import { indexAccessibleDocuments, IndexProgress, IndexSummary } from '../search/indexer.js';
import type { ScannedFile } from '../scanner/scanner.js';
import { createMacosOcrEngine } from '../ocr/ocr.js';
import { createWindowsOcrEngine } from '../ocr/windows-ocr.js';

interface WorkerData {
  dbPath: string;
  keyHex?: string;
  // false for an automatic update: unchanged unreadable files are left alone.
  retryFailed?: boolean;
  // Set when text recognition is available and turned on. helperPath is the
  // macOS helper; Windows needs none.
  ocr?: { helperPath?: string; budgetMs: number };
}

type WorkerMessage =
  | { type: 'progress'; progress: IndexProgress }
  | { type: 'reading'; file: ScannedFile; limitMs: number }
  | { type: 'done'; summary: IndexSummary }
  | { type: 'error'; message: string };

async function run() {
  const { dbPath, keyHex, retryFailed, ocr } = workerData as WorkerData;
  const db = new AppDatabase(dbPath, { keyHex });

  try {
    const summary = await indexAccessibleDocuments(db, (progress) => {
      parentPort?.postMessage({ type: 'progress', progress } satisfies WorkerMessage);
    }, {
      retryFailed: retryFailed !== false,
      onReading: (file, limitMs) => {
        const { path, filename, extension, mtime, size } = file;
        parentPort?.postMessage({ type: 'reading', file: { path, filename, extension, mtime, size }, limitMs } satisfies WorkerMessage);
      },
      ocr: ocr
        ? { engine: ocr.helperPath ? createMacosOcrEngine(ocr.helperPath) : createWindowsOcrEngine(), budgetMs: ocr.budgetMs }
        : undefined
    });
    parentPort?.postMessage({ type: 'done', summary } satisfies WorkerMessage);
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    } satisfies WorkerMessage);
  } finally {
    db.close();
  }
}

run();
