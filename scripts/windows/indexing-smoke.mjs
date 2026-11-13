// Runs the packaged Windows app through two updates that used to end badly:
//
// 1. A 120-page scanned PDF. A colleague's review of 0.4.3 found MetinBul
//    closing outright about 35 seconds into such an update, three times out
//    of three (0xc0000005 in skia.win32-x64-msvc.node after it had been
//    unloaded). The app must stay up through the update, a second one, and a
//    while after each; Windows' Application log must record no crash; and
//    text recognition must have made the scan searchable.
// 2. A small PDF whose embedded font expands to a gigabyte when read. With the
//    memory limit lowered for the test, the update must stop on it, skip it
//    from then on, and still index the other document in the folder.
//
// Every launch uses a scratch profile and documents written here; nothing of
// the runner's own folders is read.
//
// Usage: node scripts/windows/indexing-smoke.mjs <path to MetinBul.exe> [--scanned-only]
// (--scanned-only: the first part alone, e.g. against an older MetinBul to
// see whether the crash reproduces there)
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import AdmZip from 'adm-zip';

const exe = path.resolve(process.argv[2]);
const scannedOnly = process.argv.includes('--scanned-only');
const INSPECT_PORT = 9531;
const MAIN_WINDOW = "require('electron').BrowserWindow.getAllWindows().find(w => /renderer\\/index\\.html/.test(w.webContents.getURL()))";
const SCANNED_PAGES = 120;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function check(condition, what) {
  if (!condition) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

async function waitFor(what, probe, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

// --- documents ---------------------------------------------------------

function writeDocx(filePath, text) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:body></w:document>`));
  zip.writeZip(filePath);
}

function pdfFile(objects) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = chunk => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(buffer);
    length += buffer.length;
  };
  push('%PDF-1.4\n');
  objects.forEach((body, i) => {
    offsets[i + 1] = length;
    push(`${i + 1} 0 obj\n`);
    for (const piece of [].concat(body)) push(piece);
    push('\nendobj\n');
  });
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

// What a scanner produces: pages that are pictures of text, no text layer.
async function writeScannedPdf(filePath, pages) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const width = 1240;
  const height = 1754;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null];
  const kids = [];
  for (let page = 0; page < pages; page++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.font = '44px Arial';
    ['Sayın Mahkeme', 'Ortaklığın giderilmesi davası', `Sayfa ${page + 1}`].forEach((line, i) => ctx.fillText(line, 100, 200 + i * 80));
    const jpeg = canvas.toBuffer('image/jpeg');
    const n = objects.length + 1;
    kids.push(`${n} 0 R`);
    const draw = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`);
    objects.push([`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
    objects.push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  fs.writeFileSync(filePath, pdfFile(objects));
}

// One line of real text in a font whose program inflates to `mib` MiB.
async function writeFontBombPdf(filePath, mib) {
  const zero = Buffer.alloc(1024 * 1024);
  const chunks = [];
  const stream = zlib.createDeflate({ level: 9 });
  stream.on('data', chunk => chunks.push(chunk));
  const ended = new Promise(resolve => stream.on('end', resolve));
  for (let i = 0; i < mib; i++) {
    if (!stream.write(zero)) await new Promise(resolve => stream.once('drain', resolve));
  }
  stream.end();
  await ended;
  const data = Buffer.concat(chunks);
  const content = 'BT /F1 12 Tf 100 700 Td (Bomba dilekcesi) Tj ET';
  fs.writeFileSync(filePath, pdfFile([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /TrueType /BaseFont /Bomba /FirstChar 32 /LastChar 126 /FontDescriptor 6 0 R >>',
    '<< /Type /FontDescriptor /FontName /Bomba /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
    [`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, data, '\nendstream']
  ]));
}

// --- the app -------------------------------------------------------------

