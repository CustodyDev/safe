'use strict';
const $ = (s) => document.querySelector(s);
const api = window.safe;
const state = { caseOpen: false, serial: '', recTimer: null, recStart: 0, fgTimer: null, connected: false, cwd: '/sdcard', entries: [], hashes: {} };
const live = new LiveVideo($('#live'), { onNeedKey: () => api.control({ t: 'keyframe' }) });

// ---------- tema: Nord (oscuro) / Arena (claro) ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t; $('#btnTheme').textContent = t === 'nord' ? '☀' : '☾';
  $('#btnTheme').title = t === 'nord' ? 'Cambiar a tema Arena (claro)' : 'Cambiar a tema Nord (oscuro)';
  try { localStorage.setItem('safe.theme', t); } catch (_) { /* sin almacenamiento */ }
}
$('#btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'nord' ? 'sand' : 'nord');
(function () { let t = 'nord'; try { t = localStorage.getItem('safe.theme') || 'nord'; } catch (_) { /* */ } applyTheme(t === 'sand' ? 'sand' : 'nord'); })();

// ---------- utilidades ----------
function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 9000 : 5000);
}
function infoDialog(title, text) {
  return new Promise((res) => {
    $('#mTitle').textContent = title; $('#mBody').textContent = ''; $('#mPre').textContent = text; $('#mPre').hidden = false; $('#mCancel').hidden = true; $('#mOk').textContent = 'Cerrar'; $('#modal').hidden = false;
    $('#mOk').onclick = () => { $('#modal').hidden = true; $('#mPre').hidden = true; $('#mCancel').hidden = false; $('#mOk').textContent = 'Continuar de todos modos'; res(); };
  });
}
function confirmDialog(title, body) {
  return new Promise((res) => {
    $('#mTitle').textContent = title; $('#mBody').textContent = body; $('#modal').hidden = false;
    const done = (v) => { $('#modal').hidden = true; $('#mOk').onclick = $('#mCancel').onclick = null; res(v); };
    $('#mOk').onclick = () => done(true); $('#mCancel').onclick = () => done(false);
  });
}
/** Llama a una acción; si la verificación previa detecta falta de conexión/servicio, avisa y pide confirmación. */
async function act(channel, arg = {}) {
  let r = await api.call(channel, arg);
  if (!r.ok && r.confirm) {
    const go = await confirmDialog('Verificación previa: conexión', r.error);
    if (!go) return null;
    r = await api.call(channel, { ...arg, ack: true });
  }
  if (!r.ok) { toast(r.error, true); return null; }
  return r.data;
}
const need = (dev = true) => {
  if (!state.caseOpen) { toast('Cree o abra un caso primero.', true); return false; }
  if (dev && !state.serial) { toast('Seleccione un dispositivo.', true); return false; }
  return true;
};

// ---------- navegación ----------
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'evidence') loadEvidence();
  if (b.dataset.view === 'log') loadLog();
});

// ---------- estado de red ----------
async function refreshNet() {
  const r = await api.call('net:status');
  const net = r.ok && r.data.online; const ots = r.ok && r.data.timestampService.available;
  $('#pillNet').className = 'pill ' + (net ? 'ok' : 'bad'); $('#pillNet').lastChild.textContent = net ? 'Internet' : 'Sin Internet';
  $('#pillOts').className = 'pill ' + (ots ? 'ok' : 'bad');
  $('#pillOts').lastChild.textContent = ots ? `Sellado OTS ${r.data.timestampService.up}/${r.data.timestampService.total}` : 'Sellado no disponible';
}
setInterval(refreshNet, 30000);

// ---------- caso y ajustes ----------
function setCase(c) {
  state.caseOpen = true; $('#caseChip').textContent = 'Caso: ' + c.caseId; $('#caseChip').classList.add('on');
  $('#caseId').value = c.caseId; $('#examiner').value = c.examiner || ''; $('#caseNotes').value = c.notes || '';
  toast('Caso abierto: ' + c.dir); loadEvidence();
}
$('#btnCreateCase').onclick = async () => {
  const r = await api.call('case:create', { caseId: $('#caseId').value.trim(), examiner: $('#examiner').value.trim(), notes: $('#caseNotes').value });
  r.ok ? setCase(r.data) : toast(r.error, true);
};
$('#btnOpenCase').onclick = async () => { const r = await api.call('case:open'); if (r.ok && r.data) setCase(r.data); else if (!r.ok) toast(r.error, true); };
$('#btnCaseFolder').onclick = () => api.call('case:folder');
$('#btnSaveCfg').onclick = async () => { await api.call('config:set', { adbPath: $('#adbPath').value.trim(), casesDir: $('#casesDir').value.trim() }); toast('Ajustes guardados'); };
$('#btnAdbTest').onclick = async () => { const r = await api.call('adb:version'); $('#adbStatus').textContent = r.ok ? '✔ ' + r.data : '✘ ' + r.error; };

