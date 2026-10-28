'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { safeName } = require('./casestore');
const { sha256File } = require('./hash');
const { ScrcpySession, VERSION, ACTION, msgTouch, msgKey, msgText, msgScroll } = require('./scrcpy');

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

/** Adquisiciones contra el dispositivo. ctx = {adb, store, mgr, emit(channel, data)} */
class Acquirer {
  constructor(ctx) {
    this.ctx = ctx;
    this.backup = null;
    this.live = null;
    this.hashCache = new Map();
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

  // ---------- pantalla en vivo, control y grabación en un único archivo ----------

  async startLive(serial, { maxSize = 0, control = true } = {}) {
    const { adb, store, emit } = this.ctx;
    if (this.live) throw new Error('Ya hay una sesión en vivo');
    const session = new ScrcpySession(adb, serial, { maxSize, control });
    const live = { session, serial, control, inputs: 0, rec: null };
    this.live = live;
    session.on('ready', (r) => { store.log('live.start', { serial, control, maxSize, scrcpyVersion: VERSION, serverSha256: r.jarSha256 }); emit('live:ready', r); });
    session.on('packet', (p) => { emit('live:packet', p); if (live.rec) this._recPacket(live, p); });
    session.on('close', () => {
      if (this.live !== live) return;
      if (live.rec) this.stopRecording().catch((e) => emit('error', { message: e.message }));
      this.live = null;
      store.log('live.stop', { inputs: live.inputs });
      emit('live:closed', {});
    });
    try { await session.start(); } catch (e) { this.live = null; throw e; }
  }

  stopLive() { if (this.live) return this.live.session.stop(); return undefined; }

  /** Entrada del usuario sobre la pantalla en vivo (táctil, teclas, texto, scroll). */
  control(msg) {
    const l = this.live;
    if (!l || !l.control) return;
    const { w, h } = l.session.size;
    if (msg.t === 'touch') { l.session.send(msgTouch(msg.action, msg.x, msg.y, msg.w || w, msg.h || h)); if (msg.action === ACTION.DOWN) l.inputs++; }
    else if (msg.t === 'key') { l.session.send(msgKey(0, msg.code)); l.session.send(msgKey(1, msg.code)); l.inputs++; }
    else if (msg.t === 'keyframe') l.session.requestKeyframe();
    else if (msg.t === 'text') { l.session.send(msgText(msg.text)); l.inputs++; }
    else if (msg.t === 'scroll') { l.session.send(msgScroll(msg.x, msg.y, msg.w || w, msg.h || h, msg.dx || 0, msg.dy || 0)); l.inputs++; }
  }

  async startRecording(preflightInfo) {
    const { adb, store, emit } = this.ctx;
    const l = this.live;
    if (!l) throw new Error('Conecte primero la pantalla en vivo');
    if (l.rec) throw new Error('Ya hay una grabación en curso');
    const { device, foreground } = await this._meta(l.serial);
    const file = path.join(store.stagingDir(), `grabacion_${stamp()}.h264`);
    const rec = { file, out: fs.createWriteStream(file), device, preflight: preflightInfo, started: false, frames: 0, firstPts: null, lastPts: 0, startedAt: new Date().toISOString(), timeline: [], size: { ...l.session.size } };
    if (foreground) rec.timeline.push({ ts: rec.startedAt, component: foreground.component });
    rec.lastForeground = foreground;
    rec.poller = setInterval(async () => {
      if (rec.polling) return;
      rec.polling = true;
      try {
        const fg = await adb.foreground(l.serial);
        const last = rec.timeline[rec.timeline.length - 1];
        if (!last || last.component !== fg.component) rec.timeline.push({ ts: new Date().toISOString(), component: fg.component });
        rec.lastForeground = fg;
      } catch (_) { /* sin foco momentáneo */ } finally { rec.polling = false; }
    }, 3000);
    l.rec = rec;
    store.log('record.start', { serial: l.serial, file: path.basename(file) });
    if (l.session.lastConfig) rec.out.write(l.session.lastConfig); // SPS/PPS al inicio del archivo
    l.session.requestKeyframe();
    emit('recording', { active: true });
  }

  _recPacket(live, p) {
    const rec = live.rec;
    if (p.config) { rec.out.write(p.data); return; }
    if (!rec.started) { if (!p.key) return; rec.started = true; rec.size = { ...live.session.size }; }
    if (rec.firstPts === null) rec.firstPts = p.ptsUs;
    rec.lastPts = p.ptsUs; rec.frames++;
    rec.out.write(p.data);
  }

  async stopRecording() {
    const { store, mgr, emit } = this.ctx;
    const l = this.live;
    if (!l || !l.rec) return null;
    const rec = l.rec; l.rec = null;
    clearInterval(rec.poller);
    await new Promise((res) => rec.out.end(res));
    emit('recording', { active: false, finalizing: true });
    const durationSec = rec.frames > 1 ? (rec.lastPts - rec.firstPts) / 1e6 : 0;
    store.log('record.stop', { frames: rec.frames, durationSec });
    let result = null;
    if (rec.frames > 0) {
      result = await mgr.register({
        srcFile: rec.file, type: 'video', device: rec.device, foreground: rec.lastForeground, preflight: rec.preflight, timeline: rec.timeline,
        sourcePath: 'scrcpy · flujo H.264 sin recodificar', recording: { durationSec, frames: rec.frames, fps: durationSec ? rec.frames / durationSec : 0, resolution: `${rec.size.w}×${rec.size.h}` },
      });
      emit('evidence', result);
      await this._mux(result, durationSec ? rec.frames / durationSec : 30);
    } else if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    emit('recording', { active: false });
    return result;
  }

  /** Copia derivada MP4 si hay ffmpeg (el original sigue siendo el .h264). */
  _mux(rec, fps) {
    const { store, mgr, emit } = this.ctx;
    return new Promise((resolve) => {
      const src = path.join(store.dir, rec.relPath);
      const dst = path.join(store.stagingDir(), rec.fileName.replace(/\.h264$/, '.mp4'));
      const ff = spawn(process.env.SAFE_FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-r', fps.toFixed(3), '-f', 'h264', '-i', src, '-c', 'copy', dst]);
      ff.on('error', () => resolve());
      ff.on('close', async (code) => {
        if (code === 0 && fs.existsSync(dst)) {
          try { emit('evidence', await mgr.register({ srcFile: dst, type: 'derived', device: rec.device, parent: rec.id, preflight: rec.preflight, sourcePath: `Derivado de ${rec.id} (copia de visualización)` })); } catch (_) { /* opcional */ }
        }
        resolve();
      });
    });
  }

  // ---------- explorador de archivos del dispositivo ----------

  listDir(serial, dir) { return this.ctx.adb.listDir(serial, dir); }

  /** Calcula el SHA-256 EN el dispositivo de cada ruta (expande carpetas). No extrae nada. */
  async hashRemote(serial, paths) {
    const { adb, store, emit } = this.ctx;
    const files = [];
    for (const p of paths) files.push(...await adb.expand(serial, p));
    const out = [];
    for (const [i, f] of files.entries()) {
      emit('progress', { kind: 'fs', message: `SHA-256 en dispositivo ${i + 1}/${files.length}: ${path.basename(f)}` });
      try {
        const st = await adb.stat(serial, f);
        const sha256 = await adb.sha256Remote(serial, f);
        const item = { path: f, ...st, sha256, hashedAt: new Date().toISOString() };
        this.hashCache.set(serial + '\0' + f, item);
        out.push(item);
      } catch (e) { out.push({ path: f, error: e.message }); }
    }
    store.log('fs.hash', { serial, count: out.length, errors: out.filter((o) => o.error).length });
    return out;
  }

  /**
   * Extrae ficheros/carpetas. Para cada fichero: SHA-256 en el dispositivo (reutiliza el ya calculado si
   * tamaño y fecha no cambiaron) → adb pull → SHA-256 local → comparación. Conserva nombre y fecha.
   */
  async extractFiles(serial, paths, preflight) {
    const { adb, store, mgr, emit } = this.ctx;
    const { device } = await this._meta(serial);
    const files = [];
    for (const p of paths) files.push(...await adb.expand(serial, p));
    if (!files.length) throw new Error('No hay ficheros en la selección');
    store.log('pull.start', { serial, paths, count: files.length });
    const stage = store.stagingDir(`pull_${stamp()}`);
    const out = [];
    for (const [i, f] of files.entries()) {
      const name = path.basename(f);
      try {
        emit('progress', { kind: 'fs', message: `Verificando en origen ${i + 1}/${files.length}: ${name}` });
        const st = await adb.stat(serial, f);
        let h = this.hashCache.get(serial + '\0' + f);
        if (!h || h.size !== st.size || h.mtime !== st.mtime) {
          h = { path: f, ...st, sha256: await adb.sha256Remote(serial, f), hashedAt: new Date().toISOString() };
        }
        const dir = path.join(stage, String(i)); fs.mkdirSync(dir);
        const local = path.join(dir, name);
        let sha = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          emit('progress', { kind: 'fs', message: `Extrayendo ${i + 1}/${files.length}: ${name}` });
          await adb.pull(serial, f, dir);
          sha = await sha256File(local);
          if (sha === h.sha256) break;
          store.log('pull.retry', { path: f, deviceSha256: h.sha256, localSha256: sha });
          fs.unlinkSync(local);
        }
        if (!fs.existsSync(local)) await adb.pull(serial, f, dir); // tras 2 fallos conserva lo recibido para dejar constancia
        emit('progress', { kind: 'fs', message: `Sellando ${i + 1}/${files.length}: ${name}` });
        const rec = await mgr.register({ srcFile: local, fileName: name, type: 'media', device, preflight, sourcePath: f, mtime: st.mtime, deviceSha256: h.sha256, deviceHashedAt: h.hashedAt });
        out.push(rec); emit('evidence', rec);
      } catch (e) {
        store.log('pull.error', { path: f, error: e.message });
        out.push({ path: f, error: e.message });
        emit('error', { message: `${name}: ${e.message}` });
      }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    store.log('pull.done', { count: out.length, ok: out.filter((r) => !r.error).length });
    return out;
  }
}

module.exports = { Acquirer };
