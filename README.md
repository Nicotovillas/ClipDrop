# ClipDrop

Descargá videos o copialos para pegarlos en otra app. Hecho con Tauri y yt-dlp.

## Descargar v0.3.0

- [Windows x64 — instalador](https://github.com/Nicotovillas/ClipDrop/releases/download/v0.3.0/ClipDrop-Setup-x64-0.3.0.exe)
- [Mac Apple Silicon — ZIP](https://github.com/Nicotovillas/ClipDrop/releases/download/v0.3.0/ClipDrop-Mac-arm64-0.3.0.zip)

Windows incluye yt-dlp. En Mac, instalá el motor con `brew install yt-dlp ffmpeg`.

## Usar

1. Abrí ClipDrop y elegí tu carpeta en **Config**.
2. Pegá un enlace en **Descarga**.
3. Elegí **Descargar** o **Copiar video**.

**Copiar video usa un archivo temporal en disco.** La app donde lo pegues debe aceptar archivos. Podés liberar ese espacio desde **Config → Temporales**; tus descargas guardadas se conservan.

Si el sitio pide sesión, elegí tu navegador en **Config → Opciones avanzadas**.

## Código

- `src/`: interfaz HTML, CSS y JavaScript.
- `src-tauri/`: backend Rust, configuración e instalador.
- `scripts/`: herramientas de desarrollo, empaquetado y verificación.

[Desarrollo y distribución](scripts/README.md). Windows sigue sin firma de editor y Mac sin notarización de Apple.

Repositorio privado. Uso personal, sin licencia pública otorgada.
