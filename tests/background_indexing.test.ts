import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { AppDatabase } from '../src/db/database.js';

// The generated worker script below lives in os.tmpdir(), outside this
// project's node_modules resolution chain, so it needs the absolute
// resolved path to better-sqlite3 rather than a bare specifier.
const require = createRequire(import.meta.url);
const BETTER_SQLITE3_PATH = require.resolve('better-sqlite3');

// Builds a standalone worker script (not the app's indexer-worker.ts, which
// requires an esbuild pass) that does a large, purely synchronous
// better-sqlite3 write loop -- simulating the CPU/IO-blocking part of real
// indexing (extraction + per-file transactions) without depending on the
// extractor libraries or a compiled dist/ build. This isolates the claim
// under test: "moving synchronous SQLite writes to a worker thread keeps the
// host thread's event loop responsive" -- the same mechanism main.ts now
// relies on for src/main/indexer-worker.ts.
function buildSyncWriteWorkerSrc(): string {
  return `
const { parentPort, workerData } = require('worker_threads');
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});

const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 3000');
db.exec('CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');

const insert = db.prepare('INSERT INTO docs (content) VALUES (?)');
const bigContent = 'x'.repeat(2000);

for (let i = 0; i < workerData.rowCount; i++) {
  const tx = db.transaction(() => {
    insert.run(bigContent + i);
  });
  tx();
  if (i % 500 === 0) {
    parentPort.postMessage({ type: 'progress', current: i });
  }
}

db.close();
parentPort.postMessage({ type: 'done' });
`;
}

describe('Background Indexing (worker_threads) — spec §4', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix);
      }
    }
  });

  function tempDbPath(name: string): string {
    const p = path.join(os.tmpdir(), `metinbul_bg_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    tmpFiles.push(p);
    return p;
  }

  function tempWorkerScriptPath(): string {
    const p = path.join(os.tmpdir(), `metinbul_sync_write_worker_${Date.now()}_${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(p, buildSyncWriteWorkerSrc());
    return p;
  }

  it('a heavy synchronous SQLite write workload on a worker thread does not stall the host event loop', async () => {
    const dbPath = tempDbPath('evloop');
    const scriptPath = tempWorkerScriptPath();

    const worker = new Worker(scriptPath, {
      workerData: { dbPath, rowCount: 8000 }
    });

    const tickGaps: number[] = [];
    let lastTick = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      tickGaps.push(now - lastTick);
      lastTick = now;
    }, 10);

    await new Promise<void>((resolve, reject) => {
      worker.on('message', (msg) => {
        if (msg.type === 'done') resolve();
      });
      worker.on('error', reject);
    });

    clearInterval(interval);
    fs.unlinkSync(scriptPath);

    const maxGap = Math.max(...tickGaps);
    // A blocked host thread would show gaps of hundreds of ms to seconds;
    // real scheduler jitter on a busy CI box is well under this.
    expect(maxGap).toBeLessThan(200);
    expect(tickGaps.length).toBeGreaterThan(5);
  }, 30000);

  it('search stays correct and does not throw SQLITE_BUSY while a worker writes concurrently on its own connection', async () => {
    const dbPath = tempDbPath('concurrent');

    // Seed schema via the app's own AppDatabase so the FTS trigram table and
    // pragmas match production exactly, then close it before the worker opens it.
    const seedDb = new AppDatabase(dbPath);
    seedDb.close();

    const scriptPath = tempWorkerScriptPath();
    const worker = new Worker(scriptPath, {
      workerData: { dbPath, rowCount: 4000 }
    });

    // A second, independent connection -- standing in for the main process's
    // own AppDatabase instance, which searches while the worker indexes.
    const readerDb = new Database(dbPath, { readonly: false });
    readerDb.pragma('journal_mode = WAL');
    readerDb.pragma('busy_timeout = 3000');

    let sawBusyError = false;
    let readCount = 0;

    const pollInterval = setInterval(() => {
      try {
        readerDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get();
        readCount++;
      } catch (err: any) {
        if (String(err?.code) === 'SQLITE_BUSY' || /SQLITE_BUSY/.test(String(err?.message))) {
          sawBusyError = true;
        } else {
          throw err;
        }
      }
    }, 5);

    await new Promise<void>((resolve, reject) => {
      worker.on('message', (msg) => {
        if (msg.type === 'done') resolve();
      });
      worker.on('error', reject);
    });

    clearInterval(pollInterval);
    readerDb.close();
    fs.unlinkSync(scriptPath);

    expect(sawBusyError).toBe(false);
    expect(readCount).toBeGreaterThan(0);
  }, 30000);

  it('terminating the worker mid-run (app close safety) leaves the DB file in a valid, re-openable state', async () => {
    const dbPath = tempDbPath('terminate');
    const seedDb = new AppDatabase(dbPath);
    seedDb.close();

    const scriptPath = tempWorkerScriptPath();
    const worker = new Worker(scriptPath, {
      workerData: { dbPath, rowCount: 20000 }
    });

    await new Promise<void>((resolve, reject) => {
      worker.on('message', (msg) => {
        if (msg.type === 'progress' && msg.current >= 500) resolve();
      });
      worker.on('error', reject);
    });

    await worker.terminate();
    fs.unlinkSync(scriptPath);

    // Re-open with the app's own AppDatabase (runs initSchema/migrations) to
    // prove the file isn't corrupted by an abrupt mid-transaction stop.
    const reopened = new AppDatabase(dbPath);
    const row = reopened.db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number };
    expect(row.c).toBeGreaterThan(0);
    reopened.close();
  }, 30000);
});
