# Desarrollo y distribución

Requisitos: Node 22+, Rust estable con rustfmt y las [dependencias de Tauri](https://v2.tauri.app/start/prerequisites/). En Windows se necesita MSVC y WebView2; en Mac, Xcode/Command Line Tools.

```sh
npm ci
npm test
npm run check
```

Los tests son finitos y no abren ClipDrop. Usan un descargador ficticio y archivos sintéticos; no descargan videos ni leen sesiones. Las pruebas Mac usan un pasteboard privado y preservan el portapapeles habitual. `npm start` abre la app sólo cuando se ejecuta voluntariamente; no hay servidor web de desarrollo.

## Estructura

`ui/` contiene sólo los archivos de la interfaz que se incluyen en la ventana. `desktop/` agrupa un único paquete Rust/Tauri con su código en `desktop/src/`, configuración y recursos nativos.

`app.rs` prepara la ventana y el ciclo de vida. `commands.rs` adapta acciones y respuestas de la interfaz, valida su origen y muestra diálogos. `state.rs` controla las operaciones, cancelación, preferencias y resultados: conserva privados la sesión y los temporales, y devuelve resultados tipados. `engine.rs` ejecuta yt-dlp, `storage.rs` administra temporales y `clipboard/` implementa las APIs de Windows y Mac; estos tres módulos no dependen de Tauri.

Las pruebas Rust están en `desktop/tests/`; las de interfaz y herramientas, en `scripts/tests/`. La opción Rust `test-tools` habilita exclusivamente el CLI ficticio y el smoke del portapapeles. Los builds de distribución no la activan y compilan sólo ClipDrop.

## Paquetes

En cada plataforma:

```sh
npm run build:windows   # Windows x64/MSVC
npm run verify:windows # Inspecciona NSIS con 7-Zip, sin ejecutarlo
npm run build:mac      # Mac; rustup target add aarch64-apple-darwin si hace falta
```

Los paquetes y sus SHA256 se generan en `dist/`. `npm run build:icons` genera los íconos de distribución desde `ui/icon.svg`.

Los scripts comparten las ubicaciones en `paths.cjs`. Para encontrar los binarios consultan los metadatos de Cargo desde `desktop/`, igual que Tauri, respetando su configuración de salida y `CARGO_TARGET_DIR`.

El motor Windows se fija por versión/SHA256 en `desktop/resources/yt-dlp.json`; su preparación comprueba el binario oficial y conserva licencias/procedencia. El NSIS instala por usuario, crea la entrada de Inicio y no abre la app ni crea un acceso en el escritorio. Su plantilla y licencia están en `desktop/installer/`.

El verificador contempla únicamente la sustitución del marcador NSIS que realiza Tauri y exige coincidencia del resto del ejecutable, del motor y del staging escaneado. El colector Mac sella el bundle con firma ad hoc local y la comprueba antes de comprimir; no equivale a Developer ID o notarización.

## Datos y portapapeles

Las preferencias mantienen `%APPDATA%\ClipDrop\preferences.json` en Windows y `~/Library/Application Support/ClipDrop/preferences.json` en Mac. Cambiar desde el instalador Electron puede dejar una instalación anterior registrada por separado; no se desinstala automáticamente.

Copiar escribe referencias nativas a archivos temporales: `CF_HDROP` en Windows y `NSURL/public.file-url` en Mac. Los archivos ocupan disco y deben existir hasta terminar de pegarlos; la aceptación depende del receptor. La limpieza sólo elimina trabajos temporales propios y conserva descargas permanentes.

Windows bloquea el portapapeles mientras comprueba y limpia. Mac comprueba `changeCount` justo antes de limpiar; NSPasteboard no ofrece una operación atómica de comparación y limpieza frente a otras aplicaciones.

## CI y confianza

La CI ejecuta pruebas, un roundtrip nativo con archivos sintéticos en su escritorio aislado, builds y verificaciones estáticas. El smoke exige `CI=true` y no debe ejecutarse sobre el portapapeles de uso cotidiano. Defender informa por separado cobertura y resultado del instalador y el payload; un escaneo omitido no equivale a uno completado. Los instaladores y apps no se abren durante estos controles.

Windows sigue sin Authenticode: iconos, hashes, Tauri y escaneos no eliminan SmartScreen ni garantizan aceptación por todos los antivirus. El aviso informal de la primera versión no se identificó. Una detección con nombre debe investigarse conservando archivo y hash; no se desactivan protecciones como solución.

Store/MSIX permite firma gratuita después de certificación conservando el repositorio privado; no firma el EXE NSIS de GitHub. No se registró ni publicó ClipDrop en la Store. [Microsoft](https://learn.microsoft.com/en-us/windows/apps/publish/get-started).

Las releases usan los artefactos exactos de una CI aprobada y el mismo commit probado. El workflow de adjuntos valida commit, nombres y SHA256 antes de subirlos a un borrador.
