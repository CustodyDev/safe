# Guía de uso de S.A.F.E.

Flujo recomendado: **Caso → Dispositivo → Extracción → Evidencias → Sellado definitivo**.

## 1. Barra superior
- **Caso**: caso activo.
- **Selector de dispositivo** y botón ⟳ para buscar.
- **Internet / Sellado OTS**: verde = disponible (p. ej. *3/4 calendarios*); rojo = no disponible. Se refresca cada 30 s.
  Es solo informativo: la comprobación **oficial** se hace y se registra antes de cada extracción.

## 2. Caso y ajustes (①)
1. Escriba el **identificador del caso**, el **examinador** y las **notas** (autorización, motivo).
2. Pulse **Crear / continuar caso** (o **Abrir caso existente…**). Todo se guarda en `Documentos/SAFE-Casos/<caso>/`.
3. En *Entorno* configure la ruta de ADB si no es automática y use **Probar ADB**.
4. Conecte el teléfono, pulse ⟳ y elíjalo: verá fabricante, modelo, nº de serie, Android y build.

> Sin caso abierto no se permite ninguna extracción.

## 3. Verificación previa (automática)
Cada vez que inicia una extracción, S.A.F.E. comprueba **Internet** y el **servicio de sellado**:
- **Todo correcto** → continúa y deja constancia.
- **Sin Internet** o servicio caído → aparece el aviso: *la extracción es viable, pero se recomienda estar conectado
  para validar la integridad en blockchain*. Elija **Cancelar** (y conéctese) o **Continuar de todos modos**
  (la evidencia quedará «Sin sellar» y se sellará después). Ambas decisiones se registran.

## 4. Copia de seguridad ADB (②)
1. Elija qué incluir (APK, almacenamiento compartido, OBB, apps del sistema).
2. **Iniciar copia de seguridad** → en el teléfono pulse **«Hacer una copia de seguridad de mis datos»** (sin contraseña).
3. Verá el tamaño recibido en tiempo real; **Cancelar** aborta. Al terminar se crea la evidencia `.ab`.

Para abrir el `.ab` use herramientas como *Android Backup Extractor* (`abe unpack`).

## 5. Pantalla en vivo (③)
0. Elija el **motor**:
   - **scrcpy** — interactivo, fluido; sube un servidor temporal a `/data/local/tmp/` (se borra al cerrar).
   - **ADB nativo** — *no sube ningún archivo al teléfono* y no permite interacción (observación pura). Usa `screenrecord`; cada 180 s se reinicia
     y se encadena en el mismo archivo (hueco ≈ 1 s, anotado en el informe). Preferible cuando el protocolo exige mínima huella.
1. Elija la **resolución** (1280 px es la más fluida; «Nativa» da máxima calidad) y si permite **interacción**.
2. **▶ Conectar pantalla**: aparece la pantalla del teléfono en directo (indicador de fps).
3. **Interactuar** (si está permitido): clic = toque; arrastrar = deslizar; rueda = desplazar; escribir con el teclado
   (la pantalla debe tener el foco); Esc = Atrás; botones ◀ ● ■ Vol± ⏻ bajo el teléfono.
4. **● Iniciar grabación / ■ Detener y sellar**: graba **un único archivo continuo** (sin cortes de 3 min). Al detener se
   calcula el hash, se sella y se genera el informe (duración, fotogramas, resolución y cronología de apps en primer plano).
5. **📷 Captura**: PNG instantáneo con miniatura en el informe.

> La interacción modifica el dispositivo; queda registrada (nº de acciones) en la cadena de custodia.
> Si la imagen se retrasa, baje la resolución; S.A.F.E. descarta fotogramas atrasados y pide uno clave para no acumular latencia.

## 6. Explorador de archivos (④)
1. Escriba una ruta o use los atajos (`/sdcard`, DCIM, Download…) y navegue con un clic en las carpetas (↑ sube).
2. **Marque** ficheros y/o carpetas.
3. **🔎 Calcular SHA-256 en el dispositivo**: el teléfono calcula el hash de cada fichero (carpetas incluidas) **sin copiarlo**;
   aparece en verde en la tabla. Este es el hash «de origen».
4. **⬇ Extraer seleccionados (con verificación)**: por cada fichero se confirma que no cambió (tamaño y fecha) o se
   recalcula, se copia conservando nombre y fecha, se recalcula el SHA-256 del archivo recibido y se **compara**.
   Si difiere, se reintenta una vez y queda registrado. Cada fichero es una evidencia (nombre original, sello, informe PDF
   con la sección «Verificación en origen»).

> Sin root solo se leen rutas de almacenamiento compartido (`/sdcard/...`). Carpetas muy grandes (>5000 ficheros) deben acotarse.

## 7. Evidencias (⑤)
Tabla con ID, **nombre de archivo**, tipo, SHA-256, fecha UTC y estado del sello:

