'use strict';
const fs = require('fs');
const { checkConnectivity } = require('./net');

const OFFLINE_WARNING =
  'No hay conexión a internet. La extracción es viable, pero se recomienda estar conectado para validar la integridad en blockchain a través de la API de sellado (OpenTimestamps). Las evidencias quedarán marcadas como «pendientes de sellar» y podrá sellarlas después desde la pestaña Evidencias.';
const SERVICE_WARNING =
  'Hay conexión a internet pero el servicio de sellado en blockchain (OpenTimestamps) no está disponible en este momento. La extracción es viable; las evidencias quedarán pendientes de sellar.';

/**
 * Verificación previa obligatoria. Deja constancia en preflight/ y en el registro de custodia.
 * Devuelve {online, timestampService, warning|null, ...}.
 */
async function runPreflight(store, action, check = checkConnectivity) {
  const res = await check();
  res.action = action;
  res.warning = !res.online ? OFFLINE_WARNING : !res.timestampService.available ? SERVICE_WARNING : null;
  res.degraded = !!res.warning;
  if (store) {
    const name = `${res.checkedAt.replace(/[:.]/g, '-')}_${action}.json`;
    fs.writeFileSync(store.preflightFile(name), JSON.stringify(res, null, 2));
    store.log('preflight', { action, online: res.online, timestampService: res.timestampService.available, up: res.timestampService.up, file: name });
  }
  return res;
}

module.exports = { runPreflight, OFFLINE_WARNING, SERVICE_WARNING };
