# Windows: distribución y confianza

El desarrollo 0.3.0 migra ClipDrop a Tauri 2. La última release publicada sigue siendo 0.2.1 (Electron); sus pruebas/escaneos no certifican el paquete nuevo. La migración se prepara localmente sin ejecutar apps/instaladores ni publicar releases.

El paquete previsto para Windows es `ClipDrop-Setup-x64-0.3.0.exe`, NSIS por usuario sin elevación requerida por ClipDrop. Incluye yt-dlp fijado por versión y SHA256. Windows usa WebView2: si no está instalado, el bootstrapper de Microsoft puede necesitar acceso a Internet. No se requiere instalar Python o Node para usar ClipDrop.

ClipDrop se abre desde Inicio. Nuestra plantilla NSIS elimina las opciones de abrir al finalizar y crear un acceso de escritorio, incluso en modo pasivo/silencioso. Las preferencias conservan `%APPDATA%\ClipDrop\preferences.json`, las descargas permanentes nunca se eliminan y los temporales sólo se limpian desde Config. Como los instaladores Electron y Tauri usan registros distintos, una instalación anterior puede quedar listada por separado; no se desinstala automáticamente durante esta migración.

## Firma y avisos

Aplicación e instalador continúan **sin firma Authenticode de editor**. El cambio de framework o formato, iconos y hashes no evita por sí solo SmartScreen. La firma y la reputación son asuntos separados del tamaño o rendimiento de Electron/Tauri.

El aviso informal del primer usuario Windows no fue identificado. No se concluye que fuera SmartScreen, Defender, malware ni un falso positivo. Si aparece una detección con nombre, hace falta conservar nombre, archivo y hash afectados e investigar ese caso. No desactivar protecciones ni agregar exclusiones como solución.

Copiar archivos usa CF_HDROP nativo mediante Rust; no ejecuta PowerShell, JXA ni `ExecutionPolicy Bypass`. Los SHA256 verifican integridad y procedencia, no ausencia de malware ni reputación.

## Verificaciones

Las pruebas locales usan archivos sintéticos y un descargador falso. El motor y portapapeles tienen verificación de compilación Windows; ejecutarlos, probar el roundtrip real y generar/verificar el instalador requieren un entorno Windows. La CI quedó preparada para hacerlo; no se ejecutó como consecuencia de los cambios locales.

El verificador extrae el NSIS con 7-Zip sin ejecutarlo y comprueba cabecera, arquitectura, coincidencia del ejecutable con el build, motor fijado y sus licencias. Defender intenta escanear por separado la carpeta `win-unpacked` y el EXE NSIS; `defender-report.json` distingue `completed`, `skipped` y `detected`. Un scan omitido no equivale a resultado limpio; un scan completado tampoco garantiza aceptación por todos los antivirus o SmartScreen. No se ejecuta interactivamente el instalador.

## Microsoft Store, repositorio privado y costo

La vía gratuita aplicable es **MSIX distribuido mediante Microsoft Store**, tras registro/verificación de identidad y certificación. Se entrega el paquete compilado y no hace falta publicar el repositorio. Microsoft firma ese paquete y administra distribución/actualizaciones. Es posible ocultarlo de búsquedas y compartir el enlace; esa visibilidad no equivale a restringir quién puede descargarlo si tiene el enlace.

El beneficio para un proyecto personal es compartirlo e instalar actualizaciones con menos fricción y sin contratar certificados. Publicarlo no produce ingresos automáticamente ni garantiza usuarios o aprobación. Hay trabajo de empaquetado, ficha, políticas y mantenimiento de cada entrega.

La Store **no firma los instaladores MSI/EXE**, incluido nuestro NSIS. La firma gratuita de Store no proporciona un certificado reutilizable para firmar el EXE publicado en GitHub. SignPath Foundation exige condiciones open source incompatibles con ClipDrop privado/UNLICENSED; autofirmar sirve para pruebas o confianza administrada, no resuelve la confianza pública.

No se eligió/publicó MSIX, registró una cuenta, contrató firma ni cambió repositorio/licencia como parte de la migración.

Referencias: [firma de Windows](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [publicación y MSIX](https://learn.microsoft.com/en-us/windows/apps/publish/get-started), [visibilidad por enlace](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options), [reputación SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation), [condiciones SignPath](https://signpath.org/terms).
