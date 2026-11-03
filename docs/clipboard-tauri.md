# Portapapeles de archivos en Tauri

Verificación de la migración, 2026-11-03. La implementación está en `crates/clipdrop-clipboard` y se usa desde el backend Rust; no requiere Electron, Node, PowerShell ni JXA.

## Formatos nativos

- **Windows:** una lista `CF_HDROP` con estructura `DROPFILES`, rutas UTF-16 terminadas en NUL y doble NUL final. `clipboard-win` 5.4.3 implementa la escritura y lectura mediante Win32. Se crea un owner `HWND_MESSAGE` invisible y de corta vida para asociar `OpenClipboard`/`EmptyClipboard` a un HWND válido. No abre una ventana visible ni inicia la aplicación. Los archivos se escriben con datos inmediatos en memoria global, sin promesas de renderizado diferido.
- **macOS:** `NSPasteboard.writeObjects` recibe objetos `NSURL.fileURLWithPath`; genera un ítem `public.file-url` por archivo. Se usa AppKit/Foundation mediante `objc2`/`objc2-app-kit`, sin scripts auxiliares. Las comprobaciones contemplan la normalización Unicode que aplica Foundation a los nombres.

Se validan todas las rutas antes de escribir: absolutas, UTF-8 válido sin NUL, archivos existentes y no directorios. Las rutas se resuelven antes de generar las referencias. No se copian bytes del video al portapapeles: se referencia un archivo en disco. Copiar un video usa almacenamiento temporal; los archivos deben seguir existiendo y la aplicación receptora debe aceptar archivos pegados.

## Limpieza

`clear_if_within(root)` sólo considera una lista de archivos donde cada referencia pertenece tanto lógica como físicamente a la raíz temporal. Conserva listas de archivos externos y contenido mixto, texto, imágenes y formatos desconocidos.

En Windows, `OpenClipboard` mantiene exclusión nativa durante la inspección de formatos, lectura, validación y limpieza. En Mac se captura `changeCount` y se vuelve a comprobar inmediatamente antes de limpiar, sin awaits ni callbacks entre la comprobación final y `clearContents`. AppKit no proporciona una operación compare-and-swap para limpiar: existe una carrera nativa mínima si otra aplicación cambia el portapapeles exactamente entre esas dos llamadas. No se promete atomicidad frente a otras aplicaciones en macOS.

## Evidencia y límites

Ejecutado localmente en Mac Apple Silicon, sin abrir ClipDrop ni usar el portapapeles cotidiano:

```sh
cargo test -p clipdrop-clipboard
cargo check -p clipdrop-clipboard --target x86_64-pc-windows-gnu --all-targets
```

Las seis pruebas incluyen validación de rutas, Unicode/espacios/emoji, un roundtrip nativo Mac con dos archivos en `NSPasteboard.pasteboardWithUniqueName`, limpieza dentro de una raíz con Unicode, preservación de contenido mixto/externo y preservación de texto reemplazado después del snapshot. Todos los tests AppKit utilizan pasteboards privados con nombre, nunca `generalPasteboard`.

El código Windows, sus tests y su binario de smoke compilan para `x86_64-pc-windows-gnu`. Esto **no** demuestra ejecución real en Windows. Queda preparado este roundtrip finito para un runner Windows/Mac aislado:

```sh
cargo run -p clipdrop-clipboard --bin clipboard-smoke
```

El smoke exige `CI=true`: reemplaza el portapapeles de ese runner, escribe sólo fixtures sintéticos propios, comprueba el formato nativo y su lectura, verifica preservación de texto (y contenido mixto en Windows), limpia los fixtures y termina. No abre ClipDrop ni descarga videos. No se ejecutó localmente contra el portapapeles general ni se ejecutó en Windows durante esta verificación. El pegado en Discord/WhatsApp sigue dependiendo de cada receptor y requiere una comprobación interactiva posterior.

## Fuentes primarias

- [Win32: OpenClipboard y requisito de owner al limpiar](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard).
- [Win32: formatos estándar y CF_HDROP](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats).
- [clipboard-win: FileList corresponde a CF_HDROP](https://docs.rs/clipboard-win/5.4.3/clipboard_win/formats/struct.FileList.html).
- [Fuente de escritura DROPFILES y lectura nativa](https://docs.rs/clipboard-win/5.4.3/src/clipboard_win/raw.rs.html).
- [Apple: NSPasteboard.writeObjects](https://developer.apple.com/documentation/appkit/nspasteboard/writeobjects(_:)).
- [Apple: changeCount](https://developer.apple.com/documentation/appkit/nspasteboard/changecount).
- [Bindings de NSPasteboard y conformidad NSURL a NSPasteboardWriting](https://docs.rs/objc2-app-kit/0.3.2/src/objc2_app_kit/generated/NSPasteboard.rs.html).
