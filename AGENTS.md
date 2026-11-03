# ClipDrop

Aplicación de escritorio con Tauri 2 y yt-dlp. Windows es la plataforma principal; Mac Apple Silicon es secundaria. Interfaz HTML/CSS/JavaScript en `ui/` y un único paquete Rust/Tauri en `desktop/`; no usar Python para la GUI.

- Conservar la interfaz compacta de 560×300 y las pestañas Descarga/Config.
- Al copiar un video, indicar que usa almacenamiento temporal y depende de que la aplicación receptora acepte archivos.
- Eliminar únicamente temporales propios; preservar las descargas guardadas.
- Verificar con `npm test` y `npm run check`. Las pruebas usan fixtures: no descargar videos reales ni leer sesiones del navegador sin un pedido explícito.
- Publicar releases o cambiar la visibilidad del repositorio sólo ante un pedido explícito.
