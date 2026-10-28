'use strict';
const { EventEmitter } = require('events');
const { AnnexBPacketizer } = require('./annexb');

/**
 * Pantalla en vivo con ADB nativo (`screenrecord` → stdout). NO sube ningún archivo al dispositivo ni
 * permite interacción. screenrecord limita cada ejecución a 180 s: se relanza y se encadena en el mismo flujo
 * (cada reinicio añade SPS/PPS + fotograma clave, por lo que el archivo resultante sigue siendo un H.264 válido).
 * Misma interfaz que ScrcpySession: eventos ready / packet / gap / close.
 */
class NativeSession extends EventEmitter {
  constructor(adb, serial, { maxSize = 0, bitRate = 8000000 } = {}) {
    super();
    Object.assign(this, { adb, serial, maxSize, bitRate });
    this.control = false; this.size = { w: 0, h: 0 }; this.lastConfig = null; this.closed = false; this.child = null; this.fails = 0; this.errLog = ''; this.lastKick = 0;
  }

  async start() {
    try {
      const out = await this.adb.shell(this.serial, 'wm size', { timeout: 8000 });
      const m = out.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g);
      const last = m && m[m.length - 1].match(/(\d+)x(\d+)/);
      if (last) this.size = { w: +last[1], h: +last[2] };
    } catch (_) { /* tamaño opcional */ }
    if (this.maxSize && this.size.w) {
      const k = Math.min(1, this.maxSize / Math.max(this.size.w, this.size.h));
      this.sizeArg = `${Math.round((this.size.w * k) / 2) * 2}x${Math.round((this.size.h * k) / 2) * 2}`;
    }
    await new Promise((resolve, reject) => {
      const onPacket = () => { clearTimeout(t); this.off('packet', onPacket); this.off('close', onClose); resolve(); };
      const onClose = () => { clearTimeout(t); reject(new Error(this.errLog.trim() || 'screenrecord terminó sin emitir vídeo')); };
      const t = setTimeout(() => { this.off('packet', onPacket); this.off('close', onClose); this.stop(); reject(new Error(this.errLog.trim() || 'screenrecord no emitió vídeo en 10 s (¿pantalla bloqueada o no soportado?)')); }, 10000);
      this.on('packet', onPacket); this.on('close', onClose);
      this._spawn();
    });
    this.emit('ready', { deviceName: this.serial, ...this.size, jarSha256: null });
  }

  _spawn() {
    if (this.closed) return;
    const child = this.adb.screenrecordProcess(this.serial, { bitRate: this.bitRate, size: this.sizeArg });
    this.child = child;
    const pk = new AnnexBPacketizer();
    const born = Date.now(); let got = 0;
    pk.on('packet', (p) => { got++; if (p.config) this.lastConfig = p.data; this.emit('packet', p); });
    child.stdout.on('data', (d) => pk.push(d));
    child.stderr.on('data', (d) => { this.errLog += d; if (this.errLog.length > 4000) this.errLog = this.errLog.slice(-2000); });
    child.on('error', (e) => { this.errLog += e.message; });
    child.on('close', () => {
      pk.end();
      if (this.closed || this.child !== child) return;
      this.fails = got === 0 && Date.now() - born < 3000 ? this.fails + 1 : 0;
      if (this.fails >= 3) { this.closed = true; this.emit('close', 'error'); return; }
      this.emit('gap', { ts: new Date().toISOString() });
      this._spawn(); // límite de 180 s: continúa en el mismo flujo
    });
  }

  /** Sin protocolo de control: reiniciar screenrecord es la única forma de obtener un fotograma clave inmediato. */
  requestKeyframe() {
    if (Date.now() - this.lastKick < 3000 || !this.child) return;
    this.lastKick = Date.now();
    this.child.kill();
  }

  send() { /* sin interacción en modo nativo */ }

  async stop() {
    this.closed = true;
    try { this.child && this.child.kill(); } catch (_) { /* ya terminado */ }
    this.emit('close', 'stop');
  }
}

module.exports = { NativeSession };
