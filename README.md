<img src="assets/icon.svg" width="64" height="64" alt="ClipDrop">

# ClipDrop

Una app de escritorio pequeña para descargar videos con yt-dlp. Windows es la plataforma principal; también funciona en Mac.

## Usar

1. Extraer **todo el ZIP** de tu plataforma.
2. Windows: abrir `ClipDrop.exe`. Mac: abrir `ClipDrop.app`.
3. En **Config**, elegir la carpeta de descarga; queda guardada.
4. En **Descarga**, pegar el enlace y elegir **Descargar** o **Copiar video**.

El ZIP Windows incluye el motor oficial yt-dlp; no requiere instalar Python, Node ni yt-dlp. No mover únicamente el EXE: necesita los archivos de su carpeta. En Mac se usa el motor instalado con `brew install yt-dlp ffmpeg`.

Copiar video guarda un archivo **temporal** y coloca su referencia nativa en el portapapeles. Ocupa espacio hasta eliminarlo desde **Config → Temporales**. Los temporales sobreviven al cierre para poder pegarlos después. Discord, WhatsApp u otra app deben aceptar archivos pegados; también puede abrirse la carpeta y arrastrar el video.

Si el sitio requiere sesión, elegir el navegador en **Config → Opciones avanzadas**. Sólo entonces yt-dlp lee sus cookies al descargar; no se exportan archivos de cookies. No se guarda historial de enlaces. FFmpeg es opcional: si está disponible, permite fusionar pistas separadas; sin él se elige un formato con audio y video combinados, habitual en Twitter/X.

## Windows y confianza

Los paquetes incluyen versión, nombre e icono propios, motor oficial fijado por versión/SHA256 y archivo de checksums. **Todavía no tienen firma Authenticode de editor**: Windows puede advertir que no reconoce la aplicación. GitHub y los hashes no eliminan SmartScreen. Si aparece una detección de amenaza con nombre, debe investigarse por separado. [Detalle y límites](WINDOWS.md).

## Desarrollo

Electron 45, HTML/CSS/JavaScript y yt-dlp externo. Node 22 o posterior para desarrollar:

```sh
npm ci
npm test
npm run check
```

Para abrir la app voluntariamente:

```sh
npm start
```

Para preparar los paquetes:

```sh
npm run build:windows
npm run verify:windows
npm run build:mac
npm run checksums
```

El icono se genera desde `assets/icon.svg`; los formatos PNG, ICO e ICNS están incluidos. El motor Windows está fijado en `tools/yt-dlp.json`; su SHA256 debe coincidir con el publicado por el proyecto oficial. Para actualizarlo, revisar y cambiar esa versión y su hash antes de compilar. Los binarios descargados y `dist/` quedan fuera de Git.

La CI compila en Windows y Mac, corre pruebas de motor/interfaz/almacenamiento y un roundtrip nativo de archivos del portapapeles sin abrir ventanas. En Windows registra si Defender pudo escanear el paquete. Los artefactos se conservan en GitHub Actions; los paquetes de una versión se adjuntan a su release.

## Verificaciones

Las pruebas del motor usan un ejecutable falso y no descargan videos ni leen sesiones reales. El DOM de la interfaz se prueba sin navegador. El portapapeles tiene pruebas aisladas y un smoke test nativo exclusivo de CI, para no reemplazar el portapapeles cotidiano del desarrollador.

Los resultados verifican el código, el empaquetado y operaciones concretas; no certifican que todos los sitios, versiones de Discord/WhatsApp o antivirus acepten cada release. El usuario confirmó funcionamiento de la primera versión en Mac. La plataforma y texto exactos del aviso inicial de Windows no se conservaron.

## Dependencias y licencias

Fuente de ClipDrop: uso personal, sin licencia pública otorgada. Electron y sus dependencias conservan sus licencias. Los paquetes Windows incluyen las licencias y procedencia del ejecutable oficial de yt-dlp; no se modifica ese binario. [yt-dlp](https://github.com/yt-dlp/yt-dlp), [licencias de sus releases](https://github.com/yt-dlp/yt-dlp#licensing), [Electron](https://www.electronjs.org/).
