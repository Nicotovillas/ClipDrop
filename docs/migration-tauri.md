# Migración a Tauri 2 — verificación local

Fecha: 2026-11-03. Desarrollo 0.3.0; release pública previa 0.2.1 sin cambios. No se abrió ClipDrop ni servidores, navegadores, instaladores o sesiones; no se descargaron videos ni se publicó/subió código o paquetes.

## Cambios

- Interfaz HTML/CSS/JavaScript conservada: 560×300, logo, tabs Descarga/Config, controles, progreso y resultados. Se reemplaza sólo el puente Electron por comandos/eventos Tauri.
- Backend Rust: motor yt-dlp, cancelación del árbol, preferencias, temporales y portapapeles nativo. No hay sidecar Node ni shell para copiar.
- Preferencias en la misma ubicación que Electron y temporales en la misma raíz del sistema. Sólo se eliminan trabajos temporales propios; las descargas permanentes se preservan.
- Cargo.lock y package-lock.json fijan dependencias. Electron/electron-builder se eliminaron del código activo y del lock npm.
- NSIS Tauri por usuario con plantilla local sin apertura posterior ni acceso de escritorio. No se ejecutó ni generó el instalador Windows localmente.
- CI adaptada para builds, tests y smoke nativo finito, sin iniciar la app. No se ejecutó ni publicó esa CI durante esta tarea.

## Evidencia ejecutada

| Control | Resultado |
| --- | --- |
| `npm run check` | Sintaxis JS, rustfmt y cargo check correctos en Mac |
| `npm test` y prueba focalizada posterior a endurecer la integración | 31 tests: 8 UI/bridge, 8 comandos/servicio, 6 portapapeles, 9 motor/almacenamiento |
| Roundtrip Mac | NSPasteboard privado con NSURL/public.file-url, varios archivos y Unicode, sin alterar portapapeles general |
| `cargo check -p clipdrop-clipboard --target x86_64-pc-windows-gnu --all-targets` | Correcto; compila biblioteca, smoke y tests, sin ejecución Windows |
| `cargo check -p clipdrop-core --target x86_64-pc-windows-gnu --all-targets` | Correcto; compila motor, fixture y tests, sin ejecución Windows |
| Check de app Windows completa desde Mac | Se detuvo en tauri-winres por falta de `x86_64-w64-mingw32-windres`; no se declara pasado |
| `npm run build:mac` | Compilación release arm64 y bundle `.app`, sin ejecutarlo |
| `file` / `plutil` | Mach-O arm64, nombre ClipDrop, versión 0.3.0, identificador `local.nit.clipdrop` |
| Colector y `codesign --verify --deep --strict` | Bundle sellado con firma ad hoc local y válido en disco; sin Developer ID/notarización |
| `npm run checksums` | SHA256 del ZIP generado en `dist/SHA256SUMS-0.3.0.txt` |
| Revisión independiente delimitada | Sin hallazgos accionables estáticos; no reemplaza ejecución de plataforma |

El ZIP Mac previo medido localmente ocupa 117.066.162 bytes; el Tauri ronda 2,6 MB. Esta comparación es sólo de tamaño de distribución. No se midió consumo de RAM ni latencia de arranque.

## Pendiente antes de distribuir Windows

1. Build Windows x64/MSVC, tests y roundtrip nativo de CF_HDROP en un runner Windows.
2. Extraer/verificar el nuevo NSIS y ejecutar el scanner disponible, distinguiendo cobertura omitida de scan completado.
3. Prueba manual autorizada de instalación, interfaz y pegado en receptores concretos. También queda pendiente la comprobación visual/interactiva de la app Mac.
4. Resolver firma por separado: NSIS sigue sin Authenticode. Store/MSIX es una posibilidad, no una publicación autorizada o realizada.

El instalador Tauri no migra/desinstala automáticamente el registro del instalador Electron; puede aparecer una instalación anterior separada. Las preferencias se reutilizan y la desinstalación no debe borrar descargas guardadas.

La [nota de portapapeles](clipboard-tauri.md) documenta las APIs, tests y el límite de atomicidad de limpieza en NSPasteboard.

## Primera ejecución remota autorizada

En una tarea posterior se autorizó subir la migración al repo privado y correr CI, sin abrir la app ni publicar release. El commit `2b1a2c391b2db1878a8b4bf707845290d4deba67` disparó [CI 41707672169](https://github.com/Nicotovillas/ClipDrop/actions/runs/41707672169): Mac terminó correctamente; Windows pasó check MSVC, 26 pruebas y el roundtrip CF_HDROP nativo, y generó NSIS. Falló después la comparación estática del ejecutable extraído.

La causa está documentada en [tauri-bundler 2.12.4](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle.rs): sustituye el primer `__TAURI_BUNDLE_TYPE_VAR_UNK` por `__TAURI_BUNDLE_TYPE_VAR_NSS` antes de empaquetar y restaura el binario sin modificar al terminar. El verificador ahora reproduce sólo esa sustitución y compara SHA256 del archivo completo. La carpeta preparada para Defender debe coincidir exactamente con el payload extraído. Se agregaron tres pruebas de regresión, incluidos cambios ajenos al marcador que deben rechazarse. No se ejecutó el instalador.
