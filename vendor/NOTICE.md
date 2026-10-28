# Componentes de terceros

## scrcpy-server v3.3.3
- Origen: https://github.com/Genymobile/scrcpy/releases/tag/v3.3.3
- Licencia: Apache License 2.0 — © Genymobile
- SHA-256: `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`

S.A.F.E. lo usa para la **pantalla en vivo interactiva** (flujo H.264 sin conversión + control). Se copia
temporalmente a `/data/local/tmp/` del dispositivo durante la sesión y se elimina al cerrar (`cleanup=true`).
S.A.F.E. verifica el SHA-256 anterior antes de cada subida y lo registra en la cadena de custodia.
