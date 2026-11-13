// MetinBul's privacy rules, checked rather than assumed:
// - indexing and searching open no network connection at all;
// - the update check is the only network request in the app, and it carries
//   nothing but the app's version;
// - a search query is never written anywhere (index files, temp files, logs).
// The documents are the synthetic fixtures in tests/fixtures.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupFixtures, FIXTURES_DIR } from '../fixtures/create_fixtures.js';
import { AppDatabase, normalizeForSearch } from '../../src/db/database.js';
import { indexFolders } from '../../src/search/indexer.js';
import { runSearch } from '../../src/search/search-outcome.js';
import { checkForUpdates } from '../../src/main/updater.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

let base: string;
let docs: string;
let dbPath: string;

beforeAll(() => {
  setupFixtures();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-privacy-')));
  docs = path.join(base, 'Belgeler');
  fs.mkdirSync(docs);
  for (const name of ['sample.docx', 'sample.pdf', 'sample.udf']) {
    fs.copyFileSync(path.join(FIXTURES_DIR, name), path.join(docs, name));
  }
  dbPath = path.join(base, 'profil', 'metinbul.db');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Every way Node can open a connection or resolve a name, recorded.
function trapNetwork(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const restores: Array<() => void> = [];
  const trap = (moduleObject: Record<string, any>, key: string, label: string) => {
    const original = moduleObject[key];
    moduleObject[key] = function (...args: unknown[]) {
      calls.push(label);
      return original.apply(this, args);
    };
    restores.push(() => { moduleObject[key] = original; });
  };
  const net = require('net');
  const tls = require('tls');
  const dns = require('dns');
  trap(net.Socket.prototype, 'connect', 'net.Socket.connect');
  trap(net, 'connect', 'net.connect');
  trap(net, 'createConnection', 'net.createConnection');
  trap(tls, 'connect', 'tls.connect');
  trap(dns, 'lookup', 'dns.lookup');
  trap(dns, 'resolve', 'dns.resolve');
  trap(require('http'), 'request', 'http.request');
  trap(require('https'), 'request', 'https.request');
  trap(require('http'), 'get', 'http.get');
  trap(require('https'), 'get', 'https.get');
  trap(globalThis as Record<string, any>, 'fetch', 'fetch');
  return { calls, restore: () => restores.reverse().forEach(r => r()) };
}

describe('no network while indexing and searching', () => {
  it('(control: the trap does record a connection attempt)', async () => {
    const net = trapNetwork();
    try {
      await new Promise<void>(resolve => require('dns').lookup('localhost', () => resolve()));
      await fetch('http://127.0.0.1:9/').catch(() => undefined);
    } finally {
      net.restore();
    }
    expect(net.calls).toContain('dns.lookup');
    expect(net.calls).toContain('fetch');
  });

  it('reads DOCX, PDF and UDF and searches them without a single connection or DNS lookup', async () => {
    const net = trapNetwork();
    try {
      const db = new AppDatabase(dbPath);
      const summary = await indexFolders([docs], db);
      expect(summary.indexed).toBe(3);
      for (const query of ['tazminat', 'haczedilmezlik', 'MAHKEMES']) {
        const outcome = runSearch(query, db);
        expect(outcome.results.length, query).toBeGreaterThan(0);
      }
      db.close();
    } finally {
      net.restore();
    }
    expect(net.calls).toEqual([]);
  });

  it('the update check is the only network code in the app, and sends only the version', async () => {
    const networkCall = /\bfetch\(|fetchImpl\(|https?\.(request|get)\(|net\.(request|fetch|connect)\(|new WebSocket|XMLHttpRequest|sendBeacon|crashReporter|autoUpdater|electron-updater/;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|html|swift)$/.test(entry.name) && networkCall.test(fs.readFileSync(full, 'utf8'))) {
          files.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'native'));
    expect(files).toEqual(['src/main/main.ts', 'src/main/updater.ts']);
    // main.ts only hands the update check Electron's net.fetch (it uses the
    // system proxy), on one line, and passes it nowhere else.
    const main = fs.readFileSync(path.join(ROOT, 'src/main/main.ts'), 'utf8').split(/\r?\n/);
    expect(main.filter(line => networkCall.test(line))).toEqual([
      'const updateFetch = ((input: string, init?: RequestInit) => net.fetch(input, init)) as typeof fetch;'
    ]);
    expect(main.filter(line => /updateFetch/.test(line) && !/^const updateFetch/.test(line)).every(line => /checkForUpdates\(/.test(line))).toBe(true);

    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ tag_name: 'v0.4.3', html_url: 'https://github.com/raciyuksekbas-hub/metinbul-releases/releases/tag/v0.4.3' }), { status: 200 });
    }) as typeof fetch;
    await checkForUpdates('0.4.2', { fetchFn });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.github.com/repos/raciyuksekbas-hub/metinbul-releases/releases/latest');
    expect(requests[0].init?.method).toBe('GET');
    expect(requests[0].init?.body).toBeUndefined();
    expect(requests[0].init?.headers).toEqual({
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'MetinBul-App/0.4.2'
    });
  });
});

describe('a search query leaves no trace', () => {
  it('is not in the index files, the temp folder or the log', async () => {
    const secret = 'Gizli Müvekkil Sorgusu 9137 Şişli';
    const forms = [secret, normalizeForSearch(secret), secret.toLowerCase()].map(s => Buffer.from(s, 'utf8'));
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    const started = Date.now();
    try {
      const db = new AppDatabase(dbPath);
      await indexFolders([docs], db);
      for (const query of [secret, `"${secret}"`, secret.slice(0, 12)]) runSearch(query, db, { sort: 'relevance' });
      db.close();
    } finally {
      vi.restoreAllMocks();
    }

    const holders: string[] = [];
    const scan = (file: string) => {
      const bytes = fs.readFileSync(file);
      if (forms.some(form => bytes.includes(form))) holders.push(file);
    };
    for (const name of fs.readdirSync(path.dirname(dbPath))) scan(path.join(path.dirname(dbPath), name));
    for (const name of fs.readdirSync(os.tmpdir())) {
      const full = path.join(os.tmpdir(), name);
      if (!name.startsWith('metinbul-') || full === base) continue;
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.mtimeMs >= started) scan(full);
      } catch {
        // Gone, or another user's.
      }
    }
    expect(holders).toEqual([]);
    expect(logged.filter(line => forms.some(form => line.includes(form.toString('utf8'))))).toEqual([]);
  });
});