// ---------- dispositivos ----------
async function refreshDevices() {
  const r = await api.call('dev:list'); const sel = $('#deviceSel');
  if (!r.ok) { toast(r.error, true); return; }
  sel.innerHTML = '<option value="">— Sin dispositivo —</option>';
  r.data.forEach((d) => { const o = document.createElement('option'); o.value = d.serial; o.textContent = `${d.model || d.serial} · ${d.state}`; o.disabled = d.state !== 'device'; sel.append(o); });
  const ok = r.data.find((d) => d.state === 'device');
  if (ok && !state.serial) { sel.value = ok.serial; sel.onchange(); }
  if (!r.data.length) toast('No se detectan dispositivos. Active la depuración USB y acepte la huella RSA.', true);
  else if (r.data.some((d) => d.state === 'unauthorized')) toast('Dispositivo sin autorizar: acepte el diálogo de depuración USB en el teléfono.', true);
}
$('#btnRefreshDev').onclick = refreshDevices;
$('#deviceSel').onchange = async () => {
  state.serial = $('#deviceSel').value; if (!state.serial) return;
  const r = await api.call('dev:info', { serial: state.serial });
  if (!r.ok) return toast(r.error, true);
  const d = r.data;
  $('#devInfo').innerHTML = '';
  [['Dispositivo', `${d.manufacturer} ${d.model}`], ['Nº de serie', d.serial], ['Android', `${d.androidVersion} (SDK ${d.sdk})`], ['Parche de seguridad', d.securityPatch], ['Build', d.fingerprint], ['Android ID', d.androidId]].forEach(([k, v]) => {
    const p = document.createElement('div'); p.className = 'kpi'; p.innerHTML = '<span></span><b class="mono"></b>'; p.firstChild.textContent = k; p.lastChild.textContent = v || '—'; $('#devInfo').append(p);
  });
};

// ---------- copia ADB ----------
$('#btnBackup').onclick = async () => {
  if (!need()) return;
  $('#btnBackup').disabled = true; $('#btnBackupCancel').disabled = false; $('.progress').classList.add('busy');
  $('#bkStatus').textContent = 'Confirme la copia en la pantalla del dispositivo…';
  const rec = await act('act:backup', { serial: state.serial, options: { apk: $('#bkApk').checked, shared: $('#bkShared').checked, obb: $('#bkObb').checked, system: $('#bkSystem').checked } });
  $('#btnBackup').disabled = false; $('#btnBackupCancel').disabled = true; $('.progress').classList.remove('busy'); $('#bkBar').style.width = rec ? '100%' : '0';
  if (rec) { $('#bkStatus').textContent = `✔ ${rec.id} · ${rec.fileName} · SHA-256 ${rec.sha256.slice(0, 16)}…`; loadEvidence(); }
  else $('#bkStatus').textContent = 'Copia no completada.';
};
$('#btnBackupCancel').onclick = () => api.call('act:backupCancel');

