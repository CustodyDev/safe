'use strict';
const OpenTimestamps = require('opentimestamps');
const { CALENDARS } = require('./net');

const hexToBytes = (hex) => Buffer.from(hex, 'hex');

/** Sella un hash SHA-256 (hex) con OpenTimestamps. Devuelve el contenido del .ots. */
async function stampHash(sha256hex, { calendars = CALENDARS } = {}) {
  const detached = OpenTimestamps.DetachedTimestampFile.fromHash(new OpenTimestamps.Ops.OpSHA256(), hexToBytes(sha256hex));
  await OpenTimestamps.stamp(detached, { calendars, m: Math.min(2, calendars.length) });
  // La librería NO falla si ningún calendario responde: exigimos al menos una atestación.
  if (detached.timestamp.allAttestations().size === 0) {
    throw new Error('Ningún calendario OpenTimestamps aceptó el sello (servicio no disponible).');
  }
  return Buffer.from(detached.serializeToBytes());
}

/** Intenta completar un sello pendiente con la prueba de Bitcoin. Devuelve {bytes, changed}. */
async function upgrade(otsBytes) {
  const detached = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(otsBytes));
  const changed = await OpenTimestamps.upgrade(detached);
  return { bytes: Buffer.from(detached.serializeToBytes()), changed: !!changed };
}

/** Verifica un .ots contra el hash original. Devuelve {status:'confirmed'|'pending'|'invalid', ...}. */
async function verify(otsBytes, sha256hex) {
  const stamped = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(otsBytes));
  const original = OpenTimestamps.DetachedTimestampFile.fromHash(new OpenTimestamps.Ops.OpSHA256(), hexToBytes(sha256hex));
  try {
    const res = await OpenTimestamps.verify(stamped, original, { ignoreBitcoinNode: true });
    const btc = res && (res.bitcoin || res.chain === 'bitcoin' ? res.bitcoin || res : null);
    if (btc && (btc.timestamp || btc.attestedTime)) {
      const ts = btc.timestamp || btc.attestedTime;
      return { status: 'confirmed', chain: 'bitcoin', height: btc.height, attestedTime: new Date(ts * 1000).toISOString() };
    }
    return { status: 'pending' };
  } catch (e) {
    if (/mismatch|does not match/i.test(e.message)) return { status: 'invalid', error: e.message };
    return { status: 'pending', error: e.message };
  }
}

/** Lee un .ots SIN red: devuelve el hash que sella y las atestaciones que contiene. */
function inspect(otsBytes) {
  const d = OpenTimestamps.DetachedTimestampFile.deserialize(Buffer.from(otsBytes));
  const digest = Buffer.from(d.fileDigest()).toString('hex');
  const atts = [];
  d.timestamp.allAttestations().forEach((a) => {
    if (a.height !== undefined) atts.push({ type: 'bitcoin', height: a.height });
    else if (a.uri !== undefined) atts.push({ type: 'pending', uri: Buffer.from(a.uri).toString('utf8') });
    else atts.push({ type: 'unknown' });
  });
  return { digest, attestations: atts };
}

module.exports = { stampHash, upgrade, verify, inspect };
