'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Adb } = require('../src/core/adb');
const { CaseStore } = require('../src/core/casestore');
const { EvidenceManager } = require('../src/core/evidence');
const { Acquirer } = require('../src/core/acquire');
const { finalizeCase, hashZipEntries } = require('../src/core/finalize');

const pf = { checkedAt: 'x', online: true, timestampService: { available: true, up: 1, total: 1 } };
async function setup(id) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
  const s = CaseStore.create(base, { caseId: id });
  const mgr = new EvidenceManager(s, { stampFn: async (h) => Buffer.from('OTS' + h) });
  const acq = new Acquirer({ adb: new Adb({ adbPath: path.join(__dirname, 'fake-adb.js') }), store: s, mgr, emit() {} });
  await acq.screenshot('FAKE123', pf);
  await acq.extractFiles('FAKE123', ['/sdcard/DCIM/Camera'], pf);
  return { s, mgr };
}

test('cierre del caso: ZIP completo, hash, sello y validación final correcta', async () => {
  const { s, mgr } = await setup('F1');
  const msgs = [];
  const r = await finalizeCase(s, mgr, { preflight: pf, stampFn: async (h) => Buffer.from('OTS' + h), onProgress: (m) => msgs.push(m) });
  assert.strictEqual(r.status, 'OK', JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(fs.existsSync(r.zipFile) && fs.existsSync(r.zipFile + '.sha256') && fs.existsSync(r.zipFile + '.ots'));
  assert.strictEqual(r.zipOts, 'pending');
  assert.strictEqual(path.dirname(r.zipFile), path.dirname(s.dir));
  const entries = await hashZipEntries(r.zipFile);
  const names = Object.keys(entries);
  assert.ok(names.includes('F1/MANIFEST.json') && names.includes('F1/custody.log.jsonl') && names.includes('F1/evidence.json'));
  assert.ok(names.some((n) => n.endsWith('IMG_2041.jpg')) && names.some((n) => n.endsWith('.pdf')));
  assert.ok(!names.some((n) => n.includes('staging')));
  assert.ok(msgs.some((m) => /Validación final/.test(m)));
  assert.ok(fs.readFileSync(s.custodyFile, 'utf8').includes('finalize.done'));
  assert.ok(s.verifyLog().ok);
});

test('cierre del caso detecta una evidencia alterada', async () => {
  const { s, mgr } = await setup('F2');
  const rec = s.list().find((e) => e.fileName === 'VID_0007.mp4');
  const f = path.join(s.dir, rec.relPath); fs.chmodSync(f, 0o644); fs.appendFileSync(f, 'manipulado');
  const r = await finalizeCase(s, mgr, { preflight: pf, stampFn: async () => Buffer.from('x') });
  assert.strictEqual(r.status, 'FALLO');
  assert.ok(r.checks.find((c) => c.name.startsWith('Integridad')).ok === false);
  assert.ok(r.checks.find((c) => c.name.startsWith('Originales dentro del ZIP')).ok === false);
});

test('sin conexión el ZIP se crea sin sello y se informa', async () => {
  const { s, mgr } = await setup('F3');
  const r = await finalizeCase(s, mgr, { preflight: { online: false, timestampService: { available: false } } });
  assert.strictEqual(r.status, 'OK_CON_AVISOS'); assert.strictEqual(r.zipOts, 'not-stamped'); assert.ok(!fs.existsSync(r.zipFile + '.ots'));
});

test('un ZIP corrupto es detectado al releerlo', async () => {
  const { s, mgr } = await setup('F4');
  const r = await finalizeCase(s, mgr, { preflight: pf, stampFn: async () => Buffer.from('x') });
  const b = fs.readFileSync(r.zipFile);
  b[Math.floor(b.length / 4)] ^= 0xff; // un byte alterado dentro de los datos del ZIP
 fs.writeFileSync(r.zipFile, b);
  const manifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')).files;
  let detected = false;
  try {
    const entries = await hashZipEntries(r.zipFile);
    detected = manifest.some((f) => { const e = entries['F4/' + f.path]; return !e || e.sha256 !== f.sha256; });
  } catch (_) { detected = true; }
  assert.ok(detected);
});