// ---------- pantalla en vivo + control ----------
const sizeOf = () => ({ w: $('#live').width, h: $('#live').height });
function showLive(on) { $('#liveEmpty').style.display = on ? 'none' : 'grid'; }
async function pollFg() {
  if (!state.connected) return;
  const r = await api.call('dev:foreground', { serial: state.serial });
  $('#fgApp').textContent = r.ok && r.data.component ? r.data.component : '—';
}
function setConnected(on) {
  state.connected = on; $('#btnLive').disabled = on; $('#btnLive').hidden = on; $('#btnLiveStop').disabled = !on; $('#btnLiveStop').hidden = !on; $('#btnRec').disabled = !on;
  $('#recState').textContent = on ? 'Listo para grabar' : 'Conecte la pantalla para grabar'; showLive(on);
  $('#connState').textContent = on ? '✔ Conectado' : 'Desconectado'; $('#stepConnect').classList.toggle('done', on);
  clearInterval(state.fgTimer); if (on) { state.fgTimer = setInterval(pollFg, 3000); pollFg(); } else { live.reset(); $('#liveFps').textContent = '— fps'; }
}
$('#btnLive').onclick = async () => {
  if (!need()) return;
  live.reset();
  $('#btnLive').disabled = true; $('#connState').textContent = 'Conectando…'; $('#recState').textContent = 'Conectando…';
  const r = await act('act:liveStart', { serial: state.serial, maxSize: $('#optSize').value, control: $('#optControl').checked && $('#optEngine').value === 'scrcpy', engine: $('#optEngine').value });
  if (r === null) { $('#btnLive').disabled = false; $('#connState').textContent = 'Desconectado'; $('#recState').textContent = 'Conecte la pantalla para grabar'; }
};
$('#btnLiveStop').onclick = () => api.call('act:liveStop');
api.on('live:ready', (r) => { setConnected(true); toast(`Conectado (${r.engine === 'native' ? 'ADB nativo' : 'scrcpy'}): ${r.deviceName}${r.w ? ` (${r.w}×${r.h})` : ''}`); $('#live').focus(); });
api.on('live:closed', () => { setConnected(false); $('#btnRec').disabled = true; $('#btnRecStop').disabled = true; toast('Pantalla desconectada'); });
api.on('live:packet', (p) => live.push(p));
setInterval(() => { if (state.connected) $('#liveFps').textContent = live.fps + ' fps'; }, 1000);

$('#optEngine').onchange = () => { const n = $('#optEngine').value === 'native'; $('#optControl').disabled = n; if (n) $('#optControl').checked = false; else $('#optControl').checked = true; };

// Entrada: ratón/táctil, rueda, teclado
const cv = $('#live'); let down = false; let pend = null;
const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: Math.max(0, Math.min(cv.width - 1, ((e.clientX - r.left) / r.width) * cv.width)), y: Math.max(0, Math.min(cv.height - 1, ((e.clientY - r.top) / r.height) * cv.height)) }; };
const sendTouch = (action, e) => { const { w, h } = sizeOf(); api.control({ t: 'touch', action, ...pos(e), w, h }); };
cv.addEventListener('pointerdown', (e) => { if (!state.connected || !$('#optControl').checked) return; cv.setPointerCapture(e.pointerId); cv.focus(); down = true; sendTouch(0, e); });
cv.addEventListener('pointermove', (e) => { if (!down) return; pend = e; });
cv.addEventListener('pointerup', (e) => { if (!down) return; down = false; pend = null; sendTouch(1, e); });
cv.addEventListener('pointercancel', (e) => { if (down) { down = false; pend = null; sendTouch(1, e); } });
(function moveLoop() { if (pend) { sendTouch(2, pend); pend = null; } requestAnimationFrame(moveLoop); })();
cv.addEventListener('wheel', (e) => { if (!state.connected || !$('#optControl').checked) return; e.preventDefault(); const { w, h } = sizeOf(); api.control({ t: 'scroll', ...pos(e), w, h, dx: -e.deltaX / 100, dy: -e.deltaY / 100 }); }, { passive: false });
const KEYS = { Enter: 66, Backspace: 67, Delete: 112, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Escape: 4, Home: 3 };
cv.addEventListener('keydown', (e) => {
  if (!state.connected || !$('#optControl').checked || e.ctrlKey || e.metaKey) return;
  if (KEYS[e.key]) { e.preventDefault(); api.control({ t: 'key', code: KEYS[e.key] }); }
  else if (e.key.length === 1) { e.preventDefault(); api.control({ t: 'text', text: e.key }); }
});
$('#keys').onclick = (e) => { const b = e.target.closest('button'); if (b && state.connected && $('#optControl').checked) api.control({ t: 'key', code: Number(b.dataset.k) }); };

