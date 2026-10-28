'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

/** Localiza el binario adb: ruta configurada > SAFE_ADB > platform-tools incluido > PATH. */
function resolveAdb(custom) {
  const candidates = [custom, process.env.SAFE_ADB];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'platform-tools', EXE));
  candidates.push(path.join(__dirname, '..', '..', 'platform-tools', EXE));
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'adb';
}

class Adb {
  constructor({ adbPath } = {}) {
    this.bin = resolveAdb(adbPath);
  }

  run(args, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          const e = new Error(err.code === 'ENOENT' ? 'No se encontró ADB. Instale Android platform-tools o configure su ruta.' : (stderr || err.message).trim());
          e.code = err.code;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  /** Ejecuta un comando y devuelve stdout como Buffer (para exec-out binario). */
  runBinary(args, { timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, args);
      const chunks = [];
      let err = '';
      const t = setTimeout(() => { p.kill(); reject(new Error('Tiempo de espera agotado')); }, timeout);
      p.stdout.on('data', (d) => chunks.push(d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error('No se encontró ADB.') : e); });
      p.on('close', (code) => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(err.trim() || `adb salió con código ${code}`));
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async version() {
    const { stdout } = await this.run(['version'], { timeout: 8000 });
    return stdout.split('\n')[0].trim();
  }

  async devices() {
    const { stdout } = await this.run(['devices', '-l'], { timeout: 10000 });
    return parseDevices(stdout);
  }

  async shell(serial, cmd, opts) {
    const { stdout } = await this.run(['-s', serial, 'shell', cmd], opts);
    return stdout;
  }

  /** Metadatos del dispositivo de origen. */
  async deviceInfo(serial) {
    const props = parseGetprop(await this.shell(serial, 'getprop'));
    let androidId = '';
    try { androidId = (await this.shell(serial, 'settings get secure android_id')).trim(); } catch (_) { /* opcional */ }
    return {
      serial,
      manufacturer: props['ro.product.manufacturer'] || '',
      brand: props['ro.product.brand'] || '',
      model: props['ro.product.model'] || '',
      device: props['ro.product.device'] || '',
      androidVersion: props['ro.build.version.release'] || '',
      sdk: props['ro.build.version.sdk'] || '',
      securityPatch: props['ro.build.version.security_patch'] || '',
      buildId: props['ro.build.display.id'] || '',
      fingerprint: props['ro.build.fingerprint'] || '',
      bootSerial: props['ro.boot.serialno'] || props['ro.serialno'] || '',
      androidId,
      capturedAt: new Date().toISOString(),
    };
  }

  /** Aplicación en primer plano según el gestor de ventanas (mCurrentFocus). */
  async foreground(serial) {
    const out = await this.shell(serial, 'dumpsys window', { timeout: 15000 });
    return parseForeground(out);
  }

  screencap(serial) {
    return this.runBinary(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30000 });
  }

  /** Lanza `adb backup`. Devuelve el proceso hijo. */
  backupProcess(serial, file, { apk = true, obb = false, shared = true, system = false, all = true, packages = [] } = {}) {
    const args = ['-s', serial, 'backup', '-f', file];
    args.push(apk ? '-apk' : '-noapk');
    args.push(obb ? '-obb' : '-noobb');
    args.push(shared ? '-shared' : '-noshared');
    if (all) args.push('-all');
    args.push(system ? '-system' : '-nosystem');
    args.push(...packages);
    return spawn(this.bin, args);
  }

  /** `screenrecord` en flujo H.264 crudo por stdout (límite de 180 s impuesto por Android). */
  screenrecordProcess(serial, { bitRate = 8000000, size } = {}) {
    const args = ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--time-limit', '180', '--bit-rate', String(bitRate)];
    if (size) args.push('--size', size);
    args.push('-');
    return spawn(this.bin, args);
  }

  /** `adb pull -a` (conserva marcas de tiempo). */
  pull(serial, remote, localDir) {
    return this.run(['-s', serial, 'pull', '-a', remote, localDir], { timeout: 6 * 3600 * 1000 });
  }

  push(serial, local, remote) { return this.run(['-s', serial, 'push', local, remote], { timeout: 60000 }); }

  /** Reenvío a un socket del dispositivo; devuelve el puerto local asignado. */
  async forward(serial, remoteSpec) {
    const { stdout } = await this.run(['-s', serial, 'forward', 'tcp:0', remoteSpec], { timeout: 10000 });
    const port = parseInt(stdout.trim(), 10);
    if (!port) throw new Error('adb forward no devolvió un puerto');
    return port;
  }
  forwardRemove(serial, spec) { return this.run(['-s', serial, 'forward', '--remove', spec], { timeout: 10000 }); }

