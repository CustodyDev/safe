'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const { Adb } = require('./src/core/adb');
const { CaseStore } = require('./src/core/casestore');
const { EvidenceManager } = require('./src/core/evidence');
const { Acquirer } = require('./src/core/acquire');
const { finalizeCase } = require('./src/core/finalize');
const { runPreflight } = require('./src/core/preflight');
const { checkConnectivity, setFetcher } = require('./src/core/net');

const VERSION = app.getVersion();
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
  handle('act:liveStart', async ({ serial, maxSize, control, engine, ack }) => { await gate('live', ack); return acq.startLive(serial, { maxSize: Number(maxSize) || 0, control: control !== false, engine }); });
  handle('act:liveStop', () => acq.stopLive());
  handle('act:recStart', async ({ ack }) => acq.startRecording(await gate('record', ack)));
  handle('act:recStop', () => acq.stopRecording());

  // Explorador de archivos del dispositivo
  handle('fs:list', ({ serial, dir }) => acq.listDir(serial, dir));
  handle('fs:hash', async ({ serial, paths, ack }) => { await gate('fs-hash', ack); return acq.hashRemote(serial, paths); });
  handle('fs:extract', async ({ serial, paths, ack }) => acq.extractFiles(serial, paths, await gate('extract', ack)));

  handle('case:finalize', async ({ ack }) => {
    if (acq.live || acq.backup) throw new Error('Finalice antes la sesión en vivo / grabación / copia en curso.');
    const pf = await gate('finalize', ack);
    return finalizeCase(store, mgr, { preflight: pf, onProgress: (m) => emit('progress', { kind: 'finalize', message: m }) });
  });
  handle('ev:list', () => (store ? store.list() : []));
  handle('ev:revealPath', ({ file }) => { if (store && path.dirname(file) === path.dirname(store.dir)) shell.showItemInFolder(file); });
  handle('ev:reveal', ({ id }) => { const r = store.list().find((e) => e.id === id); if (r) shell.showItemInFolder(path.join(store.dir, r.relPath)); });
  handle('ev:openReport', ({ id }) => { const r = store.list().find((e) => e.id === id); if (r) shell.openPath(path.join(store.dir, r.reportFile)); });
  handle('ev:refreshOts', async ({ ack }) => mgr.refreshTimestamps(await gate('ots-refresh', ack)));
  handle('ev:verify', () => mgr.verifyIntegrity());
  handle('ev:verifyOne', async ({ id }) => mgr.verifyOne(id, { online: (await checkConnectivity()).online }));
  handle('ev:log', () => (store ? fs.readFileSync(store.custodyFile, 'utf8').trim().split('\n').slice(-200).map((l) => JSON.parse(l)) : []));
}

ipcMain.on('safe:control', (_e, msg) => { try { if (acq) acq.control(msg); } catch (_) { /* sesión cerrada */ } });

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 1100, minHeight: 700, backgroundColor: '#0b1220', title: 'S.A.F.E. — Secure Android Forensic Extractor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
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

  createWindow();
});

app.on('window-all-closed', async () => { if (acq) { acq.cancelBackup(); try { await acq.stopLive(); } catch (_) { /* cerrando */ } } app.quit(); });
