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
- **● Iniciar grabación**: muestra la pantalla en directo y graba. Cada ~3 min se cierra un segmento (evidencia propia)
  y arranca otro automáticamente. **■ Detener** finaliza, hashea, sella y genera el informe de cada segmento.
- **📷 Captura de pantalla**: PNG instantáneo con miniatura en el informe.
- **App en primer plano**: muestra el paquete/actividad con foco (`dumpsys window`). El informe de capturas lo incluye y el de vídeos
  añade la **cronología** de apps durante la grabación.

## 6. Archivos multimedia (④)
1. Escriba la ruta (o use los atajos DCIM, Pictures, Download, Movies, WhatsApp).
2. **Extraer y registrar**: se copian los archivos con sus fechas originales y **cada uno** genera su evidencia
   (nombre original intacto, SHA-256, sello, informe con miniatura si es imagen).

> Carpetas con miles de archivos generan miles de informes: acote la ruta.

## 7. Navegador interno (⑤)
1. Escriba una URL y pulse Intro (sesión aislada, sin permisos de cámara/ubicación).
2. **Capturar y sellar** guarda 2 evidencias: la **captura PNG** y la **página archivada (.mhtml)**, con URL y título.

## 8. Evidencias (⑥)
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

## 9. Cadena de custodia (⑦)
Lista las operaciones (apertura, verificaciones previas, hashes, sellos…). **Verificar cadena de hashes** detecta
si el registro fue alterado.

## 10. Verificación independiente (por un tercero)
1. Calcule el SHA-256 del archivo original (`sha256sum archivo`) y compárelo con el `.sha256` y el informe.
2. Verifique el sello: instale el cliente oficial (`pip install opentimestamps-client`) y ejecute con el hash:
   `ots verify archivo.ots` (con el archivo original junto a un `.ots` que se llame `<archivo>.ots`).
   Es válido aunque S.A.F.E. no esté instalado.

## 11. Buenas prácticas
- Documente la autorización y trabaje sobre una **copia** de la carpeta del caso para análisis.
- Mantenga el dispositivo cargado, en modo avión si procede, y sin bloqueo de pantalla durante la extracción.
- Haga el sellado definitivo (**Confirmado**) y conserve `.ots`, `.sha256`, PDF y `custody.log.jsonl` junto al original.
- Registre en las notas del caso cualquier incidencia (copia parcial, segmentos de vídeo, etc.).
