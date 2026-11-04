# Microsoft Store

La distribución Store usa un MSIX independiente del instalador NSIS de GitHub. El producto está creado en Partner Center y, según lo informado por el usuario el 4 de noviembre de 2026, la aplicación fue enviada y está esperando la certificación de Microsoft.

## Identidad del producto

Valores proporcionados por el usuario desde Partner Center. Son los metadatos que se incluyen en el manifiesto del paquete.

| Campo | Valor |
| --- | --- |
| `STORE_IDENTITY_NAME` | `nitLabs.ClipDrop` |
| `STORE_PUBLISHER` | `CN=7619262E-634E-4862-89B6-0F9380587459` |
| `STORE_PUBLISHER_DISPLAY_NAME` | `nit Labs` |
| `STORE_DISPLAY_NAME` | `ClipDrop` |

## Alta gratuita y consulta de identidad

1. Entrar por [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/), elegir **Get started for free → Individual developer** y usar una cuenta Microsoft personal. Ese es el flujo gratuito; otros accesos pueden mostrar el registro anterior.
2. Completar perfil y verificación con documento y selfie directamente en Microsoft.
3. En Partner Center, crear un producto **MSIX o PWA** y reservar un nombre disponible. El producto actual ya tiene identidad asignada; no hay que crear otro para subir su paquete.
4. Abrir **Product management → Product identity** y copiar `Package/Identity/Name`, `Package/Identity/Publisher` y `Package/Properties/PublisherDisplayName`. Conservar también el nombre de producto reservado. No hacen falta contraseñas, tokens, documentos ni selfies para configurar el paquete.

Fuentes: [alta de desarrollador](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account?tabs=individual), [publicación MSIX](https://learn.microsoft.com/en-us/windows/apps/publish/get-started) e [identidad del producto](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details).

## Preparación y verificación

El workflow manual **Prepare Microsoft Store MSIX** construye el ejecutable sin generar ni ejecutar NSIS. Empaqueta el ejecutable original, yt-dlp, su procedencia y licencias, y los íconos derivados del logo. Usa MakeAppx del SDK de Windows para empaquetar y volver a extraer el contenido; compara sus hashes sin instalar ni abrir ClipDrop.

También se puede ejecutar `npm run build:store` en Windows. El modo real requiere `STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME` y `STORE_DISPLAY_NAME` en el entorno. Para verificar sólo el empaquetado se habilita `STORE_TEST_IDENTITY=true`, sin mezclar datos reales. Los resultados quedan en `dist/store/`.

Antes de disponer de la identidad real sólo se usa el modo de prueba. Su paquete está marcado **TEST-NO-SUBMIT** y no debe enviarse a Partner Center. El modo real exige los valores asignados por Microsoft. Ninguno de los modos sube contenido a la Store.

La versión de paquete se deriva como `(major + 1).minor.patch.0`: la app `0.3.1` produce MSIX `1.3.1.0`. La versión de producto de ClipDrop permanece `0.3.1`. Esto mantiene una secuencia creciente y reserva el último componente, como requiere Store. [Reglas de versión](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/package-version-numbering?pivots=store-installer-msix).

Un MSIX sin firma propia puede prepararse para la Store, que lo firma tras certificación. El archivo generado aquí no se presenta como un instalador listo para distribuir fuera de la Store. [Firma de Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

## Validaciones pendientes antes de enviar

- **Identidad:** usar exactamente la identidad y el nombre reservados en Partner Center.
- **WebView2:** el MSIX no ejecuta el bootstrapper del NSIS. Requiere Evergreen disponible en el equipo. Windows 11 lo incluye; Windows 10 puede requerir instalación aparte. `ExternalDependency` sólo se procesa con App Installer: no garantiza que Store instale WebView2. Elegir y validar la cobertura de sistemas antes de enviar. [Distribución de WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution), [alcance de ExternalDependency](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-win32dependencies-externaldependency).
- **Otras dependencias:** revisar los imports PE del informe y resolver cualquier runtime de Visual C++ que no esté disponible en un Windows limpio.
- **Prueba del paquete instalado:** arranque, lectura de recursos y yt-dlp, permisos, selección de carpeta, cancelación, copia/pegado de archivos y conservación de descargas permanentes. No se ejecuta esta prueba automáticamente: el usuario inicia la app. El smoke del portapapeles de la CI habitual no demuestra el comportamiento bajo identidad MSIX.
- **Datos existentes:** comprobar preferencias y temporales al pasar de NSIS a MSIX, porque Windows puede virtualizar AppData. No eliminar automáticamente la instalación ni los datos previos.
- **Ficha:** completar descripción, clasificación por edades, datos de soporte, capturas reales y declaraciones de privacidad. La [política de privacidad pública](https://gist.github.com/Nicotovillas/40580f46a13538830d1e19ed56a1a682) usa `nicotovi.nt@gmail.com` como contacto. Su fuente es [privacy.md](privacy.md); al modificarla hay que actualizar también el Gist.
- **Certificación:** explicar `runFullTrust`: ClipDrop es una app de escritorio que ejecuta yt-dlp, trabaja con carpetas elegidas por el usuario y copia referencias de archivos al portapapeles. La aceptación corresponde a Microsoft.

La preparación estática no declara que la app esté certificada ni que se haya probado instalada.

## Texto inicial para la ficha

**Descripción breve:** Descargá videos compatibles y copialos como archivos para pegarlos en otras aplicaciones.

**Descripción:** ClipDrop permite descargar videos desde enlaces compatibles con yt-dlp. Podés guardarlos en una carpeta o copiarlos como archivos temporales para pegarlos en aplicaciones que acepten ese formato. Incluye progreso, cancelación y limpieza de temporales. La sesión del navegador es opcional y se usa cuando el sitio requiere autenticación. Las descargas dependen del sitio de origen y de los permisos del usuario sobre el contenido.

Este texto es un borrador; las capturas deben mostrar la aplicación real y las declaraciones de la ficha deben coincidir con la versión enviada.
