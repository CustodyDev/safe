'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { safeName } = require('./casestore');

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** Adquisiciones contra el dispositivo. ctx = {adb, store, mgr, emit(channel, data)} */
class Acquirer {
  constructor(ctx) {
    this.ctx = ctx;
    this.backup = null;
    this.rec = null;
  }

  async _meta(serial) {
    const device = await this.ctx.adb.deviceInfo(serial);
    let foreground = null;
    try { foreground = await this.ctx.adb.foreground(serial); } catch (_) { /* opcional */ }
    return { device, foreground };
  }

  async screenshot(serial, preflight) {
    const { adb, store, mgr } = this.ctx;
    const { device, foreground } = await this._meta(serial);
    const png = await adb.screencap(serial);
    if (png.length < 8 || png[0] !== 0x89) throw new Error('La captura recibida no es un PNG válido');
    const tmp = path.join(store.stagingDir(), `captura_${stamp()}.png`);
    fs.writeFileSync(tmp, png);
    return mgr.register({ srcFile: tmp, type: 'screenshot', device, foreground, preflight, sourcePath: 'screencap (pantalla completa)' });
  }

  async startBackup(serial, options, preflight) {
    const { adb, store, mgr, emit } = this.ctx;
    if (this.backup) throw new Error('Ya hay una copia de seguridad en curso');
    const { device } = await this._meta(serial);
    const tmp = path.join(store.stagingDir(), `backup_${safeName(device.model || serial).replace(/\s+/g, '_')}_${stamp()}.ab`);
    const child = adb.backupProcess(serial, tmp, options);
    this.backup = { child, cancelled: false };
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    store.log('backup.start', { serial, options, file: path.basename(tmp) });
    const timer = setInterval(() => {
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      emit('progress', { kind: 'backup', bytes: size, message: size ? 'Recibiendo datos…' : 'Esperando confirmación en el dispositivo…' });
    }, 1000);

    return new Promise((resolve, reject) => {
      child.on('error', (e) => { clearInterval(timer); this.backup = null; reject(e); });
      child.on('close', async (code) => {
        clearInterval(timer);
        const cancelled = this.backup && this.backup.cancelled;
        this.backup = null;
        const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
        if (cancelled) { store.log('backup.cancel', {}); return reject(new Error('Copia cancelada')); }
        if (code !== 0 || size < 2048) {
          store.log('backup.fail', { code, size, err: err.trim() });
          return reject(new Error(err.trim() || 'La copia está vacía: confirme la operación en la pantalla del dispositivo (sin contraseña) o el sistema podría no permitir backup (Android 12+ restringe `adb backup`).'));
        }
        try { resolve(await mgr.register({ srcFile: tmp, type: 'backup', device, preflight, sourcePath: `adb backup ${JSON.stringify(options)}` })); } catch (e) { reject(e); }
      });
    });
  }

  cancelBackup() { if (this.backup) { this.backup.cancelled = true; this.backup.child.kill(); } }

  /** Graba la pantalla en segmentos de ≤180 s, emitiendo el flujo H.264 para la vista en vivo. */
  async startRecording(serial, preflight, { bitRate } = {}) {
    const { adb, store, emit } = this.ctx;
    if (this.rec) throw new Error('Ya hay una grabación en curso');
    const { device, foreground } = await this._meta(serial);
    const r = { serial, device, preflight, stopping: false, seg: 0, done: [], timeline: [], child: null, poller: null, bitRate };
    this.rec = r;
    if (foreground) r.timeline.push({ ts: new Date().toISOString(), component: foreground.component });
    r.poller = setInterval(async () => {
      if (r.polling) return;
      r.polling = true;
      try {
        const fg = await adb.foreground(serial);
        const last = r.timeline[r.timeline.length - 1];
        if (!last || last.component !== fg.component) r.timeline.push({ ts: new Date().toISOString(), component: fg.component });
        r.lastForeground = fg;
      } catch (_) { /* sin foco momentáneo */ } finally { r.polling = false; }
    }, 3000);
    store.log('record.start', { serial });
    this._segment(r);
    emit('recording', { active: true, segment: 1 });
  }

