'use strict';
const PDFDocument = require('pdfkit');
const fs = require('fs');
const { ZipArchive } = require('archiver');

const C = { ink: '#0b1220', accent: '#0e9f8e', mute: '#5b6678', line: '#d5dbe5', warn: '#b45309' };

const OTS_TEXT = {
  confirmed: 'Confirmado en la blockchain de Bitcoin',
  pending: 'Enviado a los calendarios OpenTimestamps; pendiente de confirmación en Bitcoin (puede tardar horas)',
  'not-stamped': 'NO sellado (sin conexión o servicio no disponible durante la extracción). Pendiente de sellar',
  error: 'Error durante el sellado',
};

function kv(doc, label, value, { mono = false, big = false } = {}) {
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.mute).text(label.toUpperCase(), 50, y, { width: 130 });
  doc.font(mono ? 'Courier' : 'Helvetica').fontSize(big ? 12 : 10).fillColor(C.ink)
    .text(value || '—', 185, y - 1, { width: 360 });
  doc.moveDown(0.5);
}

function section(doc, title) {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.accent).text(title, 50);
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor(C.line).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
}

/**
 * Genera el informe PDF (streams comprimidos) de una evidencia.
 * rec: registro de evidencia; opts.thumbnail: Buffer JPEG/PNG opcional.
 */
