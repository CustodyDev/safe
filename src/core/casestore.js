'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'archivo';

/** Un caso = carpeta con case.json, custody.log.jsonl, evidence/ y preflight/. */
class CaseStore {
  constructor(dir) {
    this.dir = dir;
    this.caseFile = path.join(dir, 'case.json');
    this.custodyFile = path.join(dir, 'custody.log.jsonl');
    this.indexFile = path.join(dir, 'evidence.json');
  }

  static create(baseDir, { caseId, examiner = '', notes = '' }) {
    const id = safeName(caseId || `CASO-${new Date().toISOString().slice(0, 10)}`);
    const dir = path.join(baseDir, id);
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'preflight'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'staging'), { recursive: true });
    const store = new CaseStore(dir);
    if (!fs.existsSync(store.caseFile)) {
      fs.writeFileSync(store.caseFile, JSON.stringify({ caseId: id, examiner, notes, createdAt: new Date().toISOString() }, null, 2));
    }
    store.log('case.open', { caseId: id, examiner });
    return store;
  }

  static open(dir) {
    if (!fs.existsSync(path.join(dir, 'case.json'))) throw new Error('La carpeta no contiene un caso S.A.F.E.');
    const s = new CaseStore(dir);
    s.log('case.open', { caseId: s.info().caseId });
    return s;
  }

  info() { return JSON.parse(fs.readFileSync(this.caseFile, 'utf8')); }

  /** Registro de cadena de custodia encadenado por hash (cada línea incluye el hash de la anterior). */
  log(action, details = {}) {
    let prev = '0'.repeat(64);
    let seq = 1;
    if (fs.existsSync(this.custodyFile)) {
      const lines = fs.readFileSync(this.custodyFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) { const last = JSON.parse(lines[lines.length - 1]); prev = last.hash; seq = last.seq + 1; }
    }
    const entry = { seq, ts: new Date().toISOString(), action, details, prev };
    entry.hash = crypto.createHash('sha256').update(prev + JSON.stringify({ seq, ts: entry.ts, action, details })).digest('hex');
    fs.appendFileSync(this.custodyFile, JSON.stringify(entry) + '\n');
    return entry;
  }

  /** Verifica la integridad de la cadena del registro de custodia. */
  verifyLog() {
    if (!fs.existsSync(this.custodyFile)) return { ok: true, entries: 0 };
    let prev = '0'.repeat(64);
    const lines = fs.readFileSync(this.custodyFile, 'utf8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      const e = JSON.parse(l);
      const h = crypto.createHash('sha256').update(prev + JSON.stringify({ seq: e.seq, ts: e.ts, action: e.action, details: e.details })).digest('hex');
      if (e.prev !== prev || e.hash !== h) return { ok: false, entries: lines.length, brokenAt: e.seq };
      prev = e.hash;
    }
    return { ok: true, entries: lines.length };
  }

  list() { return fs.existsSync(this.indexFile) ? JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) : []; }
  save(list) { fs.writeFileSync(this.indexFile, JSON.stringify(list, null, 2)); }

  nextId() {
    const n = this.list().reduce((m, e) => Math.max(m, parseInt(e.id.slice(3), 10) || 0), 0) + 1;
    return 'EV-' + String(n).padStart(4, '0');
  }

  upsert(record) {
    const list = this.list();
    const i = list.findIndex((e) => e.id === record.id);
    if (i >= 0) list[i] = record; else list.push(record);
    this.save(list);
  }

  evidenceDir(id) { const d = path.join(this.dir, 'evidence', id); fs.mkdirSync(d, { recursive: true }); return d; }
  stagingDir(sub) { const d = path.join(this.dir, 'staging', sub || String(Date.now())); fs.mkdirSync(d, { recursive: true }); return d; }
  preflightFile(name) { return path.join(this.dir, 'preflight', name); }
}

module.exports = { CaseStore, safeName };
