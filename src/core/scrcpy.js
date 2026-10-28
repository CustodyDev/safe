'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { sha256File } = require('./hash');

// El servidor y el cliente deben coincidir EXACTAMENTE en versión.
const VERSION = '3.3.3';
const JAR_SHA256 = '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0';
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';

function jarPath() {
  const c = [process.resourcesPath && path.join(process.resourcesPath, 'vendor', `scrcpy-server-v${VERSION}`), path.join(__dirname, '..', '..', 'vendor', `scrcpy-server-v${VERSION}`)];
  return c.find((p) => p && fs.existsSync(p)) || c[1];
}

// ---------- mensajes de control (big-endian) ----------
const ACTION = { DOWN: 0, UP: 1, MOVE: 2 };
const FINGER_ID = 0xfffffffffffffffen; // POINTER_ID_VIRTUAL_FINGER: se inyecta como pantalla táctil

function msgTouch(action, x, y, w, h) {
  const b = Buffer.alloc(32);
  b.writeUInt8(2, 0); b.writeUInt8(action, 1); b.writeBigUInt64BE(FINGER_ID, 2);
  b.writeInt32BE(Math.round(x), 10); b.writeInt32BE(Math.round(y), 14);
  b.writeUInt16BE(w, 18); b.writeUInt16BE(h, 20);
  b.writeUInt16BE(action === ACTION.UP ? 0 : 0xffff, 22); // presión
  b.writeInt32BE(0, 24); b.writeInt32BE(0, 28);
  return b;
}
function msgKey(action, keycode, meta = 0) {
  const b = Buffer.alloc(14); b.writeUInt8(0, 0); b.writeUInt8(action, 1); b.writeInt32BE(keycode, 2); b.writeInt32BE(0, 6); b.writeInt32BE(meta, 10); return b;
}
function msgText(text) {
  const t = Buffer.from(text, 'utf8').subarray(0, 300);
  const b = Buffer.alloc(5 + t.length); b.writeUInt8(1, 0); b.writeUInt32BE(t.length, 1); t.copy(b, 5); return b;
}
function msgScroll(x, y, w, h, dx, dy) {
  const fp = (v) => Math.max(-0x8000, Math.min(0x7fff, Math.round(Math.max(-1, Math.min(1, v)) * 0x8000)));
  const b = Buffer.alloc(21);
  b.writeUInt8(3, 0); b.writeInt32BE(Math.round(x), 1); b.writeInt32BE(Math.round(y), 5); b.writeUInt16BE(w, 9); b.writeUInt16BE(h, 11);
  b.writeInt16BE(fp(dx), 13); b.writeInt16BE(fp(dy), 15); b.writeInt32BE(0, 17);
  return b;
}
const msgResetVideo = () => Buffer.from([17]); // pide un fotograma clave

