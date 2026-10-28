'use strict';
/**
 * Vídeo en vivo: decodifica los paquetes H.264 (Annex-B) de scrcpy con WebCodecs y los dibuja con
 * requestAnimationFrame (siempre el último fotograma → mínima latencia). Sin recodificar.
 */
class LiveVideo {
  constructor(canvas, { onNeedKey } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onNeedKey = onNeedKey || (() => {});
    this.decoder = null; this.config = null; this.latest = null; this.frames = 0; this.fps = 0; this._tick = performance.now(); this._n = 0;
    this._raf = () => { this._draw(); this.rafId = requestAnimationFrame(this._raf); };
    this.rafId = requestAnimationFrame(this._raf);
  }

  reset() {
    this.config = null; this.waitKey = true;
    if (this.latest) { this.latest.close(); this.latest = null; }
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (_) { /* cerrado */ } }
    this.decoder = null;
  }

  push(p) {
    const data = p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data);
    if (p.config) { this._configure(data); this.config = data; return; }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.waitKey && !p.key) return;
    if (this.decoder.decodeQueueSize > 6 && !p.key) { this.waitKey = true; this.onNeedKey(); return; } // se retrasa: descarta y pide fotograma clave
    let chunk = data;
    if (this.config) { // SPS/PPS en línea con el siguiente fotograma
      chunk = new Uint8Array(this.config.length + data.length); chunk.set(this.config); chunk.set(data, this.config.length); this.config = null;
    }
    if (p.key) this.waitKey = false;
    try { this.decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.ptsUs, data: chunk })); } catch (_) { this.waitKey = true; this.onNeedKey(); }
  }

  _configure(cfg) {
    let i = 0;
    while (i + 4 < cfg.length && !(cfg[i] === 0 && cfg[i + 1] === 0 && (cfg[i + 2] === 1 || (cfg[i + 2] === 0 && cfg[i + 3] === 1)) && (cfg[i + (cfg[i + 2] === 1 ? 3 : 4)] & 0x1f) === 7)) i++;
    const o = i + (cfg[i + 2] === 1 ? 3 : 4);
    const hex = (n) => n.toString(16).padStart(2, '0');
    const codec = `avc1.${hex(cfg[o + 1])}${hex(cfg[o + 2])}${hex(cfg[o + 3])}`;
    if (this.decoder && this.decoder.state === 'configured' && this.codec === codec) return;
    this.codec = codec; this.waitKey = true;
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (_) { /* cerrado */ } }
    this.decoder = new VideoDecoder({
      output: (frame) => { if (this.latest) this.latest.close(); this.latest = frame; },
      error: () => { this.waitKey = true; this.onNeedKey(); },
    });
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }

  _draw() {
    const f = this.latest; if (!f) return;
    this.latest = null;
    if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) { this.canvas.width = f.displayWidth; this.canvas.height = f.displayHeight; }
    this.ctx.drawImage(f, 0, 0); f.close();
    this.frames++; this._n++;
    const now = performance.now();
    if (now - this._tick >= 1000) { this.fps = Math.round((this._n * 1000) / (now - this._tick)); this._n = 0; this._tick = now; }
  }
}
window.LiveVideo = LiveVideo;
