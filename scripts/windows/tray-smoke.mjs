// Runs the packaged Windows app through what its notification area icon is
// for: closing the window leaves MetinBul running, the icon and a relaunch
// bring the window back, a login launch opens no window, the icon's menu really
// quits, and with the setting off closing the window still quits. Then, on a
// set of long documents, that the packaged search worker answers and the app
// keeps running while it does: searching used to freeze the window.
//
// Every launch uses a scratch profile. A click on the icon cannot be scripted,
// so the inspector fires the handlers that click would.
//
// Usage: node scripts/windows/tray-smoke.mjs <path to MetinBul.exe>
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';

const exe = path.resolve(process.argv[2]);
const INSPECT_PORT = 9529;
const OPEN_LABEL = 'MetinBul’u Aç';
const QUIT_LABEL = 'MetinBul’dan Çık';
const HINT_TITLE = 'MetinBul çalışmaya devam ediyor';
const MAIN_WINDOW = "__electron.BrowserWindow.getAllWindows().find(w => /renderer\\/index\\.html/.test(w.webContents.getURL()))";

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
    await sleep(200);
  }
}

function inspectorSession(url) {
  const ws = new WebSocket(url);
  let lastId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method && listeners.has(message.method)) {
      listeners.get(message.method)(message.params);
    }
  };
  return {
    ready: new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
    on: (method, handler) => listeners.set(method, handler),
    send: (method, params = {}) => new Promise(resolve => {
      const id = ++lastId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close()
  };
}

// Started under --inspect-brk so the icon can be observed from the very start:
// its menu and balloons are kept where the checks below can reach them.
const OBSERVE_TRAY = `(() => {
  const electron = require('electron');
  globalThis.__electron = electron;
  globalThis.__balloons = [];
  const { Tray } = electron;
  const setContextMenu = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function (menu) {
    globalThis.__tray = this;
    globalThis.__trayMenu = menu;
    return setContextMenu.call(this, menu);
  };
  const displayBalloon = Tray.prototype.displayBalloon;
  Tray.prototype.displayBalloon = function (options) {
    globalThis.__balloons.push(options.title);
    return displayBalloon.call(this, options);
  };
  return true;
})()`;

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

const running = new Set();

async function launch(profile, extraArgs = []) {
  const child = spawn(exe, [`--user-data-dir=${profile}`, `--inspect-brk=${INSPECT_PORT}`, '--no-sandbox', '--disable-gpu', ...extraArgs], { stdio: 'ignore' });
  running.add(child);
  let exited = false;
  child.once('exit', () => { exited = true; running.delete(child); });

  const targets = await waitFor('the inspector', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
      return list.length > 0 ? list : null;
    } catch {
      return null;
    }
  });
  const session = inspectorSession(targets[0].webSocketDebuggerUrl);
  await session.ready;
  await session.send('Runtime.enable');
  await session.send('Debugger.enable');
  const paused = new Promise(resolve => session.on('Debugger.paused', resolve));
  await session.send('Runtime.runIfWaitingForDebugger');
  const frame = (await paused).callFrames[0];
  const observed = await session.send('Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId, includeCommandLineAPI: true, returnByValue: true, expression: OBSERVE_TRAY
  });
  if (observed.result?.exceptionDetails) throw new Error(`Could not observe the icon: ${JSON.stringify(observed.result.exceptionDetails).slice(0, 400)}`);
  await session.send('Debugger.resume');
  await session.send('Debugger.disable');
  // A worker started under --inspect-brk waits for a debugger until released.
  session.on('NodeWorker.attachedToWorker', async ({ sessionId }) => {
    await session.send('NodeWorker.sendMessageToWorker', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }) });
    await session.send('NodeWorker.detach', { sessionId });
  });
  await session.send('NodeWorker.enable', { waitForDebuggerOnStart: false });

  const evaluate = async expression => {
    const response = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (response.result?.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(response.result.exceptionDetails).slice(0, 400)}`);
    return response.result?.result?.value;
  };

  const app = {
    evaluate,
    isRunning: () => !exited,
    hasMainWindow: () => evaluate(`!!(globalThis.__electron && ${MAIN_WINDOW})`),
    inMainWindow: code => evaluate(`${MAIN_WINDOW}.webContents.executeJavaScript(${JSON.stringify(code)})`),
    closeMainWindow: () => evaluate(`${MAIN_WINDOW}.close()`),
    // BrowserWindow cannot be touched before the app is ready; the icon only
    // exists after that.
    waitForMainWindow: async () => {
      await app.waitForTray();
      return waitFor('the main window', () => app.hasMainWindow());
    },
    waitForNoMainWindow: () => waitFor('the main window to close', async () => !(await app.hasMainWindow())),
    waitForTray: () => waitFor('the notification area icon', () => evaluate('!!globalThis.__tray')),
    clickTray: () => evaluate("__tray.emit('click')"),
    // Deferred: the process may be gone before an answer could come back.
    chooseMenuItem: label => evaluate(`void setTimeout(() => __trayMenu.items.find(i => i.label === ${JSON.stringify(label)}).click(), 50)`),
    // A process being debugged stays alive until the inspector disconnects,
    // so the session has to go first.
    waitForExit: () => {
      session.close();
      return waitFor('MetinBul to exit', () => exited, 30_000);
    }
  };
  return app;
}

async function run() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-tray-'));
  const profile = path.join(scratch, 'profile');
  const documents = path.join(scratch, 'Belgeler');
  fs.mkdirSync(profile);
  fs.mkdirSync(documents);

  console.log('# closing the window, with the default settings');
  let app = await launch(profile);
  await app.waitForMainWindow();
  await waitFor('the page API', () => app.inMainWindow('typeof window.api === "object"'));
  const settings = await app.inMainWindow('window.api.getStartupSettings()');
  check(settings.backgroundSupported === true, 'the background setting is offered on Windows');
  check(settings.keepRunningInBackground === true, 'it is on by default');
  check(await app.inMainWindow(`window.api.completeOnboarding('selected', [${JSON.stringify(documents)}])`), 'setup completes');
  await app.waitForTray();
  const labels = await app.evaluate("__trayMenu.items.filter(i => i.type !== 'separator').map(i => i.label)");
  check(JSON.stringify(labels) === JSON.stringify([OPEN_LABEL, QUIT_LABEL]), 'the icon offers open and quit');

  await app.closeMainWindow();
  await app.waitForNoMainWindow();
  await sleep(2000);
  check(app.isRunning(), 'MetinBul keeps running after its window is closed');
  check(JSON.stringify(await app.evaluate('__balloons')) === JSON.stringify([HINT_TITLE]), 'the first close says where MetinBul went');

  await app.clickTray();
  await app.waitForMainWindow();
  check(true, 'clicking the icon brings the window back');
  await app.closeMainWindow();
  await app.waitForNoMainWindow();
  await sleep(1000);
  check((await app.evaluate('__balloons.length')) === 1, 'the hint is shown only once');

  const relaunch = spawn(exe, [`--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu'], { stdio: 'ignore' });
  await new Promise(resolve => relaunch.once('exit', resolve));
  await app.waitForMainWindow();
  check(app.isRunning(), 'launching MetinBul again reopens the window in the running one');

  await app.chooseMenuItem(QUIT_LABEL);
  await app.waitForExit();
  check(true, 'the icon menu really quits');

  console.log('# launched at sign-in');
  app = await launch(profile, ['--metinbul-autostart']);
  await app.waitForTray();
  await sleep(4000);
  check(!(await app.hasMainWindow()), 'a login launch opens no window');
  await app.clickTray();
  await app.waitForMainWindow();
  check(true, 'the icon opens the window after a login launch');
  await app.chooseMenuItem(QUIT_LABEL);
  await app.waitForExit();

  console.log('# with the setting turned off');
  app = await launch(profile);
  await app.waitForMainWindow();
  await waitFor('the page API', () => app.inMainWindow('typeof window.api === "object"'));
  const off = await app.inMainWindow('window.api.setKeepRunningInBackground(false)');
  check(off.success === true && off.settings.keepRunningInBackground === false, 'the setting can be turned off');
  await app.closeMainWindow();
  await app.waitForExit();
  check(true, 'closing the window quits when the setting is off');

  console.log('# searching long documents');
  const LONG_DOCUMENTS = 30;
  const searchProfile = path.join(scratch, 'profile-search');
  const longDocuments = path.join(scratch, 'Uzun Belgeler');
  fs.mkdirSync(searchProfile);
  fs.mkdirSync(longDocuments);
  const page = 'Mahkemenin kararına karşı hukuki mücadele sürdürülmüştür. '.repeat(17_000);
  for (let i = 0; i < LONG_DOCUMENTS; i++) {
    writeDocx(path.join(longDocuments, `dilekçe ${i}.docx`), page);
  }
  app = await launch(searchProfile);
  await app.waitForMainWindow();
  await waitFor('the page API', () => app.inMainWindow('typeof window.api === "object"'));
  check(await app.inMainWindow(`window.api.completeOnboarding('selected', [${JSON.stringify(longDocuments)}])`), 'setup completes with the long documents');
  const status = await waitFor('the first update', async () => {
    const current = await app.inMainWindow('window.api.getIndexStatus()');
    return !current.isIndexing && current.lastIndexedAt > 0 ? current : null;
  }, 240_000);
  check(status.indexed === LONG_DOCUMENTS, 'the packaged search worker counts the indexed documents');
  check((await app.inMainWindow('window.api.getDocumentCount()')) === LONG_DOCUMENTS, 'it answers the document count');

  await app.evaluate('globalThis.__beats = 0; globalThis.__beat = setInterval(() => { globalThis.__beats++; }, 10); true');
  const outcome = await app.inMainWindow("window.api.search('müca')");
  const beats = await app.evaluate('clearInterval(__beat); __beats');
  check(outcome.state === 'success' && outcome.results.length === LONG_DOCUMENTS, 'it finds every document');
  check(outcome.results[0].snippet.includes('<mark>müca</mark>'), 'it highlights the match');
  // A search on the main process lets a timer fire once or twice at most.
  check(beats >= 10, `the app keeps running while it searches (${beats} beats)`);

  await app.chooseMenuItem(QUIT_LABEL);
  await app.waitForExit();
  check(true, 'the app still quits after searching');

  fs.rmSync(scratch, { recursive: true, force: true });
}

run().then(
  () => { console.log('tray smoke test passed'); process.exit(0); },
  error => {
    console.error(error);
    for (const child of running) child.kill();
    process.exit(1);
  }
);
