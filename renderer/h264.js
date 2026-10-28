'use strict';
/**
 * Decodificador en vivo de H.264 Annex-B (salida de `screenrecord`) con WebCodecs.
 * Agrupa NALs en frames: SPS/PPS se anteponen al siguiente IDR.
 */
class LiveH264 {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.buf = new Uint8Array(0); this.prefix = []; this.decoder = null; this.ts = 0; this.frames = 0; this.sps = null;
  }

  reset() {
    this.buf = new Uint8Array(0); this.prefix = []; this.ts = 0; this.sps = null;
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (_) { /* ya cerrado */ } }
    this.decoder = null;
  }

  push(chunk) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const m = new Uint8Array(this.buf.length + c.length); m.set(this.buf); m.set(c, this.buf.length); this.buf = m;
    const starts = [];
    for (let i = 0; i + 3 < this.buf.length; i++) {
      if (this.buf[i] === 0 && this.buf[i + 1] === 0 && (this.buf[i + 2] === 1 || (this.buf[i + 2] === 0 && this.buf[i + 3] === 1))) {
        starts.push(i); i += this.buf[i + 2] === 1 ? 2 : 3;
      }
    }
    for (let k = 0; k + 1 < starts.length; k++) this._nal(this.buf.subarray(starts[k], starts[k + 1]));
    if (starts.length) this.buf = this.buf.slice(starts[starts.length - 1]);
  }

  _nal(nal) {
    const off = nal[2] === 1 ? 3 : 4;
    const type = nal[off] & 0x1f;
    if (type === 7) { this.sps = nal.slice(); this.prefix = [nal.slice()]; this._configure(nal[off + 1], nal[off + 2], nal[off + 3]); return; }
    if (type === 8) { this.prefix.push(nal.slice()); return; }
    if (type !== 1 && type !== 5) return;
    if (!this.decoder || this.decoder.state !== 'configured') return;
    let data = nal;
    if (type === 5 && this.prefix.length) {
      const len = this.prefix.reduce((a, p) => a + p.length, 0) + nal.length;
      data = new Uint8Array(len); let o = 0;
      for (const p of this.prefix) { data.set(p, o); o += p.length; }
      data.set(nal, o); this.prefix = [];
    }
    if (type === 1 && !this.hasKey) return;
    if (type === 5) this.hasKey = true;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: type === 5 ? 'key' : 'delta', timestamp: this.ts, data }));
      this.ts += 33333;
    } catch (_) { /* frame descartado */ }
  }

  _configure(p, c, l) {
    const hex = (n) => n.toString(16).padStart(2, '0');
    const codec = `avc1.${hex(p)}${hex(c)}${hex(l)}`;
    if (this.decoder && this.decoder.state === 'configured' && this.codec === codec) return;
    this.codec = codec; this.hasKey = false;
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (_) { /* ya cerrado */ } }
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.canvas.width !== frame.displayWidth) { this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight; }
        this.ctx.drawImage(frame, 0, 0); frame.close(); this.frames++;
      },
      error: () => { /* se reconfigura con el siguiente SPS */ },
    });
    this.decoder.configure({ codec, optimizeForLatency: true });
  }
}
window.LiveH264 = LiveH264;
