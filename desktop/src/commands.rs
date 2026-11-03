use crate::{
    clipboard,
    engine::{download as run_engine, find_executable},
    state::{AppState, Request},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

type Shared = Arc<AppState>;

pub(crate) fn local_url(url: &tauri::Url) -> bool {
    let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"));
    origin
        && ["", "/", "/index.html"].contains(&url.path())
        && url.query().is_none()
        && url.fragment().is_none()
}

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" && window.url().is_ok_and(|url| local_url(&url)) {
        Ok(())
    } else {
        Err("Solicitud no permitida.".into())
    }
}

fn reply(result: Result<Value, String>) -> Value {
    match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            value
        }
        Err(error) => json!({"ok": false, "error": error}),
    }
}

async fn blocking<T: Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Value {
    reply(
        tauri::async_runtime::spawn_blocking(work)
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
            .and_then(|value| serde_json::to_value(value).map_err(|e| e.to_string())),
    )
}

fn yt_dlp(app: &tauri::AppHandle) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let bundled = app
            .path()
            .resource_dir()
            .ok()?
            .join("tools")
            .join("yt-dlp.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
        #[cfg(debug_assertions)]
        {
            let development =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/win32/yt-dlp.exe");
            if development.is_file() {
                return Some(development);
            }
        }
    }
    let _ = app;
    find_executable("yt-dlp")
}

#[tauri::command]
pub(crate) async fn info(window: WebviewWindow, app: tauri::AppHandle) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    let state = app.state::<Shared>().inner().clone();
    blocking(move || {
        let snapshot = state.snapshot()?;
        Ok(json!({
            "destination": snapshot.destination,
            "available": yt_dlp(&app).is_some(),
            "platform": if cfg!(target_os="macos") { "darwin" } else { "win32" },
            "temporaryBytes": snapshot.temporary_bytes, "ffmpeg": find_executable("ffmpeg").is_some()
        }))
    })
    .await
}

#[tauri::command]
pub(crate) async fn paste_link(window: WebviewWindow) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    blocking(|| Ok(json!({"text": clipboard::read_text()?.trim()}))).await
}

#[tauri::command]
pub(crate) async fn choose_folder(window: WebviewWindow, app: tauri::AppHandle) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    let state = app.state::<Shared>().inner().clone();
    blocking(move || {
        let _operation = state.begin(false)?;
        let destination = state.destination()?;
        let choice = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Carpeta para los videos")
            .set_directory(destination)
            .blocking_pick_folder();
        let Some(choice) = choice else {
            return Ok(json!({"cancelled": true}));
        };
        let path = choice.into_path().map_err(|e| e.to_string())?;
        state.set_destination(path.clone())?;
        Ok(json!({"destination": path}))
    })
    .await
}

#[tauri::command]
pub(crate) async fn download(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: Request,
) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    let state = app.state::<Shared>().inner().clone();
    // Reserve synchronously before scheduling IO so an immediate cancel is retained.
    let operation = match state.begin(true) {
        Ok(guard) => guard,
        Err(e) => return reply(Err(e)),
    };
    let _ = window.emit("transfer-event", json!({"type": "busy", "value": true}));
    let emitter = window.clone();
    let result = blocking(move || {
        let _operation = operation;
        let executable = yt_dlp(&app)
            .ok_or("No se encontró yt-dlp. Revisá las instrucciones de instalación.")?;
        let ffmpeg = find_executable("ffmpeg");
        state.transfer(
            request,
            ffmpeg.as_deref(),
            |request, flag| {
                run_engine(&executable, ffmpeg.as_deref(), request, flag, |event| {
                    let _ = emitter.emit("transfer-event", event);
                })
            },
            clipboard::copy_files,
        )
    })
    .await;
    let _ = window.emit("transfer-event", json!({"type": "busy", "value": false}));
    result
}

#[tauri::command]
pub(crate) fn cancel(window: WebviewWindow, state: State<'_, Shared>) -> Value {
    reply(trusted(&window).and_then(|_| {
        state.cancel()?;
        Ok(json!({}))
    }))
}

#[tauri::command]
pub(crate) async fn copy_result(window: WebviewWindow, app: tauri::AppHandle) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    let state = app.state::<Shared>().inner().clone();
    blocking(move || {
        let _operation = state.begin(false)?;
        state.copy_result(clipboard::copy_files)?;
        Ok(json!({}))
    })
    .await
}

#[tauri::command]
pub(crate) async fn reveal_result(window: WebviewWindow, app: tauri::AppHandle) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    let state = app.state::<Shared>().inner().clone();
    blocking(move || {
        let _operation = state.begin(false)?;
        let file = state.result_to_reveal()?;
        app.opener()
            .reveal_item_in_dir(file)
            .map_err(|e| e.to_string())?;
        Ok(json!({}))
    })
    .await
}

#[tauri::command]
pub(crate) async fn clean_temporary(window: WebviewWindow, app: tauri::AppHandle) -> Value {
    if let Err(e) = trusted(&window) {
        return reply(Err(e));
    }
    let state = app.state::<Shared>().inner().clone();
    blocking(move || {
        let _operation = state.begin(false)?;
        let answer = app.dialog().message("¿Eliminar los videos temporales?\n\nUn video copiado desde esa carpeta dejará de estar disponible para pegar. Los videos guardados en tu carpeta se conservan.")
            .title("Limpiar temporales").parent(&window)
            .buttons(MessageDialogButtons::OkCancelCustom("Limpiar".into(), "Cancelar".into())).blocking_show();
        if !answer { return Ok(json!({"cancelled": true})); }
        Ok(json!(state.clean_temporary(|root| clipboard::clear_if_within(root).map(|_| ()))?))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipc_navigation_accepts_only_the_packaged_local_page() {
        for url in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(local_url(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://localhost/",
            "tauri://evil/index.html",
            "tauri://localhost/other.html",
            "tauri://localhost/?other=1",
            "tauri://localhost/#other",
        ] {
            assert!(!local_url(&url.parse().unwrap()), "{url}");
        }
    }
}
