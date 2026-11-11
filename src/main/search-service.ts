// Searches, and the counts behind the status lines, on a thread of their own.
//
// Each of these can read a lot of a large index. They used to run on the
// Electron main process, which is also what keeps the windows alive: while one
// ran nothing else could, and Windows marks a window "Yanıt Vermiyor" after a
// few seconds of that. Typing a common word into a large index was enough.
//
// One worker, one job at a time. A window's new search replaces its older
// ones, so typing a word never queues up a search per letter.
import type { OcrCounts, ScopeStatusCounts, UnreadableDocument } from '../db/database.js';
import type { SearchOutcome } from '../search/search-outcome.js';
import type { SearchSort } from '../search/search.js';

export interface IndexCounts {
  status: ScopeStatusCounts;
  ocr: OcrCounts | null;
}

export type ReadRequest =
  | { id: number; kind: 'search'; query: string; sort: SearchSort; limit: number }
  | { id: number; kind: 'documentCount' }
  | { id: number; kind: 'statusCounts'; includeOcr: boolean }
  | { id: number; kind: 'unreadableDocuments'; limit: number };

export type ReadResponse =
  | { id: number; value: unknown }
  | { id: number; error: string };

// The part of worker_threads.Worker this file uses.
export interface ReadWorker {
  postMessage(request: ReadRequest): void;
  on(event: 'message', listener: (response: ReadResponse) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  terminate(): unknown;
}

interface Job {
  request: ReadRequest;
  // The window that asked, for a search.
  sender?: number;
  resolve(value: unknown): void;
  fail(message: string): void;
}

const SUPERSEDED: SearchOutcome = { state: 'superseded', results: [] };

export class SearchService {
  // The id of a running search that has been replaced. The worker looks at it
  // between documents; it cannot receive a message in the middle of a search.
  private readonly cancelledSearch = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  private readonly waiting: Job[] = [];
  private running: Job | null = null;
  private worker: ReadWorker | null = null;
  private nextId = 1;
  private closed = false;

  constructor(private readonly spawn: (cancelledSearch: SharedArrayBuffer) => ReadWorker) {}

  search(sender: number, query: string, sort: SearchSort, limit: number): Promise<SearchOutcome> {
    this.replaceSearchesOf(sender);
    return new Promise(resolve => {
      this.add({
        request: { id: this.nextId++, kind: 'search', query, sort, limit },
        sender,
        resolve: value => resolve(value as SearchOutcome),
        fail: message => resolve({ state: 'search_error', results: [], error: message })
      });
    });
  }

  documentCount(): Promise<number> {
    return this.read<number>(id => ({ id, kind: 'documentCount' }));
  }

  statusCounts(includeOcr: boolean): Promise<IndexCounts> {
    return this.read<IndexCounts>(id => ({ id, kind: 'statusCounts', includeOcr }));
  }

  unreadableDocuments(limit: number): Promise<UnreadableDocument[]> {
    return this.read<UnreadableDocument[]>(id => ({ id, kind: 'unreadableDocuments', limit }));
  }

  close(): void {
    this.closed = true;
    this.worker?.terminate();
    this.worker = null;
    const unfinished = [...(this.running ? [this.running] : []), ...this.waiting.splice(0)];
    this.running = null;
    for (const job of unfinished) job.fail('MetinBul is closing.');
  }

  private read<T>(build: (id: number) => ReadRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.add({
        request: build(this.nextId++),
        resolve: value => resolve(value as T),
        fail: message => reject(new Error(message))
      });
    });
  }

  private replaceSearchesOf(sender: number): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i].sender === sender) {
        this.waiting.splice(i, 1)[0].resolve(SUPERSEDED);
      }
    }
    if (this.running?.sender === sender) {
      Atomics.store(this.cancelledSearch, 0, this.running.request.id);
    }
  }

  private add(job: Job): void {
    if (this.closed) {
      job.fail('MetinBul is closing.');
      return;
    }
    this.waiting.push(job);
    this.startNext();
  }

  private startNext(): void {
    if (this.running) return;
    const job = this.waiting.shift();
    if (!job) return;
    try {
      this.worker ??= this.startWorker();
      this.running = job;
      this.worker.postMessage(job.request);
    } catch (error) {
      this.running = null;
      job.fail(error instanceof Error ? error.message : String(error));
      this.startNext();
    }
  }

  private startWorker(): ReadWorker {
    const worker = this.spawn(this.cancelledSearch.buffer as SharedArrayBuffer);
    worker.on('message', response => this.finish(response));
    worker.on('error', error => this.lose(worker, error.message));
    worker.on('exit', () => this.lose(worker, 'The search worker stopped.'));
    return worker;
  }

  private finish(response: ReadResponse): void {
    const job = this.running;
    if (!job || job.request.id !== response.id) return;
    this.running = null;
    if ('error' in response) {
      job.fail(response.error);
    } else {
      job.resolve(response.value);
    }
    this.startNext();
  }

  // The job it was working on fails; the next one starts a new worker.
  private lose(worker: ReadWorker, message: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const job = this.running;
    this.running = null;
    job?.fail(message);
    this.startNext();
  }
}
