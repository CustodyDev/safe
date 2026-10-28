'use strict';
const { EventEmitter } = require('events');

/**
 * Convierte un flujo H.264 Annex-B crudo (salida de `screenrecord`) en paquetes
 * {config, key, ptsUs, data}, el mismo formato que entrega scrcpy.
 * Un NAL se considera completo al llegar el siguiente código de inicio, o tras `flushMs` sin datos
 * (para no dejar congelado el último fotograma de una pantalla estática).
 */
class AnnexBPacketizer extends EventEmitter {
  constructor({ flushMs = 30 } = {}) {
    super();
    this.flushMs = flushMs; this.buf = Buffer.alloc(0); this.cfg = null; this.t0 = Date.now(); this.timer = null; this.synced = false;
  }

  push(chunk) {
    clearTimeout(this.timer);
    this.buf = Buffer.concat([this.buf, chunk]);
    const starts = this._starts();
    if (!this.synced) { if (!starts.length) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 3)); return; } this.buf = this.buf.subarray(starts[0]); starts.forEach((_, i) => (starts[i] -= starts[0])); this.synced = true; }
    for (let k = 0; k + 1 < starts.length; k++) this._nal(this.buf.subarray(starts[k], starts[k + 1]));
    if (starts.length) this.buf = this.buf.subarray(starts[starts.length - 1]);
    this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  flush() {
    clearTimeout(this.timer);
    if (this.synced && this.buf.length > 5) { this._nal(this.buf); this.buf = Buffer.alloc(0); this.synced = false; }
  }

  end() { this.flush(); clearTimeout(this.timer); }

  _starts() {
    const out = []; const b = this.buf;
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0) {
        if (b[i + 2] === 1) { out.push(i); i += 2; } else if (b[i + 2] === 0 && b[i + 3] === 1) { out.push(i); i += 3; }
      }
    }
    return out;
  }

  _nal(nal) {
    const nal_ = Buffer.from(nal);
    const type = nal_[nal_[2] === 1 ? 3 : 4] & 0x1f;
    const ptsUs = (Date.now() - this.t0) * 1000;
    if (type === 7) { this.cfg = [nal_]; return; }
    if (type === 8) { if (this.cfg) { this.cfg.push(nal_); this._emitCfg(ptsUs); } return; }
    if (type === 5 || type === 1) this.emit('packet', { config: false, key: type === 5, ptsUs, data: nal_ });
  }

  _emitCfg(ptsUs) { const data = Buffer.concat(this.cfg); this.cfg = null; this.emit('packet', { config: true, key: false, ptsUs, data }); }
}

module.exports = { AnnexBPacketizer };
