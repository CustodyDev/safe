'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Adb } = require('../src/core/adb');
const { AnnexBPacketizer } = require('../src/core/annexb');
const { CaseStore } = require('../src/core/casestore');
const { EvidenceManager } = require('../src/core/evidence');
const { Acquirer } = require('../src/core/acquire');

const nal = (t, n) => Buffer.concat([Buffer.from([0, 0, 0, 1, t]), Buffer.alloc(n, t)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('AnnexBPacketizer: config, clave y delta; trocea en cualquier punto y vacía el último NAL', async () => {
  const stream = Buffer.concat([nal(0x67, 6), nal(0x68, 3), nal(0x65, 50), nal(0x41, 20), nal(0x41, 20)]);
  const pk = new AnnexBPacketizer({ flushMs: 20 }); const got = [];
  pk.on('packet', (p) => got.push(p));
  for (let i = 0; i < stream.length; i += 7) pk.push(stream.subarray(i, i + 7));
  await sleep(80); // el último NAL se libera por inactividad (pantalla estática)
  assert.deepStrictEqual(got.map((p) => (p.config ? 'C' : p.key ? 'K' : 'D')), ['C', 'K', 'D', 'D']);
  assert.ok(got[0].data.equals(Buffer.concat([nal(0x67, 6), nal(0x68, 3)])));
  assert.ok(got[1].data.equals(nal(0x65, 50)));
});

test('modo ADB nativo: sin archivos subidos, un único archivo aunque screenrecord se reinicie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
  const s = CaseStore.create(dir, { caseId: 'N1' });
  const mgr = new EvidenceManager(s, { stampFn: async (h) => Buffer.from(h) });
  const events = [];
  const calls = [];
  const adb = new Adb({ adbPath: path.join(__dirname, 'fake-adb.js') });
  const orig = adb.run.bind(adb); adb.run = (args, o) => { calls.push(args.join(' ')); return orig(args, o); };
  const acq = new Acquirer({ adb, store: s, mgr, emit: (c, d) => events.push([c, d]) });
  process.env.SAFE_FFMPEG = 'ffmpeg-no-existe';
  await acq.startLive('FAKE123', { engine: 'native', maxSize: 720, control: true });
  assert.strictEqual(events.find((e) => e[0] === 'live:ready')[1].engine, 'native');
  assert.ok(!calls.some((c) => /\bpush\b|forward/.test(c)), 'no sube nada ni abre túneles');
  assert.strictEqual(acq.live.control, false);
  acq.control({ t: 'touch', action: 0, x: 1, y: 1 }); // ignorado
  await acq.startRecording({ checkedAt: 'x', online: true, timestampService: { available: true, up: 1, total: 1 } });
  await sleep(1200); // >1 reinicio del fake (cada ejecución dura ~250 ms)
  const rec = await acq.stopRecording();
  await acq.stopLive();
  assert.ok(rec.recording.gaps.length >= 1, 'hubo reinicios encadenados');
  assert.strictEqual(rec.recording.engine, 'native');
  assert.strictEqual(s.list().filter((e) => e.type === 'video').length, 1);
  const file = fs.readFileSync(path.join(s.dir, rec.relPath));
  assert.ok(file.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])));
  assert.ok(file.indexOf(Buffer.from([0x67])) >= 0 && file.indexOf(Buffer.from([0x65])) >= 0);
  const log = fs.readFileSync(s.custodyFile, 'utf8');
  assert.ok(log.includes('deviceFootprint') && !log.includes('serverSha256'));
});
