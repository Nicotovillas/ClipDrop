<img src="assets/icon.svg" width="64" height="64" alt="ClipDrop">

# ClipDrop

Una app de escritorio pequeña para descargar videos con yt-dlp. Windows es la plataforma principal; Mac Apple Silicon es secundaria.

El código de desarrollo **0.3.0 migra a Tauri 2**: Rust para el motor y la integración con el sistema, y la misma interfaz HTML/CSS/JavaScript de 560×300 con pestañas Descarga/Config. No incluye Electron, Chromium propio ni Node como runtime. Windows usa WebView2 y Mac usa WKWebView del sistema. Esto no acelera por sí mismo la descarga de yt-dlp.

La última versión publicada sigue siendo [0.2.1 (Electron)](https://github.com/Nicotovillas/ClipDrop/releases/tag/v0.2.1). La migración no se publicó y sus resultados de verificación no heredan los de esa release.

## Usar

1. Abrir ClipDrop desde Inicio en Windows o desde `ClipDrop.app` en Mac.
2. En **Config**, elegir la carpeta de descarga; queda guardada.
3. En **Descarga**, pegar el enlace y elegir **Descargar** o **Copiar video**.

Windows mantiene un instalador NSIS por usuario y el motor oficial yt-dlp incluido. El instalador Tauri no inicia la app ni crea un acceso en el escritorio. Si falta WebView2, su bootstrapper puede necesitar Internet para instalar ese runtime de Microsoft. En Mac se usa `brew install yt-dlp ffmpeg`.

Las preferencias mantienen su ubicación anterior: `%APPDATA%\ClipDrop\preferences.json` en Windows y `~/Library/Application Support/ClipDrop/preferences.json` en Mac. Las descargas guardadas se conservan. Al cambiar de instalador Electron a Tauri puede quedar la instalación anterior registrada por separado: esta migración no ejecuta ni desinstala automáticamente la versión anterior. Ambos formatos conservan la carpeta de preferencias indicada.

**Copiar video usa disco temporal:** descarga el archivo y coloca su referencia nativa en el portapapeles (CF_HDROP en Windows, NSURL/public.file-url en Mac). No copia sólo el texto de la ruta. Los archivos sobreviven al cierre y ocupan espacio hasta **Config → Temporales → Eliminar**. Discord, WhatsApp u otra app deben aceptar archivos pegados; también puede abrirse la carpeta y arrastrarlos. Limpiar los temporales impide pegar esos archivos después; las descargas permanentes se preservan.

Si un sitio requiere sesión, elegir el navegador en **Config → Opciones avanzadas**. Sólo al descargar con esa opción yt-dlp lee sus cookies; no se exportan archivos de cookies ni se guarda historial de enlaces. FFmpeg es opcional: permite fusionar pistas separadas; sin él se elige un formato con audio y video combinados.

## Desarrollo

Node 22+, Rust estable con rustfmt y las [dependencias nativas de Tauri](https://v2.tauri.app/start/prerequisites/). Mac requiere Xcode/Command Line Tools; Windows requiere las herramientas C++ de MSVC y WebView2. Node sólo prepara assets y ejecuta herramientas de desarrollo.

```sh
npm ci
npm test
npm run check
```

Estas verificaciones son finitas y no abren la app, servidores ni navegadores. Usan archivos sintéticos, un CLI ficticio compilado en Rust y un pasteboard privado en Mac; no descargan videos ni leen sesiones reales ni reemplazan el portapapeles cotidiano.

Sólo para abrir la app voluntariamente:

```sh
npm start
```

No se necesita servidor web: Tauri carga assets estáticos locales. La interfaz se prepara con `npm run prepare:ui` en `.build/frontend`.

Para compilar sin abrir la app:

```sh
# En Windows x64 con MSVC
npm run build:windows
npm run verify:windows

# En Mac (agregar target si el host es Intel)
rustup target add aarch64-apple-darwin
npm run build:mac
npm run checksums
```

Los paquetes quedan en `dist/ClipDrop-Setup-x64-0.3.0.exe` y `dist/ClipDrop-Mac-arm64-0.3.0.zip`. No se ejecutan instaladores durante los controles. El icono conserva su SVG y los PNG/ICO/ICNS incluidos; `npm run build:icons` permite regenerarlos.

El colector Mac sella el bundle y sus recursos con firma **ad hoc local** y la verifica antes de comprimir. No es Developer ID ni notarización de Apple y no concede confianza pública.

El motor Windows sigue fijado por versión/SHA256 en `tools/yt-dlp.json`. Se incluyen sus licencias y procedencia y se verifica su hash antes de empaquetar. El instalador NSIS usa una plantilla de Tauri conservada localmente para quitar apertura automática y accesos de escritorio; su fuente y licencia están en `src-tauri/installer.nsi` e `installer-LICENSE.txt`.

## Verificación y límites

- UI y puente: pruebas DOM sin navegador ni GUI.
- Rust: motor, argumentos, progreso, drenaje de pipes, rutas/escapes, errores, cancelación del árbol de procesos, preferencias, exclusión entre operaciones y preservación de archivos.
- Mac: roundtrip nativo en pasteboard privado con varios archivos y Unicode; texto, contenido mixto y archivos ajenos se conservan al limpiar. [Evidencia de portapapeles](docs/clipboard-tauri.md).
- Windows: la capa nativa y el motor se verifican por compilación cruzada; el roundtrip real y el instalador requieren Windows. La CI está preparada para compilarlos y probarlos, sin haberla ejecutado/publicado como parte de la migración local.
- La CI ejecuta un roundtrip del portapapeles general en su escritorio aislado, sin ventana visible. El binario `clipboard-smoke` lo rechaza fuera de `CI=true`; no debe usarse para reemplazar el portapapeles de desarrollo.
- El verificador Windows extrae NSIS con 7-Zip, compara el ejecutable con el build y verifica motor, hash y licencias, sin ejecutar payload. Defender registra por separado la carpeta preparada y el instalador.

Estos controles no prueban interactivamente todos los receptores, sitios o antivirus, ni miden memoria/arranque de la app abierta. La app no se inicia automáticamente para verificarlos.

Resultado de la migración local: 31 pruebas pasadas, `npm run check` correcto y bundle Mac arm64 compilado e inspeccionado sin abrirlo. La comprobación completa de la app Windows desde Mac se detuvo por falta de `x86_64-w64-mingw32-windres`; no sustituye el build/roundtrip pendiente en Windows. [Registro de verificación](docs/migration-tauri.md).

## Firma y Microsoft Store

Aplicación e instalador siguen **sin firma Authenticode de editor**. Migrar a Tauri no cambia esa confianza. [Detalle de Windows](WINDOWS.md).

Microsoft Store es una opción para distribuir un futuro paquete MSIX firmado por Microsoft, conservando el repositorio privado. Aporta instalación/actualizaciones administradas, firma gratuita y distribución por enlace; no genera ingresos por sí solo. Requiere cuenta, verificación de identidad y certificación. No firma gratuitamente el instalador NSIS de GitHub. Aún no se preparó/subió un MSIX ni se registró o publicó ClipDrop en la Store.

## Dependencias y licencias

Fuente de ClipDrop: uso personal, sin licencia pública otorgada (`UNLICENSED`). Repositorio privado. Las dependencias mantienen sus licencias; no se modifica el ejecutable oficial de yt-dlp. [Tauri](https://tauri.app/), [yt-dlp](https://github.com/yt-dlp/yt-dlp), [licencias de sus releases](https://github.com/yt-dlp/yt-dlp#licensing).