// Grabación (archivo único)
$('#btnShot').onclick = async () => {
  if (!need()) return;
  const rec = await act('act:screenshot', { serial: state.serial });
  if (rec) { toast(`Captura ${rec.id} registrada · ${rec.sha256.slice(0, 12)}…`); loadEvidence(); pollFg(); }
};
$('#btnRec').onclick = async () => { if (!state.connected) return; await act('act:recStart'); };
$('#btnRecStop').onclick = () => { $('#btnRecStop').disabled = true; $('#recState').textContent = 'Finalizando, calculando hash y sellando…'; api.call('act:recStop'); };
const fmtClock = (t) => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
api.on('recording', (s) => {
  clearInterval(state.recTimer);
  if (s.active) {
    $('#btnRec').disabled = true; $('#btnRec').hidden = true; $('#btnRecStop').disabled = false; $('#btnRecStop').hidden = false; $('#recCard').classList.add('recording');
    $('#recState').textContent = 'Grabando'; state.recStart = Date.now(); $('#recTime').textContent = '00:00';
    state.recTimer = setInterval(() => { $('#recTime').textContent = fmtClock(Math.floor((Date.now() - state.recStart) / 1000)); }, 500);
  } else if (!s.finalizing) {
    $('#btnRec').hidden = false; $('#btnRec').disabled = !state.connected; $('#btnRecStop').hidden = true; $('#btnRecStop').disabled = true; $('#recCard').classList.remove('recording');
    $('#recState').textContent = state.connected ? 'Listo para grabar' : 'Conecte la pantalla para grabar'; loadEvidence(); if (state.connected) toast('Grabación finalizada y sellada');
  }
});
api.on('evidence', (rec) => { toast(`Evidencia ${rec.id} · ${rec.fileName}`); loadEvidence(); });
api.on('error', (e) => toast(e.message, true));
api.on('progress', (p) => { if (p.kind === 'backup') $('#bkStatus').textContent = `${p.message} ${p.bytes ? (p.bytes / 1048576).toFixed(1) + ' MB' : ''}`; if (p.kind === 'fs') $('#fsStatus').textContent = p.message; if (p.kind === 'finalize') $('#finStatus').textContent = p.message; });

// ---------- explorador de archivos ----------
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
const join = (d, n) => (d.replace(/\/+$/, '') + '/' + n);
const selected = () => [...document.querySelectorAll('#fTable tbody input:checked')].map((c) => c.dataset.path);
const updateSel = () => { $('#fSel').textContent = selected().length + ' seleccionados'; };
async function loadDir(dir) {
  if (!state.serial) return toast('Seleccione un dispositivo.', true);
  const keep = new Set(dir.replace(/(.)\/+$/, '$1') === state.cwd ? selected() : []);
  const r = await api.call('fs:list', { serial: state.serial, dir });
  if (!r.ok) return toast(r.error, true);
  state.cwd = dir.replace(/(.)\/+$/, '$1'); $('#fPath').value = state.cwd; state.entries = r.data;
  $('#fEmpty').style.display = r.data.length ? 'none' : 'block'; $('#fEmpty').textContent = 'Carpeta vacía o sin permisos.';
  $('#fTable tbody').innerHTML = r.data.map((e) => { const p = join(state.cwd, e.name); const h = state.hashes[p];
    return `<tr><td><input type="checkbox" data-path="${esc(p)}" ${keep.has(p) ? 'checked' : ''}></td><td class="name ${e.type === 'dir' || e.type === 'link' ? 'dir' : ''}" data-dir="${e.type !== 'file' ? esc(e.target || p) : ''}">${e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : '📄'} ${esc(e.name)}</td><td>${e.type === 'file' ? fmtSize(e.size) : ''}</td><td>${esc(e.mtime)}</td><td class="mono">${esc(e.perms)}</td><td class="sha ${h && h.error ? 'err' : ''}">${h ? esc(h.sha256 || h.error) : ''}</td></tr>`; }).join('');
  $('#fAll').checked = false; updateSel();
}
$('#fTable').addEventListener('click', (e) => { const n = e.target.closest('td.name'); if (n && n.dataset.dir) loadDir(n.dataset.dir); if (e.target.type === 'checkbox') updateSel(); });
$('#fAll').onchange = (e) => { document.querySelectorAll('#fTable tbody input').forEach((c) => (c.checked = e.target.checked)); updateSel(); };
$('#fPath').onkeydown = (e) => e.key === 'Enter' && loadDir($('#fPath').value.trim());
$('#fUp').onclick = () => loadDir(state.cwd.replace(/\/[^/]+$/, '') || '/');
$('#fReload').onclick = () => loadDir(state.cwd);
document.querySelectorAll('.q').forEach((b) => (b.onclick = () => loadDir(b.dataset.p)));
$('#btnFsHash').onclick = async () => {
  if (!need()) return; const paths = selected(); if (!paths.length) return toast('Marque al menos un archivo o carpeta.', true);
  $('#btnFsHash').disabled = true;
  const r = await act('fs:hash', { serial: state.serial, paths });
  $('#btnFsHash').disabled = false;
  if (r) { r.forEach((h) => (state.hashes[h.path] = h)); $('#fsStatus').textContent = `✔ SHA-256 calculado en el dispositivo para ${r.filter((x) => x.sha256).length} fichero(s). Ya puede extraer con verificación.`; loadDir(state.cwd); }
};
$('#btnFsExtract').onclick = async () => {
  if (!need()) return; const paths = selected(); if (!paths.length) return toast('Marque al menos un archivo o carpeta.', true);
  $('#btnFsExtract').disabled = true;
  const r = await act('fs:extract', { serial: state.serial, paths });
  $('#btnFsExtract').disabled = false;
  if (r) {
    const ok = r.filter((x) => !x.error); const bad = ok.filter((x) => x.transfer && !x.transfer.match);
    $('#fsStatus').textContent = `✔ ${ok.length} extraído(s); ${bad.length ? '⚠ ' + bad.length + ' con hash distinto' : 'todos coinciden con el hash del dispositivo'}${r.length - ok.length ? `; ${r.length - ok.length} con error` : ''}.`;
    loadEvidence();
  }
};

