# Avisos de Windows

Desde 0.2.1, la descarga principal de Windows es `ClipDrop-Setup-x64-0.2.1.exe`: un instalador NSIS por usuario, sin elevación a administrador. Instala la app y yt-dlp; no requiere extraer un ZIP ni instalar herramientas externas. ClipDrop se abre desde el menú Inicio y puede desinstalarse desde Configuración de Windows. No crea un acceso directo en el escritorio ni abre la app al terminar. Las preferencias del usuario se conservan al actualizar y desinstalar; las descargas guardadas no se eliminan.

El formato instalador no sustituye la firma de editor ni evita por sí mismo los avisos de Windows.

El aviso que recibió el primer usuario de Windows no fue identificado: sólo se dispone de su descripción informal. No se concluye que fuera SmartScreen, una detección de Defender o un falso positivo.

**SmartScreen y editor desconocido.** ClipDrop todavía no cuenta con una firma Authenticode de editor. Microsoft explica que una aplicación nueva puede mostrar advertencias por falta de reputación, incluso si está firmada. Subirla a GitHub, agregar un icono o publicar hashes no sustituye una firma ni garantiza quitar ese aviso. La firma requiere validar una identidad y disponer de un certificado/servicio apropiado; no se contrató ninguno.

**Detección de malware.** Si Defender muestra una amenaza con nombre, hace falta conservar el nombre, archivo y hash afectados y evaluar ese caso concreto. No darlo por seguro ni asumir un falso positivo. No desactivar Defender/SmartScreen ni agregar exclusiones como solución.

Desde 0.2.0, ClipDrop usa directamente la API de archivos del portapapeles de Electron: no ejecuta PowerShell, JXA ni `ExecutionPolicy Bypass` para copiar. El EXE incorpora nombre/producto/versión/icono propios, se ejecuta con permisos del usuario y el motor oficial se fija por versión y SHA256. Son mejoras verificables de distribución; no demuestran que el aviso anterior haya desaparecido.

Cada paquete publicado incluye su SHA256. El motor yt-dlp se descarga del release oficial fijado en `tools/yt-dlp.json`; sus binarios y licencias se verifican antes del empaquetado. Los SHA256 comprueban integridad, no ausencia de malware ni reputación SmartScreen.

La compilación de GitHub ejecuta pruebas y un roundtrip nativo de archivos del portapapeles en Windows y Mac. En Windows intenta además escanear con Defender dos rutas: la carpeta `win-unpacked` y el EXE del instalador NSIS. El informe `defender-report.json` identifica cada ruta, su cobertura y resultado: `completed`, `skipped` o `detected` (este último hace fallar la compilación). El estado general sólo es `completed` si ambos escaneos terminaron. La verificación estática comprueba la cabecera NSIS y los binarios/fuentes del paquete; no instala, ejecuta ni prueba interactivamente el instalador. Un escaneo omitido no equivale a resultado limpio; ni siquiera un escaneo completado garantiza aceptación por todos los antivirus o por SmartScreen.

Referencias oficiales: [reputación SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation), [opciones de firma](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [archivos en el portapapeles de Electron](https://www.electronjs.org/docs/latest/api/clipboard-item#files-the-texturi-list-mime-type).
