// Worker-thread entry point for the reads described in search-service.ts, on
// its own read-only SQLite connection to the same WAL-mode DB file.
import { parentPort, workerData } from 'node:worker_threads';
import { AppDatabase } from '../db/database.js';
import { runSearch } from '../search/search-outcome.js';
import type { IndexCounts, ReadRequest, ReadResponse } from './search-service.js';

const { dbPath, keyHex, cancelledSearch } = workerData as { dbPath: string; keyHex?: string; cancelledSearch: SharedArrayBuffer };
const cancelled = new Int32Array(cancelledSearch);
const db = new AppDatabase(dbPath, { queryOnly: true, keyHex });

function answer(request: ReadRequest): unknown {
  if (request.kind === 'search') {
    return runSearch(request.query, db, {
      limit: request.limit,
      sort: request.sort,
      shouldStop: () => Atomics.load(cancelled, 0) === request.id
    });
  }

  const mode = db.getSearchScopeMode();
  const included = db.getIncludedFolders();
  const excluded = db.getExcludedFolders();
  switch (request.kind) {
    case 'documentCount':
      return db.getInScopeDocumentCount(mode, included, excluded);
    case 'statusCounts':
      return {
        status: db.getInScopeStatusCounts(mode, included, excluded),
        ocr: request.includeOcr ? db.getInScopeOcrCounts(mode, included, excluded) : null
      } satisfies IndexCounts;
    case 'unreadableDocuments':
      return db.getUnreadableDocuments(mode, included, excluded, request.limit);
  }
}

parentPort?.on('message', (request: ReadRequest) => {
  let response: ReadResponse;
  try {
    response = { id: request.id, value: answer(request) };
  } catch (error) {
    response = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort?.postMessage(response);
});