| Estado | Significado |
|---|---|
| **Sin sellar** | No había conexión/servicio al extraer. |
| **Pendiente BTC** | Enviado a los calendarios; aún no anclado en Bitcoin (horas). |
| **Confirmado** | Anclado en un bloque de Bitcoin. |

- **Sellar / actualizar pruebas OTS**: sella lo «Sin sellar» y completa los «Pendiente» cuando ya están en Bitcoin. Regenera los informes.
  (Se vuelve a hacer la verificación previa.)
- **Verificar integridad**: recalcula el SHA-256 de todos los originales y lo compara con el registrado.
- **Informe** abre el PDF; **Carpeta** muestra la evidencia en el explorador.
- **Verificar sello**: ver §10.

## 8. Cadena de custodia (⑥)
Lista las operaciones (apertura, verificaciones previas, hashes, sellos, sesiones en vivo…). **Verificar cadena de hashes** detecta
si el registro fue alterado.

## 9. Finalizar caso (⑦)
Al terminar toda la extracción (sin sesión en vivo, grabación ni copia en curso), abra **Finalizar caso** y pulse **Finalizar y comprimir caso**:
1. Recalcula el SHA-256 de todas las evidencias y verifica la cadena de custodia.
2. Genera `MANIFEST.json` y `MANIFEST.sha256` (hash de cada archivo del caso).
3. Comprime **todo el caso** en `CASO_FINAL_<fecha>.zip` (junto a la carpeta del caso).
4. Calcula el SHA-256 del ZIP (`.zip.sha256`) y lo sella en OpenTimestamps (`.zip.ots`; la verificación previa de internet se repite).
5. **Validación final**: relee el ZIP completo y comprueba (a) que no está corrupto (CRC), (b) que cada archivo coincide con el manifiesto,
   (c) que cada original coincide con el hash registrado de su evidencia y (d) que el hash del ZIP no cambia. El resultado queda en
   `.zip.verificacion.json` y en la cadena de custodia.

Resultados: **OK**, **OK con avisos** (p. ej. evidencias sin sellar por falta de conexión; selle después con *Evidencias → Sellar*) o **FALLO** (alguna
comprobación de integridad no coincide: no use el paquete y revise el detalle). Las entradas de custodia posteriores al ZIP (`finalize.done`) quedan solo
en la carpeta del caso: la copia dentro del ZIP es un prefijo válido de la cadena.

Para verificar el ZIP por un tercero: `sha256sum CASO_FINAL_*.zip` = `.zip.sha256`, `ots verify CASO_FINAL_*.zip.ots`, y tras descomprimir
`sha256sum -c MANIFEST.sha256`.

## 10. ¿Cómo compruebo que el SHA-256 sellado en OpenTimestamps es el de mi caso?
**Dentro de S.A.F.E.** — *Evidencias → Verificar sello* en la fila. Muestra cuatro valores que deben ser idénticos:
1. SHA-256 del archivo **recalculado ahora**,
2. el del registro del caso (`evidence.json`),
3. el del archivo `.sha256`,
4. el hash **contenido dentro del `.ots`** (leído del propio fichero, sin red),

y el estado en Bitcoin (pendiente / confirmado con nº de bloque y fecha).

**De forma independiente (sin S.A.F.E.)**
1. `sha256sum IMG_2041.jpg` (Windows: `certutil -hashfile IMG_2041.jpg SHA256`) → debe coincidir con el informe PDF y el `.sha256`.
2. Con el cliente oficial (`pip install opentimestamps-client`), deje el `.ots` junto al original con el nombre
   `IMG_2041.jpg.ots` y ejecute `ots verify IMG_2041.jpg.ots`. Si el hash no coincide, falla con *«File does not match original!»*.
   Con `ots info IMG_2041.jpg.ots` se ve el hash sellado y la atestación (`PendingAttestation` o `BitcoinBlockHeaderAttestation`).
3. Web: arrastre el `.ots` y el original en <https://opentimestamps.org> .
4. Bitcoin: un sello «Confirmado» indica el bloque; verifíquelo en cualquier explorador (la fecha del bloque es la fecha probada).

Un sello nuevo estará «pendiente» hasta que el calendario lo ancle en Bitcoin (horas). Use *Sellar / actualizar pruebas OTS* después.

## 11. Buenas prácticas
- Documente la autorización y trabaje sobre una **copia** de la carpeta del caso para análisis.
- Mantenga el dispositivo cargado, en modo avión si procede, y sin bloqueo de pantalla durante la extracción.
- Haga el sellado definitivo (**Confirmado**) y conserve `.ots`, `.sha256`, PDF y `custody.log.jsonl` junto al original.
- Registre en las notas del caso cualquier incidencia (copia parcial, segmentos de vídeo, etc.).