/** Lector que entrega exactamente n bytes de un socket. */
class Reader {
  constructor(sock) {
    this.buf = Buffer.alloc(0); this.wait = null; this.closed = false;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    const end = () => { this.closed = true; if (this.wait) { const w = this.wait; this.wait = null; w.reject(new Error('Conexión cerrada')); } };
    sock.on('close', end); sock.on('error', end);
  }
  _pump() {
    if (this.wait && this.buf.length >= this.wait.n) {
      const { n, resolve } = this.wait; this.wait = null;
      const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); resolve(out);
    }
  }
  read(n) {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      if (this.buf.length < n && this.closed) return reject(new Error('Conexión cerrada'));
      this.wait = { n, resolve, reject }; this._pump();
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sesión de pantalla en vivo + control mediante scrcpy-server. Eventos: ready, packet, close, log. */
class ScrcpySession extends EventEmitter {
  constructor(adb, serial, { maxSize = 0, bitRate = 8000000, maxFps = 60, control = true, jar = jarPath() } = {}) {
    super();
    Object.assign(this, { adb, serial, maxSize, bitRate, maxFps, control, jar });
    this.lastConfig = null; this.size = { w: 0, h: 0 }; this.closed = false; this.serverLog = '';
  }

  async start() {
    if (!fs.existsSync(this.jar)) throw new Error(`Falta scrcpy-server (${this.jar}).`);
    this.jarSha256 = await sha256File(this.jar);
    if (this.jarSha256 !== JAR_SHA256) throw new Error('El scrcpy-server incluido no coincide con el SHA-256 esperado; no se sube al dispositivo.');
    const scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const hex = scid.toString(16).padStart(8, '0');
    await this.adb.push(this.serial, this.jar, REMOTE_JAR);
    this.port = await this.adb.forward(this.serial, `localabstract:scrcpy_${hex}`);
    const args = [`scid=${hex}`, 'log_level=info', 'audio=false', `control=${this.control}`, 'tunnel_forward=true', 'send_dummy_byte=true', 'send_device_meta=true', 'send_codec_meta=true', 'send_frame_meta=true', 'video_codec=h264',
      `video_bit_rate=${this.bitRate}`, `max_fps=${this.maxFps}`, 'clipboard_autosync=false', 'stay_awake=false', 'power_on=false', 'show_touches=false', 'cleanup=true'];
    if (this.maxSize) args.push(`max_size=${this.maxSize}`);
    this.server = this.adb.spawnShell(this.serial, [`CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', VERSION, ...args]);
    const onLog = (d) => { this.serverLog += d; if (this.serverLog.length > 20000) this.serverLog = this.serverLog.slice(-10000); };
    this.server.stdout.on('data', onLog); this.server.stderr.on('data', onLog);
    this.server.on('close', () => this._close('server'));
    this.server.on('error', (e) => this._close(e.message));

    try {
      const v = await this._connectVideo();
      this.vreader = v;
      if (this.control) this.csock = await this._connectRaw();
      await this._header();
    } catch (e) { const log = this.serverLog.trim().split('\n').slice(-3).join(' | '); await this.stop(); throw new Error(`${e.message}${log ? ' — ' + log : ''}`); }
    this._loop();
  }

  _connectRaw() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, '127.0.0.1');
      s.setNoDelay(true);
      s.once('connect', () => resolve(s)); s.once('error', reject);
    });
  }

  /** Conecta el socket de vídeo y espera el byte «dummy» que confirma que el servidor aceptó. */
  async _connectVideo() {
    for (let i = 0; i < 100; i++) {
      if (this.closed) throw new Error('El servidor scrcpy terminó antes de conectar');
      let s;
      try { s = await this._connectRaw(); } catch (_) { await sleep(100); continue; }
      this.vsock = s;
      const r = new Reader(s);
      try { await r.read(1); return r; } catch (_) { s.destroy(); await sleep(100); }
    }
    throw new Error('No se pudo conectar con el servidor scrcpy del dispositivo');
  }

  async _header() {
    const r = this.vreader;
    this.deviceName = (await r.read(64)).toString('utf8').replace(/\0+$/, '');
    const codec = await r.read(4);
    if (codec.toString('ascii') !== 'h264') throw new Error('Códec de vídeo inesperado: ' + codec.toString('ascii'));
    this.size = { w: (await r.read(4)).readUInt32BE(0), h: (await r.read(4)).readUInt32BE(0) };
    this.emit('ready', { deviceName: this.deviceName, ...this.size, jarSha256: this.jarSha256 });
  }

  async _loop() {
    try {
      for (;;) {
        const h = await this.vreader.read(12);
        const pts = h.readBigUInt64BE(0);
        const data = Buffer.from(await this.vreader.read(h.readUInt32BE(8)));
        const p = { config: !!((pts >> 63n) & 1n), key: !!((pts >> 62n) & 1n), ptsUs: Number(pts & 0x3fffffffffffffffn), data };
        if (p.config) this.lastConfig = data;
        this.emit('packet', p);
      }
    } catch (_) { this._close('stream'); }
  }

  send(buf) { if (this.control && this.csock && !this.csock.destroyed) this.csock.write(buf); }
  requestKeyframe() { this.send(msgResetVideo()); }

  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }

  async stop() {
    this.closed = true;
    for (const s of [this.vsock, this.csock]) { try { s && s.destroy(); } catch (_) { /* ya cerrado */ } }
    try { this.server && this.server.kill(); } catch (_) { /* ya terminado */ }
    try { if (this.port) await this.adb.forwardRemove(this.serial, `tcp:${this.port}`); } catch (_) { /* opcional */ }
    this.emit('close', 'stop');
  }
}

module.exports = { ScrcpySession, VERSION, JAR_SHA256, REMOTE_JAR, jarPath, ACTION, msgTouch, msgKey, msgText, msgScroll, msgResetVideo };
