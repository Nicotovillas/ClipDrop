use super::*;
use objc2::{
    rc::{autoreleasepool, Retained},
    runtime::ProtocolObject,
};
use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSString, NSURL};

pub(super) fn comparable_path(path: &Path) -> PathBuf {
    autoreleasepool(|_| {
        PathBuf::from(
            NSString::from_str(&path.to_string_lossy())
                .decomposedStringWithCanonicalMapping()
                .to_string(),
        )
    })
}

fn write_files(board: &NSPasteboard, files: &[PathBuf]) -> Result<(), String> {
    let urls: Vec<Retained<NSURL>> = files
        .iter()
        .map(|file| {
            NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(file.to_str().expect("validated UTF-8 path")),
                false,
            )
        })
        .collect();
    let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = urls
        .iter()
        .map(|url| ProtocolObject::from_ref(&**url))
        .collect();
    let array = NSArray::from_slice(&objects);
    board.clearContents();
    if !board.writeObjects(&array) {
        return Err("No se pudo copiar el video al portapapeles. Reintentá.".into());
    }
    Ok(())
}

fn read_files(board: &NSPasteboard) -> Option<Vec<PathBuf>> {
    let items = board.pasteboardItems()?;
    if items.is_empty() {
        return None;
    }
    let mut files = Vec::new();
    for item in items.iter() {
        // Our NSURL writer emits public.file-url. Preserve any other flavor,
        // even an apparent alias: it could carry independent user content.
        let types = item.types();
        if types.len() != 1
            || types
                .iter()
                .any(|kind| kind.to_string() != "public.file-url")
        {
            return None;
        }
        let value = item.stringForType(unsafe { NSPasteboardTypeFileURL })?;
        let url = NSURL::URLWithString(&value)?;
        if !url.isFileURL() {
            return None;
        }
        files.push(PathBuf::from(url.path()?.to_string()));
    }
    Some(files)
}

fn clear_board_if_within(board: &NSPasteboard, root: &Path) -> bool {
    let before = board.changeCount();
    let Some(files) = read_files(board) else {
        return false;
    };
    clear_snapshot(board, root, before, &files)
}

fn clear_snapshot(board: &NSPasteboard, root: &Path, before: isize, files: &[PathBuf]) -> bool {
    if !within(root, files) || board.changeCount() != before {
        return false;
    }
    // NSPasteboard offers no compare-and-swap clear API. Keep this final check
    // adjacent to clearContents, with no await or callback in between.
    board.clearContents();
    true
}

pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    autoreleasepool(|_| write_files(&NSPasteboard::generalPasteboard(), files))
}

pub fn read_text() -> Result<String, String> {
    autoreleasepool(|_| {
        Ok(NSPasteboard::generalPasteboard()
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|text| text.to_string())
            .unwrap_or_default())
    })
}

pub fn clear_if_within(root: &Path) -> Result<bool, String> {
    autoreleasepool(|_| {
        Ok(clear_board_if_within(
            &NSPasteboard::generalPasteboard(),
            root,
        ))
    })
}

#[cfg(any(test, feature = "test-tools"))]
fn board_roundtrip(board: &NSPasteboard, files: &[PathBuf]) -> Result<(), String> {
    write_files(board, files)?;
    let native_files =
        read_files(board).ok_or("No se devolvieron referencias de archivos nativas.")?;
    use std::os::unix::fs::MetadataExt;
    let matching_files = native_files.len() == files.len()
        && native_files.iter().zip(files).all(|(actual, expected)| {
            // Compare the referenced filesystem identities, not Unicode spelling:
            // Foundation normalizes ñ to n + combining tilde on this platform.
            match (actual.metadata(), expected.metadata()) {
                (Ok(actual), Ok(expected)) => {
                    actual.is_file()
                        && actual.dev() == expected.dev()
                        && actual.ino() == expected.ino()
                }
                _ => false,
            }
        });
    if !matching_files {
        return Err("El roundtrip nativo NSURL/public.file-url no coincide.".into());
    }
    let root = files[0].parent().ok_or("Fixture sin carpeta.")?;
    if !clear_board_if_within(board, root) {
        return Err("No se limpió la lista de archivos propia.".into());
    }
    board.setString_forType(&NSString::from_str("ClipDrop text fixture"), unsafe {
        NSPasteboardTypeString
    });
    if clear_board_if_within(board, root) {
        return Err("La limpieza alteró texto ajeno.".into());
    }
    if board
        .stringForType(unsafe { NSPasteboardTypeString })
        .map(|text| text.to_string())
        .as_deref()
        != Some("ClipDrop text fixture")
    {
        return Err("No se conservó el texto del portapapeles.".into());
    }
    board.clearContents();
    Ok(())
}

