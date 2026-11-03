use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

fn validate(files: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    if files.is_empty() {
        return Err("No hay archivos para copiar.".into());
    }
    files
        .iter()
        .map(|file| {
            if !file.is_absolute() || file.to_str().is_none_or(|value| value.contains('\0')) {
                return Err("La ruta del archivo no es válida. Volvé a descargar el video.".into());
            }
            let actual = file
                .canonicalize()
                .map_err(|_| "El archivo ya no está disponible. Volvé a descargar el video.")?;
            if actual.to_str().is_none() {
                return Err("La ruta del archivo no es válida.".into());
            }
            if !actual.is_file() {
                return Err("No se puede copiar una carpeta como video.".into());
            }
            Ok(actual)
        })
        .collect()
}

fn within(root: &Path, files: &[PathBuf]) -> bool {
    #[cfg(target_os = "macos")]
    fn comparable(path: &Path) -> PathBuf {
        macos::comparable_path(path)
    }
    #[cfg(not(target_os = "macos"))]
    fn comparable(path: &Path) -> PathBuf {
        path.to_path_buf()
    }
    let root = comparable(root);
    !files.is_empty()
        && files.iter().all(|file| {
            // Require a direct lexical descendant and a real descendant: a link in
            // the temporary tree must not authorize clearing an unrelated file.
            file.is_absolute()
                && comparable(file) != root
                && comparable(file).starts_with(&root)
                && file.canonicalize().is_ok_and(|actual| {
                    comparable(&actual) != root && comparable(&actual).starts_with(&root)
                })
        })
}

/// Copies native file references; the files must remain on disk while pasting.
pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    let files = validate(files)?;
    platform::copy_files(&files)
}

pub fn read_text() -> Result<String, String> {
    platform::read_text()
}

/// Clears a file-only clipboard only if every reference belongs to this root.
/// Unknown, mixed or concurrently changed content is left intact.
pub fn clear_if_within(root: &Path) -> Result<bool, String> {
    if !root.is_absolute() {
        return Err("La carpeta temporal no es válida.".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "La carpeta temporal no está disponible.")?;
    platform::clear_if_within(&root)
}

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;
    pub fn copy_files(_: &[PathBuf]) -> Result<(), String> {
        Err("Plataforma no compatible.".into())
    }
    pub fn read_text() -> Result<String, String> {
        Err("Plataforma no compatible.".into())
    }
    pub fn clear_if_within(_: &Path) -> Result<bool, String> {
        Err("Plataforma no compatible.".into())
    }
    pub fn roundtrip(_: &[PathBuf]) -> Result<(), String> {
        Err("Plataforma no compatible.".into())
    }
}

/// A finite native roundtrip intended only for an isolated CI desktop.
/// It refuses to replace a developer's ordinary clipboard outside CI.
pub fn ci_roundtrip(files: &[PathBuf]) -> Result<(), String> {
    if std::env::var("CI").as_deref() != Ok("true") {
        return Err("El roundtrip del portapapeles general sólo se ejecuta en CI.".into());
    }
    let files = validate(files)?;
    platform::roundtrip(&files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_relative_directory_and_empty_before_copying() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate(&[]).is_err());
        assert!(validate(&[PathBuf::from("relative.mp4")]).is_err());
        assert!(validate(&[root.path().into()]).is_err());
        assert!(validate(&[root.path().join("missing.mp4")]).is_err());
    }

    #[test]
    fn handles_unicode_and_excludes_sibling_paths() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("Video ñ 中文 💾.mp4");
        std::fs::write(&file, b"fixture").unwrap();
        let actual = validate(&[file]).unwrap();
        let canonical = root.path().canonicalize().unwrap();
        assert!(within(&canonical, &actual));
        assert!(!within(&canonical.join("child"), &actual));
        assert!(!within(&canonical, &[]));
    }
}
