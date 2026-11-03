use clipdrop_core::{Cancellation, DownloadRequest, TemporaryStorage, CANCELLED};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

pub struct Session {
    pub destination: PathBuf,
    pub files: Vec<PathBuf>,
    pub busy: bool,
    pub cancellation: Option<Cancellation>,
}

pub struct Service {
    pub session: Mutex<Session>,
    pub storage: TemporaryStorage,
    preferences: PathBuf,
}

#[derive(Deserialize)]
pub struct Request {
    pub url: String,
    pub mode: String,
    pub destination: Option<PathBuf>,
    pub browser: Option<String>,
}

// Holds the operation lock across dialogs, downloads, clipboard IO and cleanup.
// Cancellation uses a separate flag and remains available while the lock is held.
pub struct Operation(pub Arc<Service>);
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut session) = self.0.session.lock() {
            session.busy = false;
            session.cancellation = None;
        }
    }
}

impl Service {
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

    pub fn lock(&self) -> Result<MutexGuard<'_, Session>, String> {
        self.session
            .lock()
            .map_err(|_| "No se pudo acceder al estado de ClipDrop.".into())
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
        executable: &Path,
        ffmpeg: Option<&Path>,
        run: impl FnOnce(&DownloadRequest, &Cancellation) -> Result<Vec<PathBuf>, String>,
        copy: impl FnOnce(&[PathBuf]) -> Result<(), String>,
    ) -> Result<Value, String> {
        if !["save", "copy"].contains(&request.mode.as_str()) || request.url.len() > 8192 {
            return Err("Ingresá el enlace del video.".into());
        }
        let flag = self
            .lock()?
            .cancellation
            .clone()
            .ok_or("No hay una descarga en curso.")?;
        let is_copy = request.mode == "copy";
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
            clipdrop_core::build_arguments(&engine_request, ffmpeg)?;
            let _ = executable;
            let files = run(&engine_request, &flag)?;
            if flag.is_cancelled() {
                return Err(CANCELLED.into());
            }
            // Finish fallible bookkeeping before publishing clipboard references:
            // an unrelated size error must never delete a file already copied.
            let temporary_bytes = self.storage.bytes()?;
            self.lock()?.files = files.clone();
            let warning = if is_copy { copy(&files).err() } else { None };
            let listed: Vec<Value> = files
                .iter()
                .map(|path| {
                    json!({
                        "name": path.file_name().unwrap_or_default().to_string_lossy(), "path": path
                    })
                })
                .collect();
            let mut result = json!({"files": listed, "copied": is_copy && warning.is_none(), "temporaryBytes": temporary_bytes});
            if let Some(message) = warning {
                result["warning"] = json!(message);
            }
            Ok(result)
        })();
        if outcome.is_err() && is_copy {
            let _ = self.storage.remove_job(&target);
        }
        if outcome.is_err()
            && (flag.is_cancelled() || outcome.as_ref().is_err_and(|e| e == CANCELLED))
        {
            return Ok(json!({"cancelled": true, "temporaryBytes": self.storage.bytes()?}));
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Arc<Service>) {
        let root = tempfile::tempdir().unwrap();
        let service = Arc::new(
            Service::new(
                root.path().join("profile/preferences.json"),
                root.path().join("temporary"),
                root.path().join("downloads"),
            )
            .unwrap(),
        );
        (root, service)
    }
    fn request(service: &Service, mode: &str) -> Request {
        Request {
            url: "https://x.com/test/status/123".into(),
            mode: mode.into(),
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
    fn transfer(service: &Arc<Service>, mode: &str) -> Value {
        let _operation = service.begin(true).unwrap();
        service
            .transfer(
                request(service, mode),
                Path::new("fake"),
                None,
                fake,
                |_| Ok(()),
            )
            .unwrap()
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
        service.storage.clean().unwrap();
        assert!(saved_file.is_file());
        assert!(!copied_file.exists());
        let reopened = Service::new(
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
        let result = service
            .transfer(
                request(&service, "copy"),
                Path::new("fake"),
                None,
                fake,
                |_| Err("Clipboard ocupado (fixture)".into()),
            )
            .unwrap();
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
        let result = service
            .transfer(
                request(&service, "copy"),
                Path::new("fake"),
                None,
                |_, _| panic!("must not execute"),
                |_| panic!("must not copy"),
            )
            .unwrap();
        assert_eq!(result["cancelled"], true);
        assert_eq!(service.storage.bytes().unwrap(), 0);
        assert_eq!(fs::read_dir(service.storage.root()).unwrap().count(), 0);
        assert!(service.begin(false).is_err());
        drop(operation);
        assert!(service.begin(false).is_ok());
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
                Path::new("fake"),
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
            let result = service.transfer(
                req,
                Path::new("fake"),
                None,
                |_, _| panic!("must not run"),
                |_| Ok(()),
            );
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
        let service = Service::new(
            file.clone(),
            root.path().join("temp"),
            root.path().join("default"),
        )
        .unwrap();
        assert_eq!(service.lock().unwrap().destination, folder);
        fs::write(&file, br#"{"destination":"relative"}"#).unwrap();
        let service =
            Service::new(file, root.path().join("temp"), root.path().join("default")).unwrap();
        assert_eq!(
            service.lock().unwrap().destination,
            root.path().join("default")
        );
    }
}
