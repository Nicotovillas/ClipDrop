use crate::{
    engine::{Cancellation, DownloadRequest, CANCELLED},
    storage::TemporaryStorage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

struct Session {
    destination: PathBuf,
    files: Vec<PathBuf>,
    busy: bool,
    cancellation: Option<Cancellation>,
}

pub struct AppState {
    session: Mutex<Session>,
    storage: TemporaryStorage,
    preferences: PathBuf,
}

#[derive(Deserialize)]
pub struct Request {
    pub url: String,
    pub mode: TransferMode,
    pub destination: Option<PathBuf>,
    pub browser: Option<String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(try_from = "String")]
pub enum TransferMode {
    Save,
    Copy,
}

impl TryFrom<String> for TransferMode {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "save" => Ok(Self::Save),
            "copy" => Ok(Self::Copy),
            _ => Err("Ingresá el enlace del video.".into()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct TransferredFile {
    name: String,
    path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum TransferOutcome {
    Completed {
        files: Vec<TransferredFile>,
        copied: bool,
        temporary_bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },
    Cancelled {
        cancelled: bool,
        temporary_bytes: u64,
    },
}

pub struct Snapshot {
    pub destination: PathBuf,
    pub temporary_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    temporary_bytes: u64,
    has_files: bool,
}

// Holds the operation lock across dialogs, downloads, clipboard IO and cleanup.
// Cancellation uses a separate flag and remains available while the lock is held.
pub struct Operation(Arc<AppState>);
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut session) = self.0.session.lock() {
            session.busy = false;
            session.cancellation = None;
        }
    }
}

impl AppState {
    pub fn new(
        preferences: PathBuf,
        temporary: PathBuf,
        downloads: PathBuf,
    ) -> Result<Self, String> {
        let destination = fs::read(&preferences)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value["destination"].as_str().map(PathBuf::from))
            .filter(|path| path.is_absolute())
            .unwrap_or(downloads);
        Ok(Self {
            session: Mutex::new(Session {
                destination,
                files: vec![],
                busy: false,
                cancellation: None,
            }),
            storage: TemporaryStorage::new(temporary)?,
            preferences,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Session>, String> {
        self.session
            .lock()
            .map_err(|_| "No se pudo acceder al estado de ClipDrop.".into())
    }

    pub fn destination(&self) -> Result<PathBuf, String> {
        Ok(self.lock()?.destination.clone())
    }

    pub fn is_busy(&self) -> bool {
        self.lock().map(|session| session.busy).unwrap_or(true)
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        Ok(Snapshot {
            destination: self.destination()?,
            temporary_bytes: self.storage.bytes()?,
        })
    }

    pub fn copy_result(
        &self,
        copy: impl FnOnce(&[PathBuf]) -> Result<(), String>,
    ) -> Result<(), String> {
        let files = self.lock()?.files.clone();
        copy(&files)
    }

    pub fn result_to_reveal(&self) -> Result<PathBuf, String> {
        let file = self
            .lock()?
            .files
            .first()
            .cloned()
            .ok_or("No hay archivos para mostrar.")?;
        if !file.is_file() {
            return Err("El archivo ya no está disponible.".into());
        }
        Ok(file)
    }

    pub fn clean_temporary(
        &self,
        clear_clipboard: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<CleanupOutcome, String> {
        clear_clipboard(self.storage.root())?;
        self.storage.clean()?;
        let mut session = self.lock()?;
        session.files.retain(|file| !self.storage.contains(file));
        Ok(CleanupOutcome {
            temporary_bytes: self.storage.bytes()?,
            has_files: !session.files.is_empty(),
        })
    }

    pub fn begin(self: &Arc<Self>, download: bool) -> Result<Operation, String> {
        let mut state = self.lock()?;
        if state.busy {
            return Err("Esperá a que termine la operación actual.".into());
        }
        state.busy = true;
        if download {
            state.files.clear();
            state.cancellation = Some(Cancellation::new());
        }
        Ok(Operation(self.clone()))
    }

    pub fn set_destination(&self, path: PathBuf) -> Result<(), String> {
        if !path.is_absolute() || path.as_os_str().len() > 4096 {
            return Err("Elegí una carpeta o ingresá una ruta completa.".into());
        }
        let parent = self
            .preferences
            .parent()
            .ok_or("La ruta de preferencias no es válida.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        // Same-directory rename replaces the previous preferences atomically.
        let bytes =
            serde_json::to_vec(&json!({ "destination": path })).map_err(|e| e.to_string())?;
        let temporary = self.preferences.with_extension("json.tmp");
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, &self.preferences).map_err(|e| e.to_string())?;
        self.lock()?.destination = path;
        Ok(())
    }

    pub fn cancel(&self) -> Result<(), String> {
        if let Some(flag) = &self.lock()?.cancellation {
            flag.cancel();
        }
        Ok(())
    }

    pub fn transfer(
        &self,
        request: Request,
        ffmpeg: Option<&Path>,
        run: impl FnOnce(&DownloadRequest, &Cancellation) -> Result<Vec<PathBuf>, String>,
        copy: impl FnOnce(&[PathBuf]) -> Result<(), String>,
    ) -> Result<TransferOutcome, String> {
        if request.url.len() > 8192 {
            return Err("Ingresá el enlace del video.".into());
        }
        let flag = self
            .lock()?
            .cancellation
            .clone()
            .ok_or("No hay una descarga en curso.")?;
        let is_copy = request.mode == TransferMode::Copy;
        let target = if is_copy {
            self.storage.create()?
        } else {
            let path = request
                .destination
                .ok_or("Elegí una carpeta para guardar el video.")?;
            if !path.is_absolute() || path.as_os_str().len() > 4096 {
                return Err("Elegí una carpeta o ingresá una ruta completa.".into());
            }
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
            if canonical == self.storage.root() || self.storage.contains(&canonical) {
                return Err("Elegí una carpeta fuera de los temporales de ClipDrop.".into());
            }
            self.set_destination(canonical.clone())?;
            canonical
        };
        let outcome = (|| {
            if flag.is_cancelled() {
                return Err(CANCELLED.into());
            }
            let engine_request = DownloadRequest {
                url: request.url.trim().into(),
                destination: target.clone(),
                browser: request.browser.filter(|s| !s.is_empty()),
            };
            // Validate before invoking injected engines as well as production.
            crate::engine::build_arguments(&engine_request, ffmpeg)?;
            let files = run(&engine_request, &flag)?;
            if flag.is_cancelled() {
                return Err(CANCELLED.into());
            }
            // Finish fallible bookkeeping before publishing clipboard references:
            // an unrelated size error must never delete a file already copied.
            let temporary_bytes = self.storage.bytes()?;
            self.lock()?.files = files.clone();
            let warning = if is_copy { copy(&files).err() } else { None };
            let listed = files
                .into_iter()
                .map(|path| TransferredFile {
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    path,
                })
                .collect();
            Ok(TransferOutcome::Completed {
                files: listed,
                copied: is_copy && warning.is_none(),
                temporary_bytes,
                warning,
            })
        })();
        if outcome.is_err() && is_copy {
            let _ = self.storage.remove_job(&target);
        }
        if outcome.is_err()
            && (flag.is_cancelled() || outcome.as_ref().is_err_and(|e| e == CANCELLED))
        {
            return Ok(TransferOutcome::Cancelled {
                cancelled: true,
                temporary_bytes: self.storage.bytes()?,
            });
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Arc<AppState>) {
        let root = tempfile::tempdir().unwrap();
        let service = Arc::new(
            AppState::new(
                root.path().join("profile/preferences.json"),
                root.path().join("temporary"),
                root.path().join("downloads"),
            )
            .unwrap(),
        );
        (root, service)
    }
    fn request(service: &AppState, mode: &str) -> Request {
        Request {
            url: "https://x.com/test/status/123".into(),
            mode: mode.to_owned().try_into().unwrap(),
            destination: Some(service.lock().unwrap().destination.clone()),
            browser: None,
        }
    }
    fn fake(request: &DownloadRequest, _: &Cancellation) -> Result<Vec<PathBuf>, String> {
        fs::create_dir_all(&request.destination).unwrap();
        let file = request.destination.join("Video ñ.mp4");
        fs::write(&file, b"synthetic video fixture").unwrap();
        Ok(vec![file])
    }
    fn transfer(service: &Arc<AppState>, mode: &str) -> Value {
        let _operation = service.begin(true).unwrap();
        let outcome = service
            .transfer(request(service, mode), None, fake, |_| Ok(()))
            .unwrap();
        serde_json::to_value(outcome).unwrap()
    }

    #[test]
    fn save_copy_cleanup_preserves_permanent_downloads_and_old_preferences() {
        let (root, service) = fixture();
        let saved = transfer(&service, "save");
        let copied = transfer(&service, "copy");
        assert_eq!(saved["copied"], false);
        assert_eq!(copied["copied"], true);
        let saved_file = PathBuf::from(saved["files"][0]["path"].as_str().unwrap());
        let copied_file = PathBuf::from(copied["files"][0]["path"].as_str().unwrap());
        assert_eq!(
            saved,
            json!({
                "files": [{"name": "Video ñ.mp4", "path": saved_file}],
                "copied": false,
                "temporaryBytes": 0
            })
        );
        let cleaned = service
            .clean_temporary(|_| {
                assert!(
                    copied_file.is_file(),
                    "clear clipboard before deleting its file"
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(
            serde_json::to_value(cleaned).unwrap(),
            json!({
                "temporaryBytes": 0,
                "hasFiles": false
            })
        );
        assert!(saved_file.is_file());
        assert!(!copied_file.exists());
        let reopened = AppState::new(
            root.path().join("profile/preferences.json"),
            root.path().join("temporary"),
            root.path().join("unused"),
        )
        .unwrap();
        assert_eq!(
            reopened.lock().unwrap().destination,
            saved_file.parent().unwrap()
        );
        // Replacing an existing preferences file must work on Windows as well.
        reopened
            .set_destination(root.path().join("another"))
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(root.path().join("profile/preferences.json")).unwrap()
            )
            .unwrap()["destination"],
            json!(root.path().join("another"))
        );
    }

    #[test]
    fn clipboard_failure_keeps_temporary_file_for_retry() {
        let (_root, service) = fixture();
        let _operation = service.begin(true).unwrap();
        let outcome = service
            .transfer(request(&service, "copy"), None, fake, |_| {
                Err("Clipboard ocupado (fixture)".into())
            })
            .unwrap();
        let result = serde_json::to_value(outcome).unwrap();
        assert_eq!(result["copied"], false);
        assert!(result["warning"].as_str().unwrap().contains("ocupado"));
        assert!(service.lock().unwrap().files[0].is_file());
        assert!(service.storage.bytes().unwrap() > 0);
    }

    #[test]
    fn cancellation_before_engine_removes_only_own_job_and_releases_gate() {
        let (_root, service) = fixture();
        let operation = service.begin(true).unwrap();
        service.cancel().unwrap();
        let outcome = service
            .transfer(
                request(&service, "copy"),
                None,
                |_, _| panic!("must not execute"),
                |_| panic!("must not copy"),
            )
            .unwrap();
        let result = serde_json::to_value(outcome).unwrap();
        assert_eq!(result["cancelled"], true);
        assert_eq!(result, json!({"cancelled": true, "temporaryBytes": 0}));
        assert_eq!(service.storage.bytes().unwrap(), 0);
        assert_eq!(fs::read_dir(service.storage.root()).unwrap().count(), 0);
        assert!(service.begin(false).is_err());
        drop(operation);
        assert!(service.begin(false).is_ok());
    }

    #[test]
    fn cleanup_keeps_saved_result_available_for_copy_and_reveal() {
        let (_root, service) = fixture();
        let copied = transfer(&service, "copy");
        let saved = transfer(&service, "save");
        let copied_file = PathBuf::from(copied["files"][0]["path"].as_str().unwrap());
        let saved_file = PathBuf::from(saved["files"][0]["path"].as_str().unwrap());
        let _operation = service.begin(false).unwrap();
        let cleaned = service.clean_temporary(|_| Ok(())).unwrap();
        assert!(cleaned.has_files);
        assert!(!copied_file.exists());
        service
            .copy_result(|files| {
                assert_eq!(files, &[saved_file.clone()]);
                Ok(())
            })
            .unwrap();
        assert_eq!(service.result_to_reveal().unwrap(), saved_file);
        fs::remove_file(&saved_file).unwrap();
        assert_eq!(
            service.result_to_reveal().unwrap_err(),
            "El archivo ya no está disponible."
        );
    }

    #[test]
    fn cleanup_failure_preserves_temporary_files_and_result() {
        let (_root, service) = fixture();
        let copied = transfer(&service, "copy");
        let copied_file = PathBuf::from(copied["files"][0]["path"].as_str().unwrap());
        let _operation = service.begin(false).unwrap();
        assert!(service
            .clean_temporary(|_| Err("clipboard ocupado (fixture)".into()))
            .is_err());
        assert!(copied_file.is_file());
        assert_eq!(service.result_to_reveal().unwrap(), copied_file);
    }

    #[test]
    fn request_modes_are_validated_at_the_ipc_boundary() {
        for mode in ["save", "copy"] {
            let request: Request = serde_json::from_value(json!({
                "url": "https://example.com/video", "mode": mode
            }))
            .unwrap();
            assert!(matches!(
                request.mode,
                TransferMode::Save | TransferMode::Copy
            ));
        }
        let error = serde_json::from_value::<Request>(json!({
            "url": "https://example.com/video", "mode": "delete"
        }))
        .err()
        .unwrap();
        assert!(error.to_string().contains("Ingresá el enlace del video."));
    }

    #[test]
    fn every_operation_excludes_download_copy_and_cleanup() {
        let (_root, service) = fixture();
        for downloading in [false, true] {
            let operation = service.begin(downloading).unwrap();
            assert!(service.begin(false).is_err());
            assert!(service.begin(true).is_err());
            service.cancel().unwrap();
            drop(operation);
            assert!(!service.lock().unwrap().busy);
        }
    }

    #[test]
    fn failed_copy_cleans_job_but_failed_save_retains_partial_video() {
        let (_root, service) = fixture();
        for mode in ["copy", "save"] {
            let _operation = service.begin(true).unwrap();
            let result = service.transfer(
                request(&service, mode),
                None,
                |request, _| {
                    fs::create_dir_all(&request.destination).unwrap();
                    fs::write(request.destination.join("video.part"), b"partial fixture").unwrap();
                    Err("Download failed (fixture)".into())
                },
                |_| panic!("must not copy"),
            );
            assert!(result.is_err());
        }
        assert_eq!(service.storage.bytes().unwrap(), 0);
        assert!(service
            .lock()
            .unwrap()
            .destination
            .join("video.part")
            .is_file());
    }

    #[test]
    fn rejects_permanent_saves_to_temporary_tree_including_symlink_aliases() {
        let (root, service) = fixture();
        let mut destinations = vec![
            service.storage.root().to_path_buf(),
            service.storage.root().join("transfer-owned"),
        ];
        #[cfg(unix)]
        {
            let alias = root.path().join("alias");
            std::os::unix::fs::symlink(service.storage.root(), &alias).unwrap();
            destinations.push(alias.join("transfer-alias"));
        }
        let _ = root;
        for destination in destinations {
            let _operation = service.begin(true).unwrap();
            let mut req = request(&service, "save");
            req.destination = Some(destination);
            let result = service.transfer(req, None, |_, _| panic!("must not run"), |_| Ok(()));
            assert!(result.unwrap_err().contains("fuera de los temporales"));
        }
    }

    #[test]
    fn previous_electron_preferences_load_without_changing_location() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("preferences.json");
        let folder = root.path().join("Videos elegidos");
        fs::write(
            &file,
            serde_json::to_vec(&json!({"destination": folder})).unwrap(),
        )
        .unwrap();
        let service = AppState::new(
            file.clone(),
            root.path().join("temp"),
            root.path().join("default"),
        )
        .unwrap();
        assert_eq!(service.lock().unwrap().destination, folder);
        fs::write(&file, br#"{"destination":"relative"}"#).unwrap();
        let service =
            AppState::new(file, root.path().join("temp"), root.path().join("default")).unwrap();
        assert_eq!(
            service.lock().unwrap().destination,
            root.path().join("default")
        );
    }
}
