'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Adb } = require('../src/core/adb');
const { ScrcpySession, msgTouch, msgKey, msgText, msgScroll, ACTION } = require('../src/core/scrcpy');
const { CaseStore } = require('../src/core/casestore');
const { EvidenceManager } = require('../src/core/evidence');
const { Acquirer } = require('../src/core/acquire');

const CONFIG = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28]), Buffer.alloc(6, 3), Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80])]);

function header(ptsFlags, len) { const b = Buffer.alloc(12); b.writeBigUInt64BE(ptsFlags, 0); b.writeUInt32BE(len, 8); return b; }

/** Servidor scrcpy simulado (protocolo v3): vídeo en el 1.er socket, control en el 2.º. */
function fakeServer() {
  const ctl = []; let n = 0; const timers = [];
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    if (n++ === 0) {
      const name = Buffer.alloc(64); name.write('Pixel Fake');
      const sz = Buffer.alloc(8); sz.writeUInt32BE(1080, 0); sz.writeUInt32BE(2400, 4);
      sock.write(Buffer.concat([Buffer.from([0]), name, Buffer.from('h264'), sz]));
      sock.write(Buffer.concat([header(1n << 63n, CONFIG.length), CONFIG]));
      let i = 0;
      timers.push(setInterval(() => {
        const key = i % 10 === 0; const data = Buffer.concat([Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41]), Buffer.alloc(20, i)]);
        const pts = BigInt(i * 16666) | (key ? 1n << 62n : 0n);
        if (!sock.destroyed) sock.write(Buffer.concat([header(pts, data.length), data]));
        i++;
      }, 20));
    } else sock.on('data', (d) => ctl.push(d));
  }).listen(0, '127.0.0.1');
  return new Promise((res) => srv.on('listening', () => res({ srv, ctl, port: srv.address().port, close: () => { timers.forEach(clearInterval); srv.close(); } })));
}

const adbFake = () => new Adb({ adbPath: path.join(__dirname, 'fake-adb.js') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('mensajes de control tienen el formato del protocolo', () => {
  const t = msgTouch(ACTION.DOWN, 100, 200, 1080, 2400);
  assert.strictEqual(t.length, 32); assert.strictEqual(t[0], 2); assert.strictEqual(t[1], 0);
  assert.strictEqual(t.readInt32BE(10), 100); assert.strictEqual(t.readInt32BE(14), 200); assert.strictEqual(t.readUInt16BE(18), 1080); assert.strictEqual(t.readUInt16BE(20), 2400); assert.strictEqual(t.readUInt16BE(22), 0xffff);
  assert.strictEqual(msgTouch(ACTION.UP, 1, 1, 10, 10).readUInt16BE(22), 0);
  const k = msgKey(0, 4); assert.strictEqual(k.length, 14); assert.strictEqual(k.readInt32BE(2), 4);
  const x = msgText('hola'); assert.strictEqual(x.readUInt32BE(1), 4); assert.strictEqual(x.subarray(5).toString(), 'hola');
  const sc = msgScroll(5, 6, 100, 200, 0, -1); assert.strictEqual(sc.length, 21); assert.strictEqual(sc.readInt16BE(15), -0x8000);
});

test('sesión en vivo: cabecera, paquetes, control y grabación en UN solo archivo', async () => {
  const fs_ = await fakeServer();
  process.env.FAKE_SCRCPY_PORT = String(fs_.port);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
  const s = CaseStore.create(dir, { caseId: 'L1' });
  const mgr = new EvidenceManager(s, { stampFn: async (h) => Buffer.from(h) });
  const events = [];
  const acq = new Acquirer({ adb: adbFake(), store: s, mgr, emit: (c, d) => events.push([c, d]) });
  process.env.SAFE_FFMPEG = 'ffmpeg-no-existe';
  try {
    await acq.startLive('FAKE123', { maxSize: 1280, control: true });
    const ready = events.find((e) => e[0] === 'live:ready')[1];
    assert.strictEqual(ready.deviceName, 'Pixel Fake'); assert.strictEqual(ready.w, 1080); assert.strictEqual(ready.h, 2400);
    await sleep(150);
    const pkts = events.filter((e) => e[0] === 'live:packet').map((e) => e[1]);
    assert.ok(pkts.some((p) => p.config) && pkts.some((p) => p.key) && pkts.some((p) => !p.key && !p.config));

    acq.control({ t: 'touch', action: 0, x: 540, y: 1200 });
    await sleep(100);
    const got = Buffer.concat(fs_.ctl);
    assert.strictEqual(got[0], 2); assert.strictEqual(got.readInt32BE(10), 540); assert.strictEqual(got.readUInt16BE(18), 1080);

    await acq.startRecording({ checkedAt: 'x', online: true, timestampService: { available: true, up: 1, total: 1 } });
    await sleep(700);
    const rec = await acq.stopRecording();
    assert.ok(rec && rec.type === 'video'); assert.ok(rec.recording.frames > 5);
    const file = fs.readFileSync(path.join(s.dir, rec.relPath));
    assert.ok(file.subarray(0, CONFIG.length).equals(CONFIG), 'el archivo empieza con SPS/PPS');
    assert.strictEqual(file[CONFIG.length + 4], 0x65, 'y el primer fotograma es clave');
    assert.strictEqual(s.list().filter((e) => e.type === 'video').length, 1, 'un único archivo de vídeo');
    assert.ok(rec.timeline[0].component.includes('com.whatsapp'));

    await acq.stopLive(); await sleep(100);
    assert.ok(fs.readFileSync(s.custodyFile, 'utf8').includes('"live.stop"'));
    assert.ok(fs.readFileSync(s.custodyFile, 'utf8').includes('serverSha256'));
  } finally { await acq.stopLive(); fs_.close(); }
});
