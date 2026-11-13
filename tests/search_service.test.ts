// The search and the counts run on a worker so that a long read can never
// freeze the windows ("Yanıt Vermiyor" on Windows). The queue is tested against
// a fake worker, the worker itself is built and run for real.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { AppDatabase } from '../src/db/database.js';
import { runSearch } from '../src/search/search-outcome.js';
import { ReadRequest, ReadResponse, ReadWorker, SearchService } from '../src/main/search-service.js';

const ROOT = path.resolve(__dirname, '..');

class FakeWorker extends EventEmitter implements ReadWorker {
  posted: ReadRequest[] = [];
  terminated = false;
  postMessage(request: ReadRequest) { this.posted.push(request); }
  terminate() { this.terminated = true; }
  answer(id: number, value: unknown) { this.emit('message', { id, value } satisfies ReadResponse); }
}

function fakeService(idleMs?: number) {
  const workers: FakeWorker[] = [];
  let cancelled = new Int32Array(new SharedArrayBuffer(4));
  const service = new SearchService(buffer => {
    cancelled = new Int32Array(buffer);
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, idleMs);
  return { service, workers, cancelledId: () => Atomics.load(cancelled, 0) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('the search worker between searches', () => {
  it('is ended after a few idle minutes, and a new one answers the next search', async () => {
    vi.useFakeTimers();
    try {
      const { service, workers } = fakeService(3 * 60 * 1000);
      const count = service.documentCount();
      workers[0].answer(workers[0].posted[0].id, 3);
      expect(await count).toBe(3);

      vi.advanceTimersByTime(2 * 60 * 1000);
      // A job within the idle time keeps it.
      const again = service.documentCount();
      workers[0].answer(workers[0].posted[1].id, 3);
      await again;
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(workers[0].terminated).toBe(false);

      vi.advanceTimersByTime(60 * 1000 + 1);
      expect(workers[0].terminated).toBe(true);
      // Its exit is expected: nothing fails because of it.
      workers[0].emit('exit');

      const later = service.documentCount();
      expect(workers).toHaveLength(2);
      workers[1].answer(workers[1].posted[0].id, 4);
      expect(await later).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not ended while a job runs', () => {
    vi.useFakeTimers();
    try {
      const { service, workers } = fakeService(1000);
      void service.documentCount();
      vi.advanceTimersByTime(10_000);
      expect(workers[0].terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the search queue', () => {
  it('asks the worker one thing at a time, in order', async () => {
    const { service, workers } = fakeService();
    const count = service.documentCount();
    const status = service.statusCounts(true);
    expect(workers[0].posted.map(r => r.kind)).toEqual(['documentCount']);
    workers[0].answer(workers[0].posted[0].id, 7);
    expect(await count).toBe(7);
    expect(workers[0].posted.map(r => r.kind)).toEqual(['documentCount', 'statusCounts']);
    const counts = { status: { indexed: 1, failed: 0, noText: 0 }, ocr: null };
    workers[0].answer(workers[0].posted[1].id, counts);
    expect(await status).toEqual(counts);
    expect(workers).toHaveLength(1);
  });

  it('lets only the newest search of a window run', async () => {
    const { service, workers, cancelledId } = fakeService();
    const first = service.search(1, 'müc', 'modified', 100);
    const second = service.search(1, 'müca', 'modified', 100);
    const third = service.search(1, 'mücah', 'modified', 100);
    const worker = workers[0];

    // The waiting one is answered without ever reaching the worker...
    expect(await second).toEqual({ state: 'superseded', results: [] });
    expect(worker.posted.map(r => r.kind === 'search' && r.query)).toEqual(['müc']);
    // ...and the running one is told to stop.
    expect(cancelledId()).toBe(worker.posted[0].id);

    worker.answer(worker.posted[0].id, { state: 'superseded', results: [] });
    await first;
    expect(worker.posted.map(r => r.kind === 'search' && r.query)).toEqual(['müc', 'mücah']);
    const answer = { state: 'no_matches', results: [] };
    worker.answer(worker.posted[1].id, answer);
    expect(await third).toEqual(answer);
    // The last search was not told to stop.
    expect(cancelledId()).toBe(worker.posted[0].id);
  });

  it('never stops another window\'s running search', async () => {
    const { service, workers, cancelledId } = fakeService();
    const inPanel = service.search(1, 'dava', 'modified', 100);
    const inWindow = service.search(2, 'karar', 'modified', 100);
    const worker = workers[0];
    expect(cancelledId()).toBe(0);
    const answer = { state: 'no_matches', results: [] };
    worker.answer(worker.posted[0].id, answer);
    expect(await inPanel).toEqual(answer);
    worker.answer(worker.posted[1].id, answer);
    expect(await inWindow).toEqual(answer);
  });

  it('never drops another window\'s waiting search, or a count', async () => {
    const { service, workers } = fakeService();
    const older = service.search(1, 'dava', 'modified', 100);
    const count = service.documentCount();
    const inWindow = service.search(2, 'karar', 'modified', 100);
    const newer = service.search(1, 'davalı', 'modified', 100);
    const worker = workers[0];

    worker.answer(worker.posted[0].id, { state: 'superseded', results: [] });
    await older;
    worker.answer(worker.posted[1].id, 3);
    expect(await count).toBe(3);
    const answer = { state: 'success', results: [] };
    worker.answer(worker.posted[2].id, answer);
    expect(await inWindow).toEqual(answer);
    worker.answer(worker.posted[3].id, answer);
    expect(await newer).toEqual(answer);
    expect(worker.posted.map(r => r.kind === 'search' ? r.query : r.kind)).toEqual(['dava', 'documentCount', 'karar', 'davalı']);
  });

  it('says a search failed when the worker dies, and starts a new one for what is next', async () => {
    const { service, workers } = fakeService();
    const search = service.search(1, 'dava', 'modified', 100);
    const count = service.documentCount();
    workers[0].emit('error', new Error('worker died'));
    expect(await search).toEqual({ state: 'search_error', results: [], error: 'worker died' });

    expect(workers).toHaveLength(2);
    expect(workers[1].posted.map(r => r.kind)).toEqual(['documentCount']);
    workers[1].answer(workers[1].posted[0].id, 5);
    expect(await count).toBe(5);

    // The dead worker's exit changes nothing any more.
    workers[0].emit('exit');
    expect(workers).toHaveLength(2);
  });

  it('rejects a count when the worker dies, or when it reports a failure', async () => {
    const { service, workers } = fakeService();
    const lost = service.documentCount();
    workers[0].emit('exit');
    await expect(lost).rejects.toThrow('The search worker stopped.');

    const failed = service.documentCount();
    await flush();
    workers[1].emit('message', { id: workers[1].posted[0].id, error: 'disk I/O error' } satisfies ReadResponse);
    await expect(failed).rejects.toThrow('disk I/O error');
  });

  it('answers everything when it closes, and refuses what comes after', async () => {
    const { service, workers } = fakeService();
    const running = service.search(1, 'dava', 'modified', 100);
    const waiting = service.documentCount();
    service.close();
    expect(workers[0].terminated).toBe(true);
    expect((await running).state).toBe('search_error');
    await expect(waiting).rejects.toThrow();
    expect((await service.search(1, 'dava', 'modified', 100)).state).toBe('search_error');
    expect(workers).toHaveLength(1);
  });

  it('says a search failed when no worker can be started', async () => {
    const service = new SearchService(() => { throw new Error('no threads left'); });
    expect(await service.search(1, 'dava', 'modified', 100))
      .toEqual({ state: 'search_error', results: [], error: 'no threads left' });
  });
});

describe('the search worker', () => {
  const DOCUMENTS = 30;
  let dir: string;
  let workerFile: string;
  let dbPath: string;
  let db: AppDatabase;
  let service: SearchService;

  const started: Worker[] = [];
  const startWorker = (file: string) => (cancelledSearch: SharedArrayBuffer) => {
    const worker = new Worker(file, { workerData: { dbPath, cancelledSearch } });
    started.push(worker);
    return worker;
  };

  beforeAll(async () => {
    // Inside node_modules so that the bundle can still find better-sqlite3.
    dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.search-worker-test-'));
    workerFile = path.join(dir, 'search-worker.mjs');
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'src/main/search-worker.ts')],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      outfile: workerFile,
      external: ['electron', 'better-sqlite3', 'pdf-parse', 'mammoth', 'word-extractor', 'adm-zip', 'fast-xml-parser'],
      logLevel: 'error'
    });

    dbPath = path.join(dir, 'index.db');
    db = new AppDatabase(dbPath);
    const longText = 'Mahkemenin kararına karşı hukuki mücadele sürdürülmüştür. '.repeat(1200);
    for (let i = 0; i < DOCUMENTS; i++) {
      db.upsertDocument({
        path: path.join(dir, `dilekçe ${i}.docx`),
        filename: `dilekçe ${i}.docx`,
        extension: '.docx',
        mtime: 1_000_000 + i,
        size: longText.length,
        content: `Müvekkil Mücahit için hazırlanmıştır. ${longText}`,
        index_status: 'indexed'
      });
    }
    db.upsertDocument({
      path: path.join(dir, 'tarama.pdf'),
      filename: 'tarama.pdf',
      extension: '.pdf',
      mtime: 1,
      size: 10,
      content: '',
      index_status: 'no_text',
      ocr: 'pending'
    });
    service = new SearchService(startWorker(workerFile));
  }, 120_000);

  afterAll(async () => {
    service.close();
    // Windows cannot delete the index while a worker still has it open.
    await Promise.all(started.map(worker => worker.terminate()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('answers a search exactly as the search itself does', async () => {
    for (const query of ['müca', 'mücah', 'Mücahit', '"mücadele"', 'bulunamayan ifade', 'ab']) {
      expect(await service.search(1, query, 'modified', 100)).toEqual(runSearch(query, db, { limit: 100, sort: 'modified' }));
    }
    const newestFirst = await service.search(1, 'mücah', 'modified', 5);
    const oldestFirst = await service.search(1, 'mücah', 'oldest', 5);
    expect(newestFirst.results).toHaveLength(5);
    expect(newestFirst.results[0].filename).toBe(`dilekçe ${DOCUMENTS - 1}.docx`);
    expect(oldestFirst.results[0].filename).toBe('dilekçe 0.docx');
    expect(newestFirst.results[0].snippet).toContain('<mark>Mücah</mark>it');
    expect(newestFirst.results[0].index_status).toBe('indexed');
  }, 60_000);

  it('answers the counts and the list behind them', async () => {
    expect(await service.documentCount()).toBe(DOCUMENTS);
    expect(await service.statusCounts(true)).toEqual({
      status: { indexed: DOCUMENTS, failed: 0, noText: 1 },
      ocr: { recognized: 0, pending: 1 }
    });
    expect((await service.statusCounts(false)).ocr).toBeNull();
    expect((await service.unreadableDocuments(10)).map(d => d.filename)).toEqual(['tarama.pdf']);
  }, 60_000);

  it('sees what the main connection has just written', async () => {
    db.setSearchScopeMode('selected');
    try {
      expect(await service.documentCount()).toBe(0);
      expect((await service.search(1, 'mücah', 'modified', 100)).state).toBe('no_matches');
    } finally {
      db.setSearchScopeMode('all');
    }
    expect(await service.documentCount()).toBe(DOCUMENTS);
  }, 60_000);

  it('leaves the calling thread free while it searches', async () => {
    let turns = 0;
    let searching = true;
    const spin = () => { turns++; if (searching) setImmediate(spin); };
    setImmediate(spin);
    const outcome = await service.search(1, 'mücadele', 'relevance', 100);
    searching = false;
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(turns).toBeGreaterThan(10);
  }, 60_000);

  it('drops a search that was replaced while it ran', async () => {
    const replaced = service.search(7, 'mücadele', 'modified', 100);
    const newest = service.search(7, 'müvekkil', 'modified', 100);
    expect(await replaced).toEqual({ state: 'superseded', results: [] });
    expect((await newest).state).toBe('success');
  }, 60_000);

  it('says a search failed when the worker cannot load', async () => {
    const broken = new SearchService(startWorker(path.join(dir, 'does-not-exist.mjs')));
    const outcome = await broken.search(1, 'dava', 'modified', 100);
    expect(outcome.state).toBe('search_error');
    broken.close();
  }, 60_000);

  it('cannot change the index through its connection', () => {
    const readOnly = new AppDatabase(dbPath, { queryOnly: true });
    try {
      expect(() => readOnly.setAppSetting('theme', 'dark')).toThrow(/readonly/);
    } finally {
      readOnly.close();
    }
    expect(db.getAppSetting('theme')).toBeUndefined();
  });

  it('refuses to create an index that does not exist', () => {
    expect(() => new AppDatabase(path.join(dir, 'yok.db'), { queryOnly: true })).toThrow();
    expect(fs.existsSync(path.join(dir, 'yok.db'))).toBe(false);
  });
});

describe('how the app uses it', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8');
  const build = fs.readFileSync(path.join(ROOT, 'scripts/build.mjs'), 'utf8');

  it('never searches on the main process', () => {
    expect(main).not.toContain('runSearch');
    expect(main).toMatch(/\bhandle\('app:search'[\s\S]{0,500}getSearchService\(\)\.search\(event\.sender\.id/);
  });

  it('reads the counts that walk the whole index on the worker', () => {
    expect(main).not.toMatch(/appDb\.getInScope|\.getUnreadableDocuments\(mode/);
  });

  it('builds the worker and stops it on quit', () => {
    expect(build).toContain("'src/main/search-worker.ts'");
    expect(build).toContain("'search-worker.js'");
    expect(main).toContain("'search-worker.js'");
    expect(main).toMatch(/before-quit[\s\S]*searchService\?\.close\(\)/);
  });
});
