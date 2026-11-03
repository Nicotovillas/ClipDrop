<p align="center">
  <img src="src/front/icon.svg" width="112" height="112" alt="ClipDrop">
</p>

<h1 align="center">ClipDrop</h1>

<p align="center">
  Descargá videos o copialos para pegarlos en otra app.
</p>

<p align="center">
  <a href="https://github.com/Nicotovillas/ClipDrop/releases/download/v0.3.0/ClipDrop-Setup-x64-0.3.0.exe"><strong>Descargar para Windows</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Nicotovillas/ClipDrop/releases/download/v0.3.0/ClipDrop-Mac-arm64-0.3.0.zip"><strong>Descargar para Mac</strong></a>
</p>

<p align="center">
  <a href="https://github.com/Nicotovillas/ClipDrop/releases/tag/v0.3.0">v0.3.0</a>
  &nbsp;·&nbsp; Windows x64 y Mac Apple Silicon
</p>

---

## Instalación

**Windows:** ejecutá el instalador y abrí ClipDrop desde Inicio. Incluye yt-dlp.

**Mac:** extraé el ZIP y abrí `ClipDrop.app`. Instalá el motor desde Terminal:

```sh
brew install yt-dlp ffmpeg
```

## Cómo usarlo

1. Elegí tu carpeta de descarga en **Config**; queda guardada.
2. Pegá un enlace en **Descarga**.
3. Elegí **Descargar** o **Copiar video**.

**Copiar video usa un archivo temporal en disco.** La app donde lo pegues debe aceptar archivos. Podés liberar ese espacio desde **Config → Temporales**; tus descargas guardadas se conservan.

Si el sitio pide sesión, elegí tu navegador en **Config → Opciones avanzadas**.

## Desarrollo

- `src/front/`: interfaz HTML, CSS y JavaScript.
- `src/back/`: backend Rust, configuración e instalador.
- `scripts/`: herramientas de desarrollo, empaquetado y verificación.

[Guía de desarrollo y distribución](scripts/README.md). Hecho con Tauri y yt-dlp.

Windows sigue sin firma de editor y Mac sin notarización de Apple.

Repositorio privado. Uso personal, sin licencia pública otorgada.
