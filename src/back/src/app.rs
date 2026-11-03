use crate::{commands, state::AppState};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(setup)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if busy(window.app_handle()) {
                    api.prevent_close();
                    window
                        .dialog()
                        .message("Hay una operación en curso. Esperá a que termine o cancelá la descarga antes de cerrar ClipDrop.")
                        .title("ClipDrop")
                        .show(|_| {});
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::info,
            commands::paste_link,
            commands::choose_folder,
            commands::download,
            commands::cancel,
            commands::copy_result,
            commands::reveal_result,
            commands::clean_temporary,
        ])
        .build(tauri::generate_context!())
        .expect("No se pudo preparar ClipDrop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if busy(app) {
                api.prevent_exit();
            }
        }
    });
}

fn busy(app: &tauri::AppHandle) -> bool {
    app.state::<Arc<AppState>>()
        .lock()
        .map(|state| state.busy)
        .unwrap_or(true)
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let preferences = dirs::config_dir()
        .ok_or("No se encontró la carpeta de configuración.")?
        .join("ClipDrop/preferences.json");
    let temporary = std::env::temp_dir().join("ClipDrop/transfers");
    let downloads = dirs::download_dir().ok_or("No se encontró la carpeta de descargas.")?;
    app.manage(Arc::new(AppState::new(preferences, temporary, downloads)?));

    let config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("Falta la ventana principal.")?;
    tauri::WebviewWindowBuilder::from_config(app, config)?
        .on_navigation(commands::local_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    Ok(())
}
