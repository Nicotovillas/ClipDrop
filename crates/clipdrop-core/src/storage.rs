use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct TemporaryStorage {
    root: PathBuf,
}

fn owned_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .and_then(|s| s.strip_prefix("transfer-"))
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_alphanumeric())
        })
}

impl TemporaryStorage {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            root: fs::canonicalize(root).map_err(|e| e.to_string())?,
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn contains(&self, file: &Path) -> bool {
        file != self.root
            && file.strip_prefix(&self.root).is_ok_and(|relative| {
                !relative.as_os_str().is_empty()
                    && relative
                        .components()
                        .all(|p| matches!(p, std::path::Component::Normal(_)))
            })
    }
    pub fn create(&self) -> Result<PathBuf, String> {
        tempfile::Builder::new()
            .prefix("transfer-")
            .tempdir_in(&self.root)
            .map(|directory| directory.keep())
            .map_err(|e| e.to_string())
    }
    pub fn remove_job(&self, directory: &Path) -> Result<(), String> {
        if directory.parent() != Some(self.root.as_path())
            || !directory.file_name().is_some_and(owned_name)
        {
            return Err("La carpeta no pertenece a los temporales de ClipDrop.".into());
        }
        match fs::symlink_metadata(directory) {
            Ok(meta) if meta.file_type().is_symlink() => {
                // Never traverse a symlink, including Windows directory links.
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x10 != 0 {
                        return fs::remove_dir(directory).map_err(|e| e.to_string());
                    }
                }
                fs::remove_file(directory).map_err(|e| e.to_string())
            }
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(directory).map_err(|e| e.to_string()),
            Ok(_) => fs::remove_file(directory).map_err(|e| e.to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
    pub fn clean(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if owned_name(&entry.file_name()) {
                self.remove_job(&entry.path())?;
            }
        }
        Ok(())
    }
    pub fn bytes(&self) -> Result<u64, String> {
        fn size(path: &Path) -> io::Result<u64> {
            let mut total: u64 = 0;
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    total = total.saturating_add(size(&entry.path())?);
                } else if kind.is_file() {
                    match entry.metadata() {
                        Ok(meta) => total = total.saturating_add(meta.len()),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                        Err(error) => return Err(error),
                    }
                }
            }
            Ok(total)
        }
        size(&self.root).map_err(|e| e.to_string())
    }
}