#[cfg(feature = "test-tools")]
pub fn roundtrip(files: &[PathBuf]) -> Result<(), String> {
    autoreleasepool(|_| board_roundtrip(&NSPasteboard::generalPasteboard(), files))
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_app_kit::NSPasteboardItem;

    #[test]
    fn native_roundtrip_uses_private_named_pasteboard_only() {
        autoreleasepool(|_| {
            let root = tempfile::tempdir().unwrap();
            let files: Vec<_> = ["Video ñ 中文 💾.mp4", "segundo video.mp4"]
                .iter()
                .map(|name| {
                    let file = root.path().join(name);
                    std::fs::write(&file, b"synthetic fixture").unwrap();
                    file.canonicalize().unwrap()
                })
                .collect();
            let board = NSPasteboard::pasteboardWithUniqueName();
            board_roundtrip(&board, &files).unwrap();
        });
    }

    #[test]
    fn native_mixed_item_and_outside_files_are_preserved() {
        autoreleasepool(|_| {
            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("own.mp4");
            std::fs::write(&file, b"fixture").unwrap();
            let file = file.canonicalize().unwrap();
            let board = NSPasteboard::pasteboardWithUniqueName();
            let item = NSPasteboardItem::new();
            let url = NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(file.to_str().unwrap()),
                false,
            );
            assert!(
                item.setString_forType(&url.absoluteString().unwrap(), unsafe {
                    NSPasteboardTypeFileURL
                })
            );
            assert!(
                item.setString_forType(&NSString::from_str("unrelated text"), unsafe {
                    NSPasteboardTypeString
                })
            );
            let objects: &[&ProtocolObject<dyn NSPasteboardWriting>] =
                &[ProtocolObject::from_ref(&*item)];
            board.clearContents();
            assert!(board.writeObjects(&NSArray::from_slice(objects)));
            let count = board.changeCount();
            assert!(!clear_board_if_within(
                &board,
                &root.path().canonicalize().unwrap()
            ));
            assert_eq!(board.changeCount(), count);
            assert_eq!(
                board
                    .stringForType(unsafe { NSPasteboardTypeString })
                    .unwrap()
                    .to_string(),
                "unrelated text"
            );

            write_files(&board, &[file]).unwrap();
            let count = board.changeCount();
            let other = tempfile::tempdir().unwrap();
            assert!(!clear_board_if_within(
                &board,
                &other.path().canonicalize().unwrap()
            ));
            assert_eq!(board.changeCount(), count);
            board.clearContents();
        });
    }

    #[test]
    fn native_cleanup_accepts_unicode_root_using_native_path_normalization() {
        autoreleasepool(|_| {
            let parent = tempfile::tempdir().unwrap();
            let root = parent.path().join("carpeta ñ 中文");
            std::fs::create_dir(&root).unwrap();
            let file = root.join("video.mp4");
            std::fs::write(&file, b"fixture").unwrap();
            let files = validate(&[file]).unwrap();
            let board = NSPasteboard::pasteboardWithUniqueName();
            write_files(&board, &files).unwrap();
            assert!(clear_board_if_within(&board, &root.canonicalize().unwrap()));
        });
    }

    #[test]
    fn native_cleanup_preserves_content_replaced_after_snapshot() {
        autoreleasepool(|_| {
            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("fixture.mp4");
            std::fs::write(&file, b"fixture").unwrap();
            let files = validate(&[file]).unwrap();
            let board = NSPasteboard::pasteboardWithUniqueName();
            write_files(&board, &files).unwrap();
            let before = board.changeCount();
            let snapshot = read_files(&board).unwrap();
            board.clearContents();
            assert!(
                board.setString_forType(&NSString::from_str("new user content"), unsafe {
                    NSPasteboardTypeString
                })
            );
            assert!(!clear_snapshot(
                &board,
                &root.path().canonicalize().unwrap(),
                before,
                &snapshot
            ));
            assert_eq!(
                board
                    .stringForType(unsafe { NSPasteboardTypeString })
                    .unwrap()
                    .to_string(),
                "new user content"
            );
            board.clearContents();
        });
    }
}