  _segment(r) {
    const { adb, store, mgr, emit } = this.ctx;
    r.seg += 1;
    const file = path.join(store.stagingDir(), `grabacion_${stamp()}_seg${String(r.seg).padStart(2, '0')}.h264`);
    const out = fs.createWriteStream(file);
    const child = adb.screenrecordProcess(r.serial, { bitRate: r.bitRate });
    r.child = child;
    const startedAt = new Date().toISOString();
    child.stdout.on('data', (d) => { out.write(d); emit('rec:chunk', d); });
    child.stdout.on('end', () => emit('rec:chunk-end', { segment: r.seg }));
    child.on('error', (e) => emit('error', { message: e.message }));
    child.on('close', async () => {
      out.end();
      await new Promise((res) => out.on('finish', res));
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const timeline = r.timeline.filter((t) => t.ts >= startedAt || t === r.timeline[0]);
      if (!r.stopping) this._segment(r); // reanuda de inmediato tras el límite de 180 s
      if (size > 0) {
        try {
          const rec = await mgr.register({ srcFile: file, type: 'video', device: r.device, foreground: r.lastForeground, preflight: r.preflight, timeline, sourcePath: `screenrecord (segmento ${r.seg})` });
          r.done.push(rec);
          emit('evidence', rec);
          await this._mux(rec, r);
        } catch (e) { emit('error', { message: e.message }); }
      } else if (fs.existsSync(file)) fs.unlinkSync(file);
      if (r.stopping && r.child === child) { this._finishStop(r); }
    });
  }

  _finishStop(r) {
    if (this.rec !== r) return;
    this.rec = null;
    this.ctx.store.log('record.stop', { segments: r.done.map((d) => d.id) });
    this.ctx.emit('recording', { active: false, evidence: r.done.map((d) => d.id) });
  }

  /** Copia derivada MP4 si hay ffmpeg (el original sigue siendo el .h264). */
  _mux(rec) {
    const { store, mgr, emit } = this.ctx;
    return new Promise((resolve) => {
      const src = path.join(store.dir, rec.relPath);
      const dst = path.join(store.stagingDir(), rec.fileName.replace(/\.h264$/, '.mp4'));
      const ff = spawn(process.env.SAFE_FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-r', '30', '-f', 'h264', '-i', src, '-c', 'copy', dst]);
      ff.on('error', () => resolve());
      ff.on('close', async (code) => {
        if (code === 0 && fs.existsSync(dst)) {
          try { emit('evidence', await mgr.register({ srcFile: dst, type: 'derived', device: rec.device, parent: rec.id, preflight: rec.preflight, sourcePath: `Derivado de ${rec.id}` })); } catch (_) { /* opcional */ }
        }
        resolve();
      });
    });
  }

  stopRecording() {
    const r = this.rec;
    if (!r) return;
    r.stopping = true;
    clearInterval(r.poller);
    r.child.kill();
  }

  /** Extrae un fichero/carpeta del dispositivo conservando nombres y fechas. */
  async pullMedia(serial, remote, preflight) {
    const { adb, store, mgr, emit } = this.ctx;
    const { device } = await this._meta(serial);
    const stage = store.stagingDir(`pull_${stamp()}`);
    store.log('pull.start', { serial, remote });
    emit('progress', { kind: 'pull', message: `Extrayendo ${remote}…` });
    await adb.pull(serial, remote, stage);
    const files = walk(stage);
    if (!files.length) throw new Error('No se extrajo ningún archivo (¿ruta inexistente o sin permisos?)');
    const base = path.join(stage, path.basename(remote.replace(/\/+$/, '')));
    const out = [];
    for (const [i, f] of files.entries()) {
      const rel = path.relative(base, f);
      const sourcePath = (rel && !rel.startsWith('..') ? remote.replace(/\/+$/, '') + '/' + rel.split(path.sep).join('/') : remote);
      emit('progress', { kind: 'pull', message: `Sellando ${i + 1}/${files.length}: ${path.basename(f)}` });
      const rec = await mgr.register({ srcFile: f, fileName: path.basename(f), type: 'media', device, preflight, sourcePath, mtime: fs.statSync(f).mtime.toISOString() });
      out.push(rec);
      emit('evidence', rec);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    store.log('pull.done', { remote, count: out.length });
    return out;
  }
}

module.exports = { Acquirer };
