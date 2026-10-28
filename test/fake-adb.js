#!/usr/bin/env node
// ADB simulado para pruebas automáticas.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let a = process.argv.slice(2);
if (a[0] === '-s') a = a.slice(2);
const PNG = fs.readFileSync(path.join(__dirname, 'thumb.png'));
const FILES = { '/sdcard/DCIM/Camera/IMG_2041.jpg': PNG, '/sdcard/DCIM/Camera/VID_0007.mp4': Buffer.from('mp4data-2'), '/sdcard/My Docs/it\'s.txt': Buffer.from('hola') };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const shArg = (cmd) => { const all = [...cmd.matchAll(/'((?:[^']|'\\'')*)'/g)]; const m = all[all.length - 1]; return m ? m[1].replace(/'\\''/g, "'") : ''; };

if (a[0] === 'version') console.log('Android Debug Bridge version 1.0.41 (fake)');
else if (a[0] === 'devices') console.log('List of devices attached\nFAKE123\tdevice product:fake model:Pixel_Fake transport_id:1');
else if (a[0] === 'push') { /* ok */ }
else if (a[0] === 'forward' && a[1] === '--remove') { /* ok */ }
else if (a[0] === 'forward') console.log(process.env.FAKE_SCRCPY_PORT || '0');
else if (a[0] === 'shell' && /^CLASSPATH=/.test(a[1])) setInterval(() => {}, 1000); // servidor scrcpy: vive hasta que lo maten
else if (a[0] === 'shell' && a[1] === 'getprop') console.log('[ro.product.model]: [Pixel Fake]\n[ro.product.manufacturer]: [Acme]\n[ro.build.version.release]: [14]\n[ro.build.version.sdk]: [34]\n[ro.build.fingerprint]: [acme/fake/fake:14/X/1:user/release-keys]');
else if (a[0] === 'shell' && /^settings/.test(a[1])) console.log('abcdef0123456789');
else if (a[0] === 'shell' && /^dumpsys window/.test(a[1])) console.log('  mCurrentFocus=Window{4f2a1 u0 com.whatsapp/com.whatsapp.HomeActivity}\n  mFocusedApp=ActivityRecord{1 u0 com.whatsapp/.HomeActivity t5}');
else if (a[0] === 'shell' && /^ls -lA/.test(a[1])) {
  const d = shArg(a[1]).replace(/\/+$/, '');
  console.log('total 8');
  if (d === '/sdcard') console.log('drwxrwx--x 3 root sdcard_rw 3452 2026-01-01 10:00 DCIM\ndrwxrwx--x 3 root sdcard_rw 3452 2026-01-01 10:00 My Docs');
  else if (d === '/sdcard/DCIM') console.log('drwxrwx--x 2 root sdcard_rw 3452 2026-01-01 10:00 Camera');
  else if (d === '/sdcard/DCIM/Camera') console.log(`-rw-rw---- 1 u0_a1 media_rw ${PNG.length} 2026-02-10 14:22 IMG_2041.jpg\n-rw-rw---- 1 u0_a1 media_rw 9 2026-02-10 14:23 VID_0007.mp4`);
  else { console.error(`ls: ${d}: Permission denied`); process.exit(1); }
} else if (a[0] === 'shell' && /^if \[ -d/.test(a[1])) {
  const d = shArg(a[1]);
  const hits = Object.keys(FILES).filter((f) => f === d || f.startsWith(d.replace(/\/+$/, '') + '/'));
  console.log(hits.join('\n'));
} else if (a[0] === 'shell' && /^stat -c/.test(a[1])) { const f = FILES[shArg(a[1])]; if (!f) { console.error('stat: No such file'); process.exit(1); } console.log(`${f.length} 1770733320`); }
else if (a[0] === 'shell' && /^sha256sum/.test(a[1])) { const p = shArg(a[1]); const f = FILES[p]; if (!f) { console.error('No such file'); process.exit(1); } console.log(`${sha(f)}  ${p}`); }
else if (a[0] === 'shell' && a[1] === 'wm size') console.log('Physical size: 1080x2400');
else if (a[0] === 'exec-out' && a[1] === 'screenrecord') {
  const nal = (t, n) => Buffer.concat([Buffer.from([0, 0, 0, 1, t]), Buffer.alloc(n, t)]);
  process.stdout.write(Buffer.concat([nal(0x67, 6), nal(0x68, 3), nal(0x65, 40)]));
  let i = 0; const t = setInterval(() => { process.stdout.write(nal(0x41, 15)); if (++i >= 6) { clearInterval(t); process.exit(0); } }, 40);
}
else if (a[0] === 'exec-out' && a[1] === 'screencap') process.stdout.write(PNG);
else if (a[0] === 'backup') { const f = a[a.indexOf('-f') + 1]; fs.writeFileSync(f, Buffer.concat([Buffer.from('ANDROID BACKUP\n5\n1\nnone\n'), Buffer.alloc(8192, 1)])); }
else if (a[0] === 'pull') {
  const dest = a[a.length - 1]; const remote = a[a.length - 2];
  let data = FILES[remote];
  if (!data) { console.error('adb: error: remote object does not exist'); process.exit(1); }
  if (process.env.FAKE_CORRUPT_ONCE && !fs.existsSync(process.env.FAKE_CORRUPT_ONCE)) { fs.writeFileSync(process.env.FAKE_CORRUPT_ONCE, '1'); data = Buffer.concat([data, Buffer.from('X')]); }
  fs.writeFileSync(path.join(dest, path.basename(remote)), data);
} else { console.error('fake adb: comando no soportado ' + a.join(' ')); process.exit(1); }
