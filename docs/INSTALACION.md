# Descarga e instalación de S.A.F.E.

## 1. Requisitos

| Requisito | Detalle |
|---|---|
| Sistema | Windows 10/11, macOS 12+ o Linux (x64/arm64) |
| Node.js | 18 o superior (solo para ejecutar desde código fuente) — <https://nodejs.org> |
| ADB | Android platform-tools — <https://developer.android.com/tools/releases/platform-tools> |
| Dispositivo | Android con **Depuración USB** activada y cable de datos |
| Internet | Recomendado: para el sellado en blockchain (OpenTimestamps) |
| Opcional | `ffmpeg` en el PATH (genera copias `.mp4` de las grabaciones) |

## 2. Descargar

**Opción A — Instalador (cuando haya una versión publicada):** descargue el instalador de su sistema desde la
página *Releases* del repositorio (`https://github.com/custodydev/safe/releases`):
`.exe` (Windows), `.dmg` (macOS), `.AppImage` / `.deb` (Linux).

**Opción B — Desde el código fuente:**

```bash
git clone https://github.com/custodydev/safe.git
cd safe
npm install
```

## 3. Instalar ADB

1. Descargue *SDK Platform-Tools* para su sistema y descomprímalo.
2. Elija **una** de estas formas:
   - Añada la carpeta al `PATH` del sistema (`adb version` debe funcionar), **o**
   - Copie la carpeta como `platform-tools/` dentro del proyecto (se detecta sola y se incluye en los instaladores), **o**
   - Indique la ruta en la app: *Caso y ajustes → Ruta de ADB* (o variable `SAFE_ADB`).

Linux: `sudo apt install adb` también sirve. macOS: `brew install --cask android-platform-tools`.
Windows: puede necesitar el controlador USB del fabricante.

## 4. Preparar el dispositivo Android

1. *Ajustes → Acerca del teléfono* → pulse 7 veces **Número de compilación**.
2. *Ajustes → Sistema → Opciones de desarrollador* → active **Depuración USB**.
3. Conecte el cable; en el teléfono acepte **«¿Permitir depuración USB?»** (marque *Permitir siempre* si es su equipo).
4. Compruebe: `adb devices` debe mostrar el equipo como `device` (no `unauthorized`).

## 5. Ejecutar

```bash
npm start
```

## 6. Generar instaladores propios

```bash
# (opcional) coloque platform-tools/ en la raíz para incluir ADB en el instalador
npm run dist:win     # Windows (NSIS + portable)
npm run dist:mac     # macOS (.dmg)
npm run dist:linux   # AppImage + deb
```

Los instaladores quedan en `dist/`. Si no desea empaquetar ADB, cree una carpeta `platform-tools/` vacía
o elimine el bloque `extraResources` de `package.json`.
Linux sin entorno gráfico/root: ejecute `npx electron --no-sandbox .` si el sandbox de Chromium no está disponible.

## 7. Solución de problemas

| Síntoma | Solución |
|---|---|
| «No se encontró ADB» | Instale platform-tools y/o indique la ruta en *Ajustes*. Use *Probar ADB*. |
| Dispositivo `unauthorized` | Desbloquee el teléfono y acepte la huella RSA; si no aparece: *Revocar autorizaciones de depuración USB* y reconecte. |
| No aparece el dispositivo (Linux) | Reglas udev del fabricante o `sudo adb kill-server && adb start-server`. |
| La copia ADB sale vacía | No confirmó en el teléfono, hay contraseña de copia, o Android restringe `adb backup` (ver README). |
| Indicador «Sellado no disponible» | Sin Internet o calendarios caídos; puede extraer y sellar después. |
