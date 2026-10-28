'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { ZipArchive } = require('archiver');
const { sha256File } = require('./hash');
const ots = require('./ots');

function walk(dir, base = dir, skip = () => false) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name); const rel = path.relative(base, p).split(path.sep).join('/');
    if (skip(rel)) return [];
    return e.isDirectory() ? walk(p, base, skip) : [{ rel, abs: p }];
  });
}

/** Recorre el ZIP en streaming y devuelve {entrada: {size, sha256}}. */
function hashZipEntries(zipFile) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const h = crypto.createHash('sha256'); let size = 0;
          stream.on('data', (d) => { h.update(d); size += d.length; });
          stream.on('error', reject); // incluye fallos de CRC/tamaño
          stream.on('end', () => { out[entry.fileName] = { size, sha256: h.digest('hex') }; zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

function zipCase(zipFile, caseDir, rootName, skip) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipFile);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', resolve); zip.on('error', reject); out.on('error', reject);
    zip.pipe(out);
    for (const f of walk(caseDir, caseDir, skip)) zip.file(f.abs, { name: `${rootName}/${f.rel}` });
    zip.finalize();
  });
}

/**
 * Cierre del caso: verificación de integridad → manifiesto → ZIP completo → hash y sello del ZIP →
 * validación final releyendo el ZIP y contrastándolo con el manifiesto y con los hashes de cada evidencia.
 */
async function finalizeCase(store, mgr, { preflight, stampFn = ots.stampHash, onProgress = () => {} } = {}) {
  const info = store.info();
  const startedAt = new Date().toISOString();
  const tag = startedAt.replace(/[-:]/g, '').replace(/\..*/, '');
  const checks = [];
  const add = (name, ok, detail, warn = false) => { checks.push({ name, ok, detail, warn }); };
  store.log('finalize.start', { caseId: info.caseId });

  onProgress('Verificando integridad de las evidencias…');
  const integrity = await mgr.verifyIntegrity();
  const bad = integrity.filter((i) => !i.ok);
  add('Integridad de evidencias (SHA-256 recalculado)', bad.length === 0, bad.length ? `Fallan: ${bad.map((b) => b.id).join(', ')}` : `${integrity.length} evidencia(s) íntegras`);
  const lg = store.verifyLog();
  add('Cadena de custodia (hash encadenado)', lg.ok, lg.ok ? `${lg.entries} entradas` : `Rota en #${lg.brokenAt}`);
  const noOts = store.list().filter((e) => !e.ots.file).map((e) => e.id);
  add('Sellos OpenTimestamps presentes', noOts.length === 0, noOts.length ? `Sin sellar: ${noOts.join(', ')} (sellar después desde Evidencias)` : 'Todas las evidencias tienen .ots', true);

  fs.rmSync(path.join(store.dir, 'staging'), { recursive: true, force: true });
  const skip = (rel) => rel === 'staging' || rel.startsWith('staging/');

  onProgress('Generando manifiesto…');
  const files = [];
  for (const f of walk(store.dir, store.dir, (r) => skip(r) || r === 'MANIFEST.json' || r === 'MANIFEST.sha256')) {
    files.push({ path: f.rel, size: fs.statSync(f.abs).size, sha256: await sha256File(f.abs) });
  }
  fs.writeFileSync(path.join(store.dir, 'MANIFEST.json'), JSON.stringify({ caseId: info.caseId, createdAt: startedAt, files }, null, 2));
  fs.writeFileSync(path.join(store.dir, 'MANIFEST.sha256'), files.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n');

  const zipFile = path.join(path.dirname(store.dir), `${path.basename(store.dir)}_FINAL_${tag}.zip`);
  onProgress('Comprimiendo el caso completo…');
  await zipCase(zipFile, store.dir, path.basename(store.dir), skip);
  const zipSha = await sha256File(zipFile);
  fs.writeFileSync(zipFile + '.sha256', `${zipSha}  ${path.basename(zipFile)}\n`);

  let otsStatus = 'not-stamped';
  const canStamp = !preflight || (preflight.online && preflight.timestampService.available);
  if (canStamp) {
    onProgress('Sellando el paquete final en OpenTimestamps…');
    try { fs.writeFileSync(zipFile + '.ots', await stampFn(zipSha)); otsStatus = 'pending'; } catch (e) { otsStatus = 'error: ' + e.message; }
  }

  add('Sello OpenTimestamps del paquete ZIP', otsStatus === 'pending', otsStatus === 'pending' ? 'Enviado a los calendarios (pendiente de Bitcoin)' : 'No sellado (sin conexión o servicio no disponible)', true);

  onProgress('Validación final: releyendo el ZIP…');
  let entries; let zipErr = null;
  try { entries = await hashZipEntries(zipFile); } catch (e) { zipErr = e.message; entries = {}; }
  add('ZIP legible y sin corrupción (CRC)', !zipErr, zipErr || `${Object.keys(entries).length} archivos`);
  const root = path.basename(store.dir);
  const mismatched = []; const missing = [];
  for (const f of files) {
    const e = entries[`${root}/${f.path}`];
    if (!e) missing.push(f.path); else if (e.sha256 !== f.sha256 || e.size !== f.size) mismatched.push(f.path);
  }
  const extra = Object.keys(entries).filter((n) => !files.some((f) => `${root}/${f.path}` === n) && !n.endsWith('/MANIFEST.json') && !n.endsWith('/MANIFEST.sha256'));
  add('Contenido del ZIP = manifiesto (hash por archivo)', !zipErr && !mismatched.length && !missing.length && !extra.length,
    mismatched.length || missing.length || extra.length ? `Distintos: ${mismatched.length}, faltan: ${missing.length}, sobran: ${extra.length}` : `${files.length} archivos coinciden`);
  const evBad = store.list().filter((rec) => { const e = entries[`${root}/${rec.relPath.split(path.sep).join('/')}`]; return !e || e.sha256 !== rec.sha256; });
  add('Originales dentro del ZIP = hash registrado de cada evidencia', !zipErr && evBad.length === 0, evBad.length ? `No coinciden: ${evBad.map((r) => r.id).join(', ')}` : `${store.list().length} evidencia(s)`);
  const zipSha2 = await sha256File(zipFile);
  add('Hash del ZIP estable tras releerlo', zipSha2 === zipSha, zipSha);

  const status = checks.some((c) => !c.ok && !c.warn) ? 'FALLO' : checks.some((c) => !c.ok) ? 'OK_CON_AVISOS' : 'OK';
  const result = { caseId: info.caseId, status, startedAt, finishedAt: new Date().toISOString(), zipFile, zipSize: fs.statSync(zipFile).size, zipSha256: zipSha, zipOts: otsStatus, files: files.length, evidences: store.list().length, checks };
  fs.writeFileSync(zipFile + '.verificacion.json', JSON.stringify(result, null, 2));
  store.log('finalize.done', { status: result.status, zip: path.basename(zipFile), zipSha256: zipSha, zipOts: otsStatus, failed: checks.filter((c) => !c.ok).map((c) => c.name) });
  return result;
}

module.exports = { finalizeCase, hashZipEntries };
