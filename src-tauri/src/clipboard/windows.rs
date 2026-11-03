use super::*;
use clipboard_win::{formats, raw, Clipboard};
use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE};

struct Owner(windows_sys::Win32::Foundation::HWND);
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}
struct OpenClipboard {
    // Fields drop in order: release the clipboard before destroying its owner.
    _clipboard: Clipboard,
    _owner: Owner,
}

fn open() -> Result<OpenClipboard, String> {
    // A message-only STATIC window is never visible, focused or shown in the
    // taskbar. A real owner avoids SetClipboardData's documented NULL-owner
    // failure after EmptyClipboard; it lives on this same calling thread.
    let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    let owner = Owner(unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    });
    if owner.0.is_null() {
        return Err("No se pudo preparar el portapapeles nativo.".into());
    }
    let clipboard = Clipboard::new_attempts_for(owner.0, 10)
        .map_err(|_| "No se pudo abrir el portapapeles. Cerrá diálogos abiertos y reintentá.")?;
    Ok(OpenClipboard {
        _clipboard: clipboard,
        _owner: owner,
    })
}

pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    let paths: Vec<_> = files
        .iter()
        .map(|file| file.to_string_lossy().into_owned())
        .collect();
    let _lock = open()?;
    // Allocation/UTF-16 conversion happens inside the library before replacing
    // clipboard content. DoClear is essential: FileList's default adds a format.
    raw::set_file_list_with(&paths, clipboard_win::options::DoClear)
        .map_err(|_| "No se pudo copiar el video al portapapeles. Reintentá.".into())
}

pub fn read_text() -> Result<String, String> {
    let _lock = open()?;
    if !raw::is_format_avail(formats::CF_UNICODETEXT) {
        return Ok(String::new());
    }
    let mut text = Vec::new();
    raw::get_string(&mut text).map_err(|_| "No se pudo leer el portapapeles.")?;
    String::from_utf8(text).map_err(|_| "El texto del portapapeles no es válido.".into())
}

fn read_files() -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    raw::get_file_list_path(&mut files)
        .map_err(|_| "No se pudieron leer los archivos del portapapeles.")?;
    Ok(files)
}

pub fn clear_if_within(root: &Path) -> Result<bool, String> {
    // OpenClipboard excludes other writers until this guard drops. Reading,
    // validating and clearing are inside this one native critical section.
    let _lock = open()?;
    let formats: Vec<_> = raw::EnumFormats::new().collect();
    if formats != [formats::CF_HDROP] {
        return Ok(false);
    }
    if !within(root, &read_files()?) {
        return Ok(false);
    }
    raw::empty().map_err(|_| "No se pudo limpiar el portapapeles.")?;
    Ok(true)
}

#[cfg(feature = "test-tools")]
pub fn roundtrip(files: &[PathBuf]) -> Result<(), String> {
    copy_files(files)?;
    {
        let _lock = open()?;
        if !raw::is_format_avail(formats::CF_HDROP) || read_files()? != files {
            return Err("El roundtrip nativo CF_HDROP no coincide.".into());
        }
    }
    let root = files[0].parent().ok_or("Fixture sin carpeta.")?;
    if !clear_if_within(root)? {
        return Err("No se limpió la lista de archivos propia.".into());
    }
    {
        let _lock = open()?;
        raw::set_string("ClipDrop CI text fixture")
            .map_err(|_| "No se pudo crear fixture texto.")?;
    }
    if clear_if_within(root)? || read_text()? != "ClipDrop CI text fixture" {
        return Err("La limpieza alteró texto ajeno.".into());
    }
    {
        let _lock = open()?;
        let paths: Vec<_> = files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        raw::set_file_list_with(&paths, clipboard_win::options::NoClear)
            .map_err(|_| "No se pudo crear el fixture mixto.")?;
    }
    if clear_if_within(root)? || read_text()? != "ClipDrop CI text fixture" {
        return Err("La limpieza alteró contenido mixto.".into());
    }
    let _lock = open()?;
    raw::empty().map_err(|_| "No se pudo retirar el fixture CI.".into())
}