function generatePdf(file, rec, { thumbnail, caseInfo = {}, appVersion = '1.0.0' } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: true, info: { Title: `Informe de evidencia ${rec.id}`, Author: 'S.A.F.E.', Subject: rec.fileName } });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    out.on('finish', resolve).on('error', reject);

    doc.rect(0, 0, 595, 78).fill(C.ink);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('S.A.F.E.', 50, 22);
    doc.font('Helvetica').fontSize(9).fillColor('#9fb3c8').text('Secure Android Forensic Extractor  ·  Informe de evidencia', 50, 48);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.accent).text(rec.id, 400, 28, { width: 145, align: 'right' });
    doc.y = 100;

    section(doc, 'Archivo de evidencia');
    kv(doc, 'Nombre del archivo', rec.fileName, { mono: true, big: true });
    kv(doc, 'Tipo', rec.typeLabel);
    kv(doc, 'Tamaño', `${rec.size.toLocaleString('es-ES')} bytes`);
    if (rec.sourcePath) kv(doc, 'Ruta de origen', rec.sourcePath, { mono: true });
    if (rec.sourceUrl) kv(doc, 'URL de origen', rec.sourceUrl, { mono: true });
    if (rec.mtime) kv(doc, 'Modificado (origen)', rec.mtime);

    section(doc, 'Integridad (SHA-256 del archivo original)');
    doc.font('Courier-Bold').fontSize(11).fillColor(C.ink).text(rec.sha256.slice(0, 32), 50).text(rec.sha256.slice(32), 50);
    doc.moveDown(0.4);
    kv(doc, 'Fecha de extracción', `${rec.extractedAt} (UTC)`);
    kv(doc, 'Hora local', new Date(rec.extractedAt).toString());

    if (rec.transfer) {
      section(doc, 'Verificación en origen (antes de extraer)');
      doc.font('Courier').fontSize(9).fillColor(C.ink).text(rec.transfer.deviceSha256.slice(0, 32), 185).text(rec.transfer.deviceSha256.slice(32), 185);
      doc.moveDown(0.3);
      kv(doc, 'SHA-256 en dispositivo', `calculado con sha256sum el ${rec.transfer.deviceHashedAt || '—'}`);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(rec.transfer.match ? C.accent : '#b91c1c')
        .text(rec.transfer.match ? 'COINCIDE con el hash del archivo extraído: transferencia íntegra.' : 'NO COINCIDE con el archivo extraído: revisar la transferencia.', 185);
      doc.moveDown(0.5);
    }
    if (rec.recording) {
      section(doc, 'Datos de la grabación');
      kv(doc, 'Duración', `${rec.recording.durationSec.toFixed(1)} s`);
      kv(doc, 'Fotogramas', `${rec.recording.frames} (≈ ${rec.recording.fps.toFixed(1)} fps medios, tasa variable)`);
      kv(doc, 'Resolución', rec.recording.resolution || '—');
      kv(doc, 'Motor', rec.recording.engine === 'native' ? 'ADB nativo (screenrecord → PC). Sin archivos subidos al dispositivo.' : 'scrcpy-server (flujo H.264 → PC)');
      kv(doc, 'Archivo único', rec.recording.gaps && rec.recording.gaps.length ? `Sí. ${rec.recording.gaps.length} reinicio(s) por el límite de 180 s de Android (hueco ≈ 1 s cada uno): ${rec.recording.gaps.join(', ')}` : 'Grabación continua sin cortes');
    }

    section(doc, 'Dispositivo de origen');
    const d = rec.device || {};
    if (d.model || d.serial) {
      kv(doc, 'Dispositivo', [d.manufacturer, d.model].filter(Boolean).join(' '));
      kv(doc, 'Nº de serie', d.serial, { mono: true });
      kv(doc, 'Android', d.androidVersion ? `${d.androidVersion} (SDK ${d.sdk}), parche ${d.securityPatch || 'n/d'}` : '');
      kv(doc, 'Huella (build)', d.fingerprint, { mono: true });
      if (d.androidId) kv(doc, 'Android ID', d.androidId, { mono: true });
    } else {
      kv(doc, 'Origen', rec.origin || 'Navegador interno de S.A.F.E. (no es un dispositivo Android)');
    }
    if (rec.foreground && rec.foreground.package) {
      kv(doc, 'App en primer plano', `${rec.foreground.package}\n${rec.foreground.activity}`, { mono: true });
    }

    section(doc, 'Sellado en blockchain (OpenTimestamps)');
    kv(doc, 'Estado', OTS_TEXT[rec.ots.status] || rec.ots.status);
    if (rec.ots.file) kv(doc, 'Prueba (.ots)', rec.ots.file, { mono: true });
    if (rec.ots.attestedTime) kv(doc, 'Atestiguado', `${rec.ots.attestedTime}  (bloque ${rec.ots.height || 'n/d'})`);
    const pf = rec.preflight || {};
    kv(doc, 'Constancia previa', `Internet: ${pf.online ? 'sí' : 'NO'} · Servicio de sellado: ${pf.timestampService && pf.timestampService.available ? `disponible (${pf.timestampService.up}/${pf.timestampService.total} calendarios)` : 'NO disponible'} · ${pf.checkedAt || ''}`);

    if (rec.timeline && rec.timeline.length) {
      section(doc, 'Aplicaciones en primer plano durante la grabación');
      rec.timeline.slice(0, 40).forEach((t) => {
        doc.font('Courier').fontSize(8.5).fillColor(C.ink).text(`${t.ts}  ${t.component || '(sin foco)'}`, 50);
      });
    }

    if (thumbnail) {
      if (doc.y > 560) doc.addPage();
      section(doc, 'Miniatura');
      try { doc.image(thumbnail, 50, doc.y, { fit: [220, 280] }); } catch (_) { doc.text('(miniatura no disponible)'); }
    }

    doc.font('Helvetica').fontSize(7.5).fillColor(C.mute)
      .text(`Caso: ${caseInfo.caseId || '—'}  ·  Examinador: ${caseInfo.examiner || '—'}  ·  S.A.F.E. v${appVersion}  ·  Informe generado ${new Date().toISOString()}`, 50, 790, { width: 495, align: 'center' });
    doc.end();
  });
}

/** Paquete ZIP comprimido: informe PDF + hash + prueba .ots. */
function zipPackage(zipFile, files) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipFile);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    files.filter((f) => fs.existsSync(f.path)).forEach((f) => zip.file(f.path, { name: f.name }));
    zip.finalize();
  });
}

module.exports = { generatePdf, zipPackage };