// ---------- evidencias ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const OTS = { confirmed: 'Confirmado', pending: 'Pendiente BTC', 'not-stamped': 'Sin sellar', error: 'Error' };
async function loadEvidence() {
  const r = await api.call('ev:list'); if (!r.ok) return;
  const list = r.data; $('#evCount').textContent = list.length; $('#evEmpty').style.display = list.length ? 'none' : 'block';
  $('#evTable tbody').innerHTML = list.slice().reverse().map((e) => `<tr><td>${e.id}</td><td class="fn">${esc(e.fileName)}</td><td>${esc(e.typeLabel)}</td><td class="h">${e.sha256}</td><td>${e.extractedAt.replace('T', ' ').slice(0, 19)}</td><td><span class="tag ${e.ots.status}">${OTS[e.ots.status] || e.ots.status}</span></td><td><button class="ghost" data-rep="${e.id}">Informe</button> <button class="ghost" data-rev="${e.id}">Carpeta</button> <button class="ghost" data-ver="${e.id}">Verificar sello</button></td></tr>`).join('');
}
$('#evTable').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.rep) api.call('ev:openReport', { id: b.dataset.rep }); if (b.dataset.rev) api.call('ev:reveal', { id: b.dataset.rev });
  if (b.dataset.ver) verifyOne(b.dataset.ver); };
async function verifyOne(id) {
  const r = await api.call('ev:verifyOne', { id }); if (!r.ok) return toast(r.error, true);
  const v = r.data; const m = (a, b) => (a && a === b ? '✔' : '✘');
  const bt = v.bitcoin ? (v.bitcoin.status === 'confirmed' ? `CONFIRMADO en Bitcoin — bloque ${v.bitcoin.height}, ${v.bitcoin.attestedTime}` : v.bitcoin.status === 'invalid' ? 'INVÁLIDO' : 'Pendiente de anclaje en Bitcoin (aún sin bloque)') : 'No comprobado (sin conexión o sin .ots)';
  await infoDialog(`Verificación de ${v.id} — ${v.fileName}`, [
    `SHA-256 del archivo (recalculado ahora): ${v.fileSha256}`,
    `${m(v.fileSha256, v.recordSha256)} Registro del caso (evidence.json):  ${v.recordSha256}`,
    `${m(v.fileSha256, v.sha256File)} Archivo .sha256:                       ${v.sha256File}`,
    `${v.hasOts ? m(v.fileSha256, v.otsSha256) : '—'} Hash DENTRO del sello .ots:             ${v.otsSha256 || '(sin .ots: evidencia aún sin sellar)'}`,
    '', v.allMatch ? (v.hasOts ? '✔ El hash sellado en OpenTimestamps es el mismo del caso.' : '✔ Archivo y registro coinciden. Falta sellar (Evidencias → Sellar / actualizar).') : '✘ HAY DISCREPANCIAS: el archivo, el registro o el sello no coinciden.',
    '', 'Atestaciones del .ots: ' + (v.attestations.map((a) => (a.type === 'bitcoin' ? `Bitcoin #${a.height}` : `pendiente en ${a.uri}`)).join(' · ') || 'ninguna'),
    'Estado en Bitcoin: ' + bt].join('\n'));
}
$('#btnOts').onclick = async () => { if (!need(false)) return; const r = await act('ev:refreshOts'); if (r) { toast(r.length ? r.map((x) => `${x.id}: ${x.from}→${x.to}`).join(' · ') : 'Nada pendiente'); loadEvidence(); } };
$('#btnVerify').onclick = async () => { const r = await api.call('ev:verify'); if (!r.ok) return toast(r.error, true); const bad = r.data.filter((x) => !x.ok); toast(bad.length ? `¡${bad.length} evidencia(s) NO coinciden: ${bad.map((b) => b.id).join(', ')}!` : `✔ ${r.data.length} evidencia(s) íntegras`, !!bad.length); };