  /** Lanza `adb shell <args…>` como proceso hijo (para el servidor scrcpy). */
  spawnShell(serial, args) { return spawn(this.bin, ['-s', serial, 'shell', ...args]); }

  /** Lista un directorio del dispositivo. */
  async listDir(serial, dir) {
    const { stdout } = await this.run(['-s', serial, 'shell', `ls -lA ${shq(dir)}`], { timeout: 30000 });
    return parseLs(stdout);
  }

  /** Rutas de todos los ficheros bajo un directorio (o la propia ruta si es un fichero). */
  async expand(serial, remote, { limit = 5000 } = {}) {
    const out = await this.shell(serial, `if [ -d ${shq(remote)} ]; then find ${shq(remote)} -type f; elif [ -f ${shq(remote)} ]; then echo ${shq(remote)}; fi`, { timeout: 120000 });
    const list = out.split(/\r?\n/).filter(Boolean);
    if (list.length > limit) throw new Error(`La selección contiene ${list.length} ficheros (máx. ${limit}). Acote la carpeta.`);
    return list;
  }

  async stat(serial, remote) {
    const out = await this.shell(serial, `stat -c '%s %Y' ${shq(remote)}`);
    const [size, mtime] = out.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(size)) throw new Error(`No se pudo leer ${remote}`);
    return { size, mtime: new Date(mtime * 1000).toISOString() };
  }

  /** SHA-256 calculado EN el dispositivo (sha256sum / toybox / busybox). */
  async sha256Remote(serial, remote) {
    const cands = this._shaCmd ? [this._shaCmd] : ['sha256sum', 'toybox sha256sum', 'busybox sha256sum'];
    let lastErr;
    for (const c of cands) {
      try {
        const out = await this.shell(serial, `${c} ${shq(remote)}`, { timeout: 3 * 3600 * 1000 });
        const m = out.match(/^([0-9a-f]{64})\s/m);
        if (m) { this._shaCmd = c; return m[1]; }
      } catch (e) { lastErr = e; if (/Permission denied|No such file/i.test(e.message)) throw e; }
    }
    throw new Error('El dispositivo no dispone de sha256sum' + (lastErr ? `: ${lastErr.message}` : ''));
  }
}

/** Entrecomilla para el shell del dispositivo. */
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** Interpreta la salida de `ls -lA` (toybox/toolbox). */
function parseLs(text) {
  const re = /^([\-dlcbsp][rwxsStT\-]{9}[.+]?)\s+(?:(\d+)\s+)?(\S+)\s+(\S+)\s+(\d+(?:,\s*\d+)?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2})?\s+(.+)$/;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    let name = m[8]; let target = null;
    if (m[1][0] === 'l' && name.includes(' -> ')) { [name, target] = name.split(' -> '); }
    out.push({ name, type: m[1][0] === 'd' ? 'dir' : m[1][0] === 'l' ? 'link' : m[1][0] === '-' ? 'file' : 'other', perms: m[1], owner: m[3], group: m[4], size: parseInt(m[5], 10) || 0, mtime: `${m[6]} ${m[7]}`, target });
  }
  return out.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
}

function parseDevices(text) {
  return text.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const meta = {};
    rest.forEach((kv) => { const i = kv.indexOf(':'); if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1); });
    return { serial, state, model: meta.model || '', product: meta.product || '', transport: meta.transport_id || '' };
  }).filter((d) => d.serial && !d.serial.startsWith('*'));
}

function parseGetprop(text) {
  const props = {};
  for (const m of text.matchAll(/^\[([^\]]+)\]: \[(.*)\]\s*$/gm)) props[m[1]] = m[2];
  return props;
}

/** Extrae paquete/actividad de `dumpsys window` (mCurrentFocus, con mFocusedApp como respaldo). */
function parseForeground(text) {
  const focus = text.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^\s}]+)\}/);
  const app = text.match(/mFocusedApp=.*?ActivityRecord\{[^ ]+ [^ ]+ ([^\s}]+)/);
  const raw = (focus && focus[1]) || (app && app[1]) || '';
  const component = raw.replace(/ .*/, '');
  if (!component) return { package: '', activity: '', component: '', source: 'none' };
  const [pkg, act = ''] = component.split('/');
  return { package: pkg, activity: act.startsWith('.') ? pkg + act : act, component, source: focus ? 'mCurrentFocus' : 'mFocusedApp' };
}

module.exports = { Adb, resolveAdb, parseDevices, parseGetprop, parseForeground, parseLs, shq };
