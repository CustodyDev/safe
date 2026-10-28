'use strict';
const fs = require('fs');
const path = require('path');
const { sha256File } = require('./hash');
const ots = require('./ots');
const { generatePdf, zipPackage } = require('./report');
const { safeName } = require('./casestore');

const TYPE_LABEL = {
  backup: 'Copia de seguridad ADB',
  screenshot: 'Captura de pantalla',
  video: 'Grabación de pantalla (H.264)',
  media: 'Archivo multimedia / fichero extraído',
  web: 'Captura del navegador interno',
  webpage: 'Página web archivada (MHTML)',
  derived: 'Copia derivada para visualización',
};

/**
 * Orquesta el flujo de cada evidencia: hash SHA-256 del original → sellado OTS →
 * miniatura → informe PDF → paquete ZIP → registro de custodia.
 */
class EvidenceManager {
  constructor(store, { makeThumbnail, appVersion = '1.0.0', stampFn = ots.stampHash } = {}) {
    this.store = store;
    this.makeThumbnail = makeThumbnail;
    this.appVersion = appVersion;
    this.stampFn = stampFn;
  }

  /**
   * @param {object} p {srcFile, fileName, type, device, foreground, preflight, sourcePath, sourceUrl, timeline, mtime, parent}
   * El archivo se MUEVE a evidence/EV-xxxx/<nombre original> y se marca de solo lectura.
   */
  async register(p) {
    const id = this.store.nextId();
    const dir = this.store.evidenceDir(id);
    const fileName = safeName(p.fileName || path.basename(p.srcFile));
    const dest = path.join(dir, fileName);
    try { fs.renameSync(p.srcFile, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(p.srcFile, dest); fs.unlinkSync(p.srcFile);
    }
    const sha256 = await sha256File(dest);
    try { fs.chmodSync(dest, 0o444); } catch (_) { /* en algunos FS no aplica */ }
    const stat = fs.statSync(dest);
    fs.writeFileSync(dest + '.sha256', `${sha256}  ${fileName}\n`);

    const rec = {
      id, type: p.type, typeLabel: TYPE_LABEL[p.type] || p.type, fileName, relPath: path.join('evidence', id, fileName),
      size: stat.size, sha256, extractedAt: new Date().toISOString(), mtime: p.mtime || null,
      sourcePath: p.sourcePath || null, sourceUrl: p.sourceUrl || null, origin: p.origin || null,
      device: p.device || null, foreground: p.foreground || null, timeline: p.timeline || null,
      preflight: p.preflight ? { checkedAt: p.preflight.checkedAt, online: p.preflight.online, timestampService: p.preflight.timestampService } : null,
      parent: p.parent || null, ots: { status: 'not-stamped' },
    };
    this.store.log('evidence.hash', { id, fileName, sha256, size: stat.size, type: p.type });

    await this._stamp(rec, dir, p.preflight);
    await this._report(rec, dir, dest);
    this.store.upsert(rec);
    this.store.log('evidence.report', { id, report: rec.reportFile, ots: rec.ots.status });
    return rec;
  }

  async _stamp(rec, dir, preflight) {
    const canStamp = !preflight || (preflight.online && preflight.timestampService.available);
    if (!canStamp) { rec.ots = { status: 'not-stamped', reason: 'offline' }; return; }
    try {
      const bytes = await this.stampFn(rec.sha256);
      const f = rec.fileName + '.ots';
      fs.writeFileSync(path.join(dir, f), bytes);
      rec.ots = { status: 'pending', file: f, stampedAt: new Date().toISOString() };
      this.store.log('evidence.stamp', { id: rec.id, file: f });
    } catch (e) {
      rec.ots = { status: 'error', error: e.message };
      this.store.log('evidence.stamp.error', { id: rec.id, error: e.message });
    }
  }

  async _report(rec, dir, evidenceFile) {
    let thumbnail = null;
    const thumbFile = path.join(dir, 'miniatura.jpg');
    if (this.makeThumbnail && ['screenshot', 'web', 'media'].includes(rec.type)) {
      try { thumbnail = this.makeThumbnail(evidenceFile); } catch (_) { thumbnail = null; }
      if (thumbnail) fs.writeFileSync(thumbFile, thumbnail);
    } else if (fs.existsSync(thumbFile)) thumbnail = fs.readFileSync(thumbFile);

    const pdf = path.join(dir, `informe_${rec.id}.pdf`);
    await generatePdf(pdf, rec, { thumbnail, caseInfo: this.store.info(), appVersion: this.appVersion });
    const zip = path.join(dir, `paquete_${rec.id}.zip`);
    await zipPackage(zip, [
      { path: pdf, name: path.basename(pdf) },
      { path: evidenceFile + '.sha256', name: rec.fileName + '.sha256' },
      ...(rec.ots.file ? [{ path: path.join(dir, rec.ots.file), name: rec.ots.file }] : []),
    ]);
    rec.reportFile = path.relative(this.store.dir, pdf);
    rec.packageFile = path.relative(this.store.dir, zip);
  }

  /** Sella lo pendiente de sellar, intenta completar pruebas en Bitcoin y regenera informes. */
  async refreshTimestamps(preflight) {
    const results = [];
    for (const rec of this.store.list()) {
      if (rec.ots.status === 'confirmed') continue;
      const dir = path.join(this.store.dir, 'evidence', rec.id);
      const before = rec.ots.status;
      try {
        if (rec.ots.status === 'not-stamped' || rec.ots.status === 'error') await this._stamp(rec, dir, preflight);
        else {
          const f = path.join(dir, rec.ots.file);
          const { bytes, changed } = await ots.upgrade(fs.readFileSync(f));
          if (changed) fs.writeFileSync(f, bytes);
          const v = await ots.verify(fs.readFileSync(f), rec.sha256);
          if (v.status === 'confirmed') rec.ots = { ...rec.ots, status: 'confirmed', attestedTime: v.attestedTime, height: v.height };
        }
      } catch (e) { rec.ots.lastError = e.message; }
      if (rec.ots.status !== before) {
        await this._report(rec, dir, path.join(dir, rec.fileName));
        this.store.log('evidence.ots.update', { id: rec.id, from: before, to: rec.ots.status });
      }
      this.store.upsert(rec);
      results.push({ id: rec.id, from: before, to: rec.ots.status });
    }
    return results;
  }

  /** Recalcula el SHA-256 de cada evidencia y lo compara con el registrado. */
  async verifyIntegrity() {
    const out = [];
    for (const rec of this.store.list()) {
      const f = path.join(this.store.dir, rec.relPath);
      let ok = false; let now = null;
      try { now = await sha256File(f); ok = now === rec.sha256; } catch (_) { /* falta el archivo */ }
      out.push({ id: rec.id, fileName: rec.fileName, ok, expected: rec.sha256, actual: now });
    }
    this.store.log('integrity.verify', { total: out.length, failed: out.filter((o) => !o.ok).map((o) => o.id) });
    return out;
  }
}

module.exports = { EvidenceManager, TYPE_LABEL };
