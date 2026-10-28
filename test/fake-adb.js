#!/usr/bin/env node
// ADB simulado para pruebas automáticas.
const fs = require('fs');
const path = require('path');
let a = process.argv.slice(2);
if (a[0] === '-s') a = a.slice(2);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
if (a[0] === 'version') console.log('Android Debug Bridge version 1.0.41 (fake)');
else if (a[0] === 'devices') console.log('List of devices attached\nFAKE123\tdevice product:fake model:Pixel_Fake transport_id:1');
else if (a[0] === 'shell' && a[1] === 'getprop') console.log('[ro.product.model]: [Pixel Fake]\n[ro.product.manufacturer]: [Acme]\n[ro.build.version.release]: [14]\n[ro.build.version.sdk]: [34]\n[ro.build.fingerprint]: [acme/fake/fake:14/X/1:user/release-keys]');
else if (a[0] === 'shell' && /^settings/.test(a[1])) console.log('abcdef0123456789');
else if (a[0] === 'shell' && /^dumpsys window/.test(a[1])) console.log('  mCurrentFocus=Window{4f2a1 u0 com.whatsapp/com.whatsapp.HomeActivity}\n  mFocusedApp=ActivityRecord{1 u0 com.whatsapp/.HomeActivity t5}');
else if (a[0] === 'exec-out' && a[1] === 'screencap') process.stdout.write(PNG);
else if (a[0] === 'exec-out' && a[1] === 'screenrecord') { process.stdout.write(Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]), Buffer.alloc(2000, 7)])); setTimeout(() => process.exit(0), 150); }
else if (a[0] === 'backup') { const f = a[a.indexOf('-f') + 1]; fs.writeFileSync(f, Buffer.concat([Buffer.from('ANDROID BACKUP\n5\n1\nnone\n'), Buffer.alloc(8192, 1)])); }
else if (a[0] === 'pull') {
  const dest = a[a.length - 1]; const remote = a[a.length - 2];
  const dir = path.join(dest, path.basename(remote)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IMG_2041.jpg'), fs.readFileSync(path.join(__dirname, 'thumb.png')));
  fs.writeFileSync(path.join(dir, 'VID_0007.mp4'), Buffer.from('mp4data-2'));
} else { console.error('fake adb: comando no soportado ' + a.join(' ')); process.exit(1); }
