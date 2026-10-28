'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sha256Buffer, sha256File } = require('../src/core/hash');
const { Adb, parseForeground, parseDevices } = require('../src/core/adb');
const { CaseStore } = require('../src/core/casestore');
const { EvidenceManager } = require('../src/core/evidence');
const { Acquirer } = require('../src/core/acquire');
const { runPreflight, OFFLINE_WARNING } = require('../src/core/preflight');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
const online = async () => ({ checkedAt: new Date().toISOString(), online: true, timestampService: { available: true, up: 3, total: 4, calendars: [] }, internet: [] });
const offline = async () => ({ checkedAt: new Date().toISOString(), online: false, timestampService: { available: false, up: 0, total: 4, calendars: [] }, internet: [] });
const fakeStamp = async (hex) => Buffer.from('OTS:' + hex);
const adbFake = () => new Adb({ adbPath: path.join(__dirname, 'fake-adb.js') });

test('SHA-256 de archivo y buffer coinciden', async () => {
  const f = path.join(tmp(), 'a.bin'); fs.writeFileSync(f, 'hola');
  assert.strictEqual(await sha256File(f), sha256Buffer(Buffer.from('hola')));
  assert.strictEqual(sha256Buffer(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('parseForeground lee mCurrentFocus y usa mFocusedApp de respaldo', () => {
  assert.deepStrictEqual(parseForeground('mCurrentFocus=Window{4f2a1 u0 com.a.b/com.a.b.Main}').package, 'com.a.b');
  const fb = parseForeground('mCurrentFocus=null\nmFocusedApp=ActivityRecord{1 u0 com.x/.Act t5}');
  assert.strictEqual(fb.package, 'com.x'); assert.strictEqual(fb.activity, 'com.x.Act'); assert.strictEqual(fb.source, 'mFocusedApp');
  assert.strictEqual(parseForeground('nada').package, '');
});

test('parseDevices', () => {
  const d = parseDevices('List of devices attached\nABC\tdevice product:p model:M transport_id:2\n\n');
  assert.strictEqual(d[0].serial, 'ABC'); assert.strictEqual(d[0].model, 'M');
});

test('cadena de custodia detecta manipulación', () => {
  const s = CaseStore.create(tmp(), { caseId: 'T1' });
  s.log('a', { x: 1 }); s.log('b', { y: 2 });
  assert.ok(s.verifyLog().ok);
  fs.writeFileSync(s.custodyFile, fs.readFileSync(s.custodyFile, 'utf8').replace('"x":1', '"x":9'));
  assert.strictEqual(s.verifyLog().ok, false);
});

test('preflight sin conexión advierte y deja constancia', async () => {
  const s = CaseStore.create(tmp(), { caseId: 'T2' });
  const pf = await runPreflight(s, 'backup', offline);
  assert.strictEqual(pf.warning, OFFLINE_WARNING);
  assert.ok(fs.readdirSync(path.join(s.dir, 'preflight')).length === 1);
  assert.ok(fs.readFileSync(s.custodyFile, 'utf8').includes('"preflight"'));
  assert.strictEqual((await runPreflight(s, 'x', online)).warning, null);
});

test('captura de pantalla: hash, .ots, informe PDF y paquete ZIP', async () => {
  const s = CaseStore.create(tmp(), { caseId: 'T3', examiner: 'Ana' });
  const mgr = new EvidenceManager(s, { stampFn: fakeStamp, makeThumbnail: (f) => fs.readFileSync(f) });
  const acq = new Acquirer({ adb: adbFake(), store: s, mgr, emit() {} });
  const pf = await runPreflight(s, 'screenshot', online);
  const rec = await acq.screenshot('FAKE123', pf);
  const dir = path.join(s.dir, 'evidence', rec.id);
  assert.strictEqual(rec.sha256, await sha256File(path.join(dir, rec.fileName)));
  assert.strictEqual(rec.ots.status, 'pending');
  assert.strictEqual(rec.foreground.package, 'com.whatsapp');
  assert.strictEqual(rec.device.model, 'Pixel Fake');
  assert.ok(fs.readFileSync(path.join(dir, `informe_${rec.id}.pdf`)).subarray(0, 5).toString() === '%PDF-');
  assert.ok(fs.readFileSync(path.join(dir, `paquete_${rec.id}.zip`)).subarray(0, 2).toString() === 'PK');
  assert.ok(fs.readFileSync(path.join(dir, rec.fileName + '.sha256'), 'utf8').startsWith(rec.sha256));
  assert.ok((await mgr.verifyIntegrity()).every((x) => x.ok));
});

test('sin conexión: la evidencia se registra marcada como no sellada y se sella después', async () => {
  const s = CaseStore.create(tmp(), { caseId: 'T4' });
  const mgr = new EvidenceManager(s, { stampFn: fakeStamp });
  const acq = new Acquirer({ adb: adbFake(), store: s, mgr, emit() {} });
  const rec = await acq.screenshot('FAKE123', await runPreflight(s, 'screenshot', offline));
  assert.strictEqual(rec.ots.status, 'not-stamped');
  const res = await mgr.refreshTimestamps(await online());
  assert.strictEqual(res[0].to, 'pending');
  assert.strictEqual(s.list()[0].ots.status, 'pending');
});

test('copia ADB y extracción multimedia conservan el nombre original', async () => {
  const s = CaseStore.create(tmp(), { caseId: 'T5' });
  const mgr = new EvidenceManager(s, { stampFn: fakeStamp });
  const acq = new Acquirer({ adb: adbFake(), store: s, mgr, emit() {} });
  const pf = await runPreflight(s, 'x', online);
  const bk = await acq.startBackup('FAKE123', { apk: true, shared: true }, pf);
  assert.match(bk.fileName, /^backup_Pixel_Fake_.*\.ab$/);
  const media = await acq.pullMedia('FAKE123', '/sdcard/DCIM/Camera', pf);
  assert.deepStrictEqual(media.map((m) => m.fileName).sort(), ['IMG_2041.jpg', 'VID_0007.mp4']);
  assert.strictEqual(media[0].sourcePath.startsWith('/sdcard/DCIM/Camera/'), true);
});

test('grabación de pantalla genera evidencia de vídeo con cronología de app', async () => {
  const s = CaseStore.create(tmp(), { caseId: 'T6' });
  const mgr = new EvidenceManager(s, { stampFn: fakeStamp });
  const events = [];
  const acq = new Acquirer({ adb: adbFake(), store: s, mgr, emit: (c, d) => events.push(c) });
  process.env.SAFE_FFMPEG = 'ffmpeg-no-existe';
  await acq.startRecording('FAKE123', await runPreflight(s, 'record', online));
  await new Promise((r) => setTimeout(r, 700));
  acq.stopRecording();
  await new Promise((r) => { const t = setInterval(() => { if (events.includes('recording') && !acq.rec) { clearInterval(t); r(); } }, 50); });
  const vids = s.list().filter((e) => e.type === 'video');
  assert.ok(vids.length >= 1);
  assert.strictEqual(vids[0].timeline[0].component, 'com.whatsapp/com.whatsapp.HomeActivity');
});
