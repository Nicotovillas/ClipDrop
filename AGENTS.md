# ClipDrop

App personal Tauri 2 (Rust + HTML/CSS/JavaScript) para Windows (principal) y macOS que usa yt-dlp.
No usar Python para la GUI.

- No iniciar la app ni servidores salvo pedido explícito. Build y pruebas finitas del motor sí están permitidos.
- No consultar sesiones del navegador ni descargar videos reales durante verificaciones sin pedido del usuario.
- No publicar, subir ni instalar servicios sin pedido explícito del usuario. Fuente/repositorio GitHub privado autorizados el 2026-11-03; no hacer público el proyecto por defecto.
- Mantener explícito que copiar un archivo usa almacenamiento temporal y depende del receptor.
- Eliminar únicamente temporales propios; preservar siempre las descargas guardadas por el usuario.
