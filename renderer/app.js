'use strict';
const $ = (s) => document.querySelector(s);
const api = window.safe;
const state = { caseOpen: false, serial: '', recTimer: null, recStart: 0, fgTimer: null };
const live = new LiveH264($('#live'));

// ---------- utilidades ----------
function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), bad ? 9000 : 5000);
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

// ---------- pantalla ----------
function showLive(on) { $('#liveEmpty').style.display = on ? 'none' : 'grid'; }
async function pollFg() {
  const r = await api.call('dev:foreground', { serial: state.serial });
  $('#fgApp').textContent = r.ok && r.data.component ? r.data.component : '—';
}
$('#btnShot').onclick = async () => {
  if (!need()) return;
  const rec = await act('act:screenshot', { serial: state.serial });
  if (rec) { toast(`Captura ${rec.id} registrada · ${rec.sha256.slice(0, 12)}…`); loadEvidence(); pollFg(); }
};
$('#btnRec').onclick = async () => {
  if (!need()) return;
  live.reset();
  const r = await act('act:recStart', { serial: state.serial });
  if (r === null) return;
};
$('#btnRecStop').onclick = () => { $('#btnRecStop').disabled = true; $('#recState').textContent = 'Finalizando y sellando…'; api.call('act:recStop'); };
api.on('rec:chunk', (d) => { showLive(true); live.push(d); });
api.on('recording', (s) => {
  $('#btnRec').disabled = s.active; $('#btnRecStop').disabled = !s.active;
  $('#recState').textContent = s.active ? '● Grabando' : 'Inactivo';
  clearInterval(state.recTimer); clearInterval(state.fgTimer);
  if (s.active) {
    state.recStart = Date.now();
    state.recTimer = setInterval(() => { const t = Math.floor((Date.now() - state.recStart) / 1000); $('#recTime').textContent = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }, 500);
    state.fgTimer = setInterval(pollFg, 3000); pollFg();
  } else { showLive(false); loadEvidence(); toast('Grabación finalizada'); }
});
api.on('evidence', (rec) => { toast(`Evidencia ${rec.id} · ${rec.fileName}`); loadEvidence(); });
api.on('error', (e) => toast(e.message, true));
api.on('progress', (p) => { if (p.kind === 'backup') $('#bkStatus').textContent = `${p.message} ${p.bytes ? (p.bytes / 1048576).toFixed(1) + ' MB' : ''}`; if (p.kind === 'pull') $('#pullStatus').textContent = p.message; });

// ---------- archivos ----------
document.querySelectorAll('.q').forEach((b) => (b.onclick = () => ($('#pullPath').value = b.dataset.p)));
$('#btnPull').onclick = async () => {
  if (!need()) return;
  $('#btnPull').disabled = true;
  const recs = await act('act:pull', { serial: state.serial, remote: $('#pullPath').value.trim() });
  $('#btnPull').disabled = false;
  if (recs) { $('#pullStatus').textContent = `✔ ${recs.length} archivo(s) registrados.`; loadEvidence(); }
};

// ---------- navegador ----------
const wv = $('#wv');
const go = () => { let u = $('#bUrl').value.trim(); if (!u) return; if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u; wv.loadURL(u); };
$('#bUrl').onkeydown = (e) => e.key === 'Enter' && go();
$('#bBack').onclick = () => wv.canGoBack() && wv.goBack(); $('#bFwd').onclick = () => wv.canGoForward() && wv.goForward(); $('#bReload').onclick = () => wv.reload();
wv.addEventListener('did-navigate', (e) => ($('#bUrl').value = e.url)); wv.addEventListener('did-navigate-in-page', (e) => ($('#bUrl').value = e.url));
$('#bCapture').onclick = async () => {
  if (!need(false)) return;
  const recs = await act('browser:capture', { wcId: wv.getWebContentsId() });
  if (recs) { toast(`Capturado y registrado: ${recs.map((r) => r.id).join(', ')}`); loadEvidence(); }
};

// ---------- evidencias ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const OTS = { confirmed: 'Confirmado', pending: 'Pendiente BTC', 'not-stamped': 'Sin sellar', error: 'Error' };
async function loadEvidence() {
  const r = await api.call('ev:list'); if (!r.ok) return;
  const list = r.data; $('#evCount').textContent = list.length; $('#evEmpty').style.display = list.length ? 'none' : 'block';
  $('#evTable tbody').innerHTML = list.slice().reverse().map((e) => `<tr><td>${e.id}</td><td class="fn">${esc(e.fileName)}</td><td>${esc(e.typeLabel)}</td><td class="h">${e.sha256}</td><td>${e.extractedAt.replace('T', ' ').slice(0, 19)}</td><td><span class="tag ${e.ots.status}">${OTS[e.ots.status] || e.ots.status}</span></td><td><button class="ghost" data-rep="${e.id}">Informe</button> <button class="ghost" data-rev="${e.id}">Carpeta</button></td></tr>`).join('');
}
$('#evTable').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.rep) api.call('ev:openReport', { id: b.dataset.rep }); if (b.dataset.rev) api.call('ev:reveal', { id: b.dataset.rev }); };
$('#btnOts').onclick = async () => { if (!need(false)) return; const r = await act('ev:refreshOts'); if (r) { toast(r.length ? r.map((x) => `${x.id}: ${x.from}→${x.to}`).join(' · ') : 'Nada pendiente'); loadEvidence(); } };
$('#btnVerify').onclick = async () => { const r = await api.call('ev:verify'); if (!r.ok) return toast(r.error, true); const bad = r.data.filter((x) => !x.ok); toast(bad.length ? `¡${bad.length} evidencia(s) NO coinciden: ${bad.map((b) => b.id).join(', ')}!` : `✔ ${r.data.length} evidencia(s) íntegras`, !!bad.length); };

// ---------- custodia ----------
async function loadLog() { const r = await api.call('ev:log'); if (r.ok) $('#logBox').textContent = r.data.map((l) => `#${l.seq} ${l.ts} ${l.action} ${JSON.stringify(l.details)}\n    hash ${l.hash}`).join('\n'); }
$('#btnLogVerify').onclick = async () => { const r = await api.call('case:verifyLog'); $('#logState').textContent = r.ok ? (r.data.ok ? `✔ Cadena íntegra (${r.data.entries} entradas)` : `✘ Cadena rota en la entrada #${r.data.brokenAt}`) : r.error; };

// ---------- arranque ----------
(async () => {
  const c = await api.call('config:get'); if (c.ok) { $('#adbPath').value = c.data.adbPath; $('#casesDir').value = c.data.casesDir; $('#examiner').value = c.data.examiner; }
  refreshNet(); refreshDevices();
})();
