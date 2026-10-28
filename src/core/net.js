'use strict';
const https = require('https');

// Calendarios públicos de OpenTimestamps (los mismos que usa la librería por defecto).
const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];
const INTERNET_PROBES = ['https://www.google.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace'];

// En Electron se sustituye por net.fetch (respeta el proxy del sistema).
let fetcher = null;
function setFetcher(fn) { fetcher = fn; }

function probe(url, timeout = 4000) {
  if (fetcher) {
    const t0 = Date.now();
    return Promise.race([
      fetcher(url).then((status) => ({ url, ok: status > 0 && status < 500, ms: Date.now() - t0, status }), (e) => ({ url, ok: false, ms: Date.now() - t0, error: e.code || e.message })),
      new Promise((r) => setTimeout(() => r({ url, ok: false, ms: timeout, error: 'timeout' }), timeout)),
    ]);
  }
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (ok, extra) => {
      if (done) return;
      done = true;
      resolve({ url, ok, ms: Date.now() - t0, ...extra });
    };
    try {
      const req = https.get(url, { timeout, headers: { 'User-Agent': 'SAFE-Forensic/1.0' } }, (res) => {
        res.resume();
        // Cualquier respuesta HTTP (incluso 4xx) prueba que el servicio es alcanzable.
        finish(res.statusCode > 0 && res.statusCode < 500, { status: res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); finish(false, { error: 'timeout' }); });
      req.on('error', (e) => finish(false, { error: e.code || e.message }));
    } catch (e) {
      finish(false, { error: e.message });
    }
  });
}

/** Comprueba conexión a internet y disponibilidad del servicio de sellado (OpenTimestamps). */
async function checkConnectivity({ calendars = CALENDARS, probes = INTERNET_PROBES } = {}) {
  const startedAt = new Date().toISOString();
  const [internetResults, calendarResults] = await Promise.all([
    Promise.all(probes.map((u) => probe(u))),
    Promise.all(calendars.map((u) => probe(u))),
  ]);
  const online = internetResults.some((r) => r.ok) || calendarResults.some((r) => r.ok);
  const calendarsUp = calendarResults.filter((r) => r.ok).length;
  return {
    checkedAt: startedAt,
    online,
    timestampService: { name: 'OpenTimestamps', available: calendarsUp > 0, up: calendarsUp, total: calendars.length, calendars: calendarResults },
    internet: internetResults,
  };
}

module.exports = { checkConnectivity, probe, setFetcher, CALENDARS };
