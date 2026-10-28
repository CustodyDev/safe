'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const ots = require('../src/core/ots');

const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** Calendario OpenTimestamps simulado: devuelve una atestación «pending». */
function fakeCalendar() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const uri = Buffer.from(`http://127.0.0.1:${srv.address().port}`);
        const payload = Buffer.concat([Buffer.from([uri.length]), uri]);
        res.end(Buffer.concat([Buffer.from([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, payload.length]), payload]));
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('stampHash genera un .ots con atestación pendiente', async () => {
  const srv = await fakeCalendar();
  try {
    const bytes = await ots.stampHash(HASH, { calendars: [`http://127.0.0.1:${srv.address().port}`] });
    assert.ok(bytes.length > 40);
    const v = await ots.verify(bytes, HASH);
    assert.strictEqual(v.status, 'pending');
    assert.strictEqual((await ots.verify(bytes, 'aa'.repeat(32))).status, 'invalid');
  } finally { srv.close(); }
});

test('stampHash falla si ningún calendario responde (no marca falsos sellos)', async () => {
  await assert.rejects(ots.stampHash(HASH, { calendars: ['http://127.0.0.1:1'] }), /Ningún calendario/);
});