// A request whose answer never comes because MetinBul died must fail, not
// hang: with the socket closed and the process gone Node has nothing left to
// wait on and would exit with 0, reporting a crash as a pass. (It did, in the
// first diagnosis run of 0.4.4.)
function inspectorSession(url) {
  const ws = new WebSocket(url);
  let lastId = 0;
  const pending = new Map();
  let closed = false;
  const failAll = reason => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    }
  };
  ws.onclose = () => failAll('the inspector connection closed (MetinBul is gone)');
  return {
    ready: new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      if (closed) { reject(new Error('the inspector connection is closed (MetinBul is gone)')); return; }
      const id = ++lastId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    failAll,
    close: () => ws.close()
  };
}

const running = new Set();

async function launch(profile, env = {}) {
  const child = spawn(exe, [`--user-data-dir=${profile}`, `--inspect=${INSPECT_PORT}`, '--no-sandbox', '--disable-gpu'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }
  });
  // MetinBul's own log, for what the watchdog says.
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  running.add(child);
  let exit = null;
  let session = null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
    running.delete(child);
    session?.failAll(`MetinBul exited (code ${code}, signal ${signal})`);
  });

  const targets = await waitFor('the inspector', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
      return list.length > 0 ? list : null;
    } catch {
      return null;
    }
  });
  session = inspectorSession(targets[0].webSocketDebuggerUrl);
  await session.ready;
  await session.send('Runtime.enable');

  const evaluate = async expression => {
    if (exit) throw new Error(`MetinBul is gone (exit code ${exit.code}, signal ${exit.signal})`);
    const response = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (response.result?.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(response.result.exceptionDetails).slice(0, 400)}`);
    return response.result?.result?.value;
  };
  const app = {
    exit: () => exit,
    output: () => output,
    evaluate,
    inMainWindow: code => evaluate(`${MAIN_WINDOW}.webContents.executeJavaScript(${JSON.stringify(code)})`),
    waitForPageApi: () => waitFor('the main window', async () => {
      try {
        return await app.inMainWindow('typeof window.api === "object"');
      } catch (error) {
        if (exit) throw error;
        return false;
      }
    }, 60_000),
    status: () => app.inMainWindow('window.api.getIndexStatus()'),
    // Polled every second: the process ending at any point fails the test.
    waitForUpdate: async (what, since, timeoutMs) => waitFor(what, async () => {
      if (exit) throw new Error(`MetinBul closed during ${what} (exit code ${exit.code}, signal ${exit.signal})`);
      const current = await app.status();
      return !current.isIndexing && current.lastIndexedAt > since ? current : null;
    }, timeoutMs),
    staysUp: async (what, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (exit) throw new Error(`MetinBul closed ${what} (exit code ${exit.code}, signal ${exit.signal})`);
        await sleep(1000);
      }
      check(!exit, `MetinBul is still running ${what}`);
    },
    quit: async () => {
      // require comes from the inspector's command line API, which a timer
      // that runs later no longer has: taken now.
      await evaluate("(() => { const { app } = require('electron'); setTimeout(() => app.quit(), 50); return true; })()");
      session.close();
      await waitFor('MetinBul to quit', () => exit !== null, 30_000);
    }
  };
  return app;
}

function crashesSince(startedAt) {
  // Event 1000 ("Application Error") names the program and the faulting
  // module. No such event is an error to Get-WinEvent ("No events were
  // found"), hence the explicit exit 0.
  const script = `$events = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=[DateTime]::Parse('${startedAt.toISOString()}')} -ErrorAction SilentlyContinue; `
    + `$events | Where-Object { $_.Message -match 'MetinBul' } | ForEach-Object { $_.Message -replace '\\s+', ' ' }; exit 0`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

async function run() {
  const startedAt = new Date();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-indexing-'));

  console.log(`# a ${SCANNED_PAGES}-page scanned PDF`);
  const profile = path.join(scratch, 'profile');
  const scans = path.join(scratch, 'Taramalar');
  fs.mkdirSync(profile);
  fs.mkdirSync(scans);
  await writeScannedPdf(path.join(scans, 'uzun tarama.pdf'), SCANNED_PAGES);
  writeDocx(path.join(scans, 'dilekçe.docx'), 'Kıdem tazminatı alacağı');
  console.log(`  ${Math.round(fs.statSync(path.join(scans, 'uzun tarama.pdf')).size / 1024 / 1024)} MB written`);

  let app = await launch(profile);
  await app.waitForPageApi();
  const ocr = await waitFor('the text recognition check', async () => {
    const status = await app.status();
    return status.ocrAvailable || status.ocrNeedsTurkishComponent ? status : null;
  }, 120_000);
  check(ocr.ocrAvailable === true, 'Windows text recognition is available');
  check(await app.inMainWindow(`window.api.completeOnboarding('selected', [${JSON.stringify(scans)}])`), 'setup completes');
  let status = await app.waitForUpdate('the first update', 0, 15 * 60_000);
  check(status.indexed === 2, `both documents are indexed (${status.indexed})`);
  await app.staysUp('a minute after the update', 60_000);
  const found = await app.inMainWindow("window.api.search('ortaklığın giderilmesi')");
  check(found.state === 'success' && found.results.some(r => r.filename === 'uzun tarama.pdf'), 'text recognition made the scan searchable');

  const before = status.lastIndexedAt;
  await app.inMainWindow('window.api.rescan()');
  status = await app.waitForUpdate('a second update', before, 10 * 60_000);
  await app.staysUp('a minute after the second update', 60_000);
  await app.quit();
  check(true, 'MetinBul quits normally');

  if (scannedOnly) {
    const crashes = crashesSince(startedAt);
    for (const crash of crashes) console.log(`  event log: ${crash.slice(0, 400)}`);
    check(crashes.length === 0, 'Windows recorded no MetinBul crash');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return;
  }

  console.log('# a PDF whose font inflates to a gigabyte');
  const bombProfile = path.join(scratch, 'profile-bomb');
  const bombDocs = path.join(scratch, 'Bomba');
  fs.mkdirSync(bombProfile);
  fs.mkdirSync(bombDocs);
  await writeFontBombPdf(path.join(bombDocs, 'bomba.pdf'), 1024);
  writeDocx(path.join(bombDocs, 'zarar görmeyen.docx'), 'Ecrimisil talebi');
  console.log(`  ${Math.round(fs.statSync(path.join(bombDocs, 'bomba.pdf')).size / 1024)} KB written`);

  app = await launch(bombProfile, { METINBUL_TEST_INDEX_MEMORY_LIMIT_MB: '700' });
  await app.waitForPageApi();
  check(await app.inMainWindow(`window.api.completeOnboarding('selected', [${JSON.stringify(bombDocs)}])`), 'setup completes');
  // The stopped update starts again past the document, so "done" is the
  // second one finishing.
  status = await app.waitForUpdate('the update past the PDF', 0, 10 * 60_000);
  check(!app.exit(), 'MetinBul survives the PDF');
  const unreadable = await app.inMainWindow('window.api.getUnreadableDocuments()');
  check(unreadable.some(doc => doc.filename === 'bomba.pdf'), 'the PDF is recorded as unreadable');
  // ...because the memory watch stopped it, not for some other reason.
  check(/Reading a document took MetinBul past 700 MB of memory/.test(app.output()), 'it was the memory watch that stopped the update');
  const other = await app.inMainWindow("window.api.search('ecrimisil')");
  check(other.state === 'success' && other.results.length === 1, 'the other document in the folder is searchable');
  await app.quit();

  const crashes = crashesSince(startedAt);
  for (const crash of crashes) console.log(`  event log: ${crash.slice(0, 400)}`);
  check(crashes.length === 0, 'Windows recorded no MetinBul crash');

  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

// Something to wait on until run() settles, whatever happens to the sockets.
const keepAlive = setInterval(() => {}, 60_000);
run().finally(() => clearInterval(keepAlive)).then(
  () => { console.log('indexing smoke test passed'); process.exit(0); },
  error => {
    console.error(error);
    try {
      for (const crash of crashesSince(new Date(Date.now() - 60 * 60_000))) console.error(`  event log: ${crash.slice(0, 600)}`);
    } catch {
      // No event log to read.
    }
    for (const child of running) child.kill();
    process.exit(1);
  }
);
