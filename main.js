'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session, webContents, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const { Adb } = require('./src/core/adb');
const { CaseStore } = require('./src/core/casestore');
const { EvidenceManager } = require('./src/core/evidence');
const { Acquirer } = require('./src/core/acquire');
const { runPreflight } = require('./src/core/preflight');
const { checkConnectivity, setFetcher } = require('./src/core/net');

const VERSION = app.getVersion();
const BROWSER_PARTITION = 'persist:safe-browser';
let win;
let adb; let store = null; let mgr = null; let acq = null;

// ---------- configuración ----------
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  const def = { adbPath: '', casesDir: path.join(app.getPath('documents'), 'SAFE-Casos'), examiner: '' };
  try { return { ...def, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch (_) { return def; }
}
let config;

const emit = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send('safe:' + channel, data); };

// ---------- miniaturas ----------
function makeThumbnail(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width } = img.getSize();
  return (width > 480 ? img.resize({ width: 480, quality: 'good' }) : img).toJPEG(80);
}

function bindCase(s) {
  store = s;
  mgr = new EvidenceManager(store, { makeThumbnail, appVersion: VERSION });
  acq = new Acquirer({ adb, store, mgr, emit });
}

// ---------- puerta de verificación previa ----------
/** Toda acción que produce evidencia pasa por aquí: comprueba internet + servicio de sellado y deja constancia. */
async function gate(action, ack) {
  if (!store) throw new Error('Abra o cree un caso antes de realizar acciones.');
  const pf = await runPreflight(store, action);
  if (pf.degraded && !ack) {
    const e = new Error(pf.warning); e.confirm = true; e.preflight = pf; throw e;
  }
  if (pf.degraded) store.log('preflight.ack', { action, warning: pf.warning });
  return pf;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg = {}) => {
    try { return { ok: true, data: await fn(arg) }; } catch (e) {
      return { ok: false, error: e.message, confirm: !!e.confirm, preflight: e.preflight };
    }
  });
}

function registerIpc() {
  handle('config:get', () => config);
  handle('config:set', (c) => {
    config = { ...config, ...c };
    fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
    fs.writeFileSync(cfgFile(), JSON.stringify(config, null, 2));
    adb = new Adb({ adbPath: config.adbPath });
    if (acq) acq.ctx.adb = adb;
    return config;
  });
  handle('net:status', () => checkConnectivity());
  handle('adb:version', () => adb.version());

  handle('case:create', ({ caseId, examiner, notes }) => {
    fs.mkdirSync(config.casesDir, { recursive: true });
    bindCase(CaseStore.create(config.casesDir, { caseId, examiner: examiner || config.examiner, notes }));
    return { ...store.info(), dir: store.dir };
  });
  handle('case:open', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: config.casesDir });
    if (r.canceled) return null;
    bindCase(CaseStore.open(r.filePaths[0]));
    return { ...store.info(), dir: store.dir };
  });
  handle('case:folder', () => { if (store) shell.openPath(store.dir); });
  handle('case:verifyLog', () => store.verifyLog());

  handle('dev:list', () => adb.devices());
  handle('dev:info', ({ serial }) => adb.deviceInfo(serial));
  handle('dev:foreground', ({ serial }) => adb.foreground(serial));

  handle('act:screenshot', async ({ serial, ack }) => acq.screenshot(serial, await gate('screenshot', ack)));
  handle('act:backup', async ({ serial, options, ack }) => acq.startBackup(serial, options, await gate('backup', ack)));
  handle('act:backupCancel', () => acq.cancelBackup());
  handle('act:recStart', async ({ serial, ack }) => acq.startRecording(serial, await gate('record', ack)));
  handle('act:recStop', () => acq.stopRecording());
  handle('act:pull', async ({ serial, remote, ack }) => acq.pullMedia(serial, remote, await gate('pull', ack)));

  handle('browser:capture', async ({ wcId, ack }) => {
    const pf = await gate('browser-capture', ack);
    const wc = webContents.fromId(wcId);
    if (!wc || wc.getType() !== 'webview') throw new Error('Pestaña del navegador no válida');
    const url = wc.getURL(); const title = wc.getTitle();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const host = (() => { try { return new URL(url).hostname; } catch (_) { return 'pagina'; } })();
    const png = path.join(store.stagingDir(), `web_${host}_${stamp}.png`);
    fs.writeFileSync(png, (await wc.capturePage()).toPNG());
    const mht = path.join(store.stagingDir(), `web_${host}_${stamp}.mhtml`);
    await wc.savePage(mht, 'MHTML');
    const shot = await mgr.register({ srcFile: png, type: 'web', sourceUrl: url, origin: `Navegador interno de S.A.F.E. — «${title}»`, preflight: pf });
    emit('evidence', shot);
    const page = await mgr.register({ srcFile: mht, type: 'webpage', sourceUrl: url, origin: `Navegador interno de S.A.F.E. — «${title}»`, parent: shot.id, preflight: pf });
    emit('evidence', page);
    return [shot, page];
  });

  handle('ev:list', () => (store ? store.list() : []));
  handle('ev:reveal', ({ id }) => { const r = store.list().find((e) => e.id === id); if (r) shell.showItemInFolder(path.join(store.dir, r.relPath)); });
  handle('ev:openReport', ({ id }) => { const r = store.list().find((e) => e.id === id); if (r) shell.openPath(path.join(store.dir, r.reportFile)); });
  handle('ev:refreshOts', async ({ ack }) => mgr.refreshTimestamps(await gate('ots-refresh', ack)));
  handle('ev:verify', () => mgr.verifyIntegrity());
  handle('ev:log', () => (store ? fs.readFileSync(store.custodyFile, 'utf8').trim().split('\n').slice(-200).map((l) => JSON.parse(l)) : []));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1100, minHeight: 700, backgroundColor: '#0b1220', title: 'S.A.F.E. — Secure Android Forensic Extractor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Errores de red asíncronos de la librería OpenTimestamps (p. ej. ECONNRESET) no deben tumbar la aplicación.
process.on('uncaughtException', (e) => {
  if (/^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)/.test(e.code || '')) { console.error('Red:', e.message); return; }
  throw e;
});

app.whenReady().then(() => {
  setFetcher(async (url) => (await require('electron').net.fetch(url, { method: 'GET', cache: 'no-store' })).status);
  config = loadConfig();
  adb = new Adb({ adbPath: config.adbPath });
  Menu.setApplicationMenu(null);
  registerIpc();

  // Endurecimiento del navegador interno
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(({ url }) => { contents.loadURL(url); return { action: 'deny' }; });
    }
    contents.on('will-attach-webview', (ev, prefs) => {
      delete prefs.preload; prefs.nodeIntegration = false; prefs.contextIsolation = true; prefs.sandbox = true;
    });
  });
  createWindow();
});

app.on('window-all-closed', () => { if (acq) { acq.stopRecording(); acq.cancelBackup(); } app.quit(); });