// ---------- cierre del caso ----------
let lastPackage = null;
$('#btnFinalize').onclick = async () => {
  if (!need(false)) return;
  if (!await confirmDialog('Finalizar caso', 'Se verificará la integridad, se comprimirá todo el caso en un ZIP y se validará el resultado. Esto puede tardar según el tamaño. ¿Continuar?')) return;
  $('#btnFinalize').disabled = true; $('#finResult').innerHTML = ''; $('#finStatus').parentElement.querySelector('.progress').classList.add('busy');
  const r = await act('case:finalize');
  $('#btnFinalize').disabled = false; $('#finStatus').parentElement.querySelector('.progress').classList.remove('busy');
  if (!r) { $('#finStatus').textContent = 'Cierre no completado.'; return; }
  lastPackage = r; $('#btnFinalFolder').disabled = false;
  $('#finStatus').textContent = r.status === 'FALLO' ? '✘ El cierre terminó con FALLOS de validación.' : r.status === 'OK' ? '✔ Caso finalizado y validado.' : '⚠ Caso finalizado y validado, con avisos (p. ej. evidencias sin sellar).';
  $('#finResult').innerHTML = `<div class="note ${r.status === 'FALLO' ? 'warn' : ''}"><b>${r.status === 'FALLO' ? 'VALIDACIÓN FINAL FALLIDA' : r.status === 'OK' ? 'VALIDACIÓN FINAL CORRECTA' : 'VALIDACIÓN FINAL CORRECTA (CON AVISOS)'}</b></div><table><tbody>${r.checks.map((c) => `<tr><td class="${c.ok ? 'ok' : c.warn ? '' : 'bad'}">${c.ok ? '✔' : c.warn ? '⚠' : '✘'}</td><td>${esc(c.name)}</td><td class="hint">${esc(c.detail)}</td></tr>`).join('')}</tbody></table><p class="mono hint">${esc(r.zipFile)}<br>SHA-256 ${r.zipSha256} · ${fmtSize(r.zipSize)} · sello: ${esc(r.zipOts)}</p>`;
};
$('#btnFinalFolder').onclick = () => lastPackage && api.call('ev:revealPath', { file: lastPackage.zipFile });

// ---------- custodia ----------
async function loadLog() { const r = await api.call('ev:log'); if (r.ok) $('#logBox').textContent = r.data.map((l) => `#${l.seq} ${l.ts} ${l.action} ${JSON.stringify(l.details)}\n    hash ${l.hash}`).join('\n'); }
$('#btnLogVerify').onclick = async () => { const r = await api.call('case:verifyLog'); $('#logState').textContent = r.ok ? (r.data.ok ? `✔ Cadena íntegra (${r.data.entries} entradas)` : `✘ Cadena rota en la entrada #${r.data.brokenAt}`) : r.error; };

// ---------- arranque ----------
(async () => {
  const c = await api.call('config:get'); if (c.ok) { $('#adbPath').value = c.data.adbPath; $('#casesDir').value = c.data.casesDir; $('#examiner').value = c.data.examiner; }
  refreshNet(); refreshDevices();
})();
