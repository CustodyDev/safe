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

module.exports = { Adb, resolveAdb, parseDevices, parseGetprop, parseForeground };
