use clipdrop_core::{
    build_arguments, download, find_executable, parse_line, Cancellation, DownloadEvent,
    DownloadRequest, ParsedLine, TemporaryStorage, CANCELLED,
};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn request(root: &Path, mode: &str) -> DownloadRequest {
    DownloadRequest {
        url: format!("https://fixture.invalid/{mode}"),
        destination: root.to_owned(),
        browser: None,
    }
}
fn executable() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_fixture-downloader"))
}

#[test]
fn arguments_validate_and_preserve_literal_values() {
    let root = tempfile::tempdir().unwrap();
    for invalid in [
        "--exec=bad",
        "file:///private",
        "ftp://example.com/a",
        "https://",
        "https://x.com/space here",
        "https://x.com/a\n--exec=bad",
        "https://x.com/\0",
    ] {
        let mut req = request(root.path(), "ok");
        req.url = invalid.into();
        assert!(build_arguments(&req, None).is_err(), "{invalid}");
    }
    let mut req = request(root.path(), "ok");
    req.browser = Some("chrome;touch pwned".into());
    assert!(build_arguments(&req, None).is_err());
    req.browser = Some("brave".into());
    req.url = "https://x.com/user/status/123?a=$(touch%20PWN)&b=1;other".into();
    let args = build_arguments(&req, None).unwrap();
    assert_eq!(args.last().unwrap(), req.url.as_str());
    assert_eq!(args[args.len() - 2], "--");
    assert!(args.contains(&"--no-overwrites".into()));
    assert!(args.contains(&"--ignore-config".into()));
    assert!(args.contains(&"--no-cache-dir".into()));
    assert!(args.contains(&"b[ext=mp4]/b".into()));
    assert!(!args.contains(&"--merge-output-format".into()));
    let args = build_arguments(&req, Some(Path::new("/tools/ffmpeg"))).unwrap();
    assert!(args.contains(&"--merge-output-format".into()));
    assert!(find_executable("../bad").is_none());
    req.destination = PathBuf::from("relative");
    assert!(build_arguments(&req, None).is_err());
}

#[test]
fn parser_rejects_malformed_markers_and_clamps_progress() {
    assert_eq!(
        parse_line("CLIPDROP_PROGRESS: 42.5%\r"),
        Some(ParsedLine::Event(DownloadEvent::Progress { value: 0.425 }))
    );
    assert_eq!(
        parse_line("CLIPDROP_PROGRESS:120%"),
        Some(ParsedLine::Event(DownloadEvent::Progress { value: 1.0 }))
    );
    assert_eq!(
        parse_line("CLIPDROP_PROGRESS:-10%"),
        Some(ParsedLine::Event(DownloadEvent::Progress { value: 0.0 }))
    );
    for value in ["NaN", "NA", "", "Infinity"] {
        assert_eq!(parse_line(&format!("CLIPDROP_PROGRESS:{value}")), None);
    }
    for value in ["{bad", "123", "\"\""] {
        assert_eq!(parse_line(&format!("CLIPDROP_FILE:{value}")), None);
    }
    let path = PathBuf::from("/Vídeos/Mañana 🎬.mp4");
    assert_eq!(
        parse_line(&format!(
            "CLIPDROP_FILE:{}",
            serde_json::to_string(&path).unwrap()
        )),
        Some(ParsedLine::File(path))
    );
}

#[test]
fn fake_cli_drains_pipes_returns_unicode_and_literal_args() {
    let root = tempfile::tempdir().unwrap();
    let mut req = request(root.path(), "drain");
    req.url += "?a=$(touch%20PWN)&b=1";
    let mut events = Vec::new();
    let files = download(executable(), None, &req, &Cancellation::new(), |event| {
        events.push(event)
    })
    .unwrap();
    assert_eq!(
        files,
        [fs::canonicalize(root.path().join("Mañana 🎬 [123].mp4")).unwrap()]
    );
    assert!(events.contains(&DownloadEvent::Progress { value: 0.5 }));
    assert_eq!(events.len(), 6001);
    let args: Vec<String> =
        serde_json::from_slice(&fs::read(root.path().join("args.json")).unwrap()).unwrap();
    assert_eq!(args.last().unwrap(), &req.url);
    assert!(!root.path().join("PWN").exists());
}

#[test]
fn failures_and_escaped_results_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("destination");
    for (mode, expected) in [
        ("error", "fixture unavailable"),
        ("empty-error", "estado"),
        ("no-file", "sin devolver"),
        ("malformed", "sin devolver"),
        ("outside", "fuera de la carpeta"),
        ("zero", "vacío"),
        ("relative", "ruta de archivo inválida"),
    ] {
        let result = download(
            executable(),
            None,
            &request(&destination, mode),
            &Cancellation::new(),
            |_| {},
        );
        assert!(result.unwrap_err().contains(expected), "{mode}");
    }
    let result = download(
        &root.path().join("missing"),
        None,
        &request(&destination, "ok"),
        &Cancellation::new(),
        |_| {},
    );
    assert!(result.unwrap_err().contains("No se pudo ejecutar"));
}

#[test]
fn long_output_is_bounded_and_duplicates_are_deduplicated() {
    let root = tempfile::tempdir().unwrap();
    let mut max = 0;
    let files = download(
        executable(),
        None,
        &request(root.path(), "long-line"),
        &Cancellation::new(),
        |event| {
            if let DownloadEvent::Message { message } = event {
                max = max.max(message.chars().count());
            }
        },
    )
    .unwrap();
    assert_eq!(files.len(), 1);
    assert!(max <= 2000);
    assert_eq!(
        download(
            executable(),
            None,
            &request(root.path(), "duplicate"),
            &Cancellation::new(),
            |_| {}
        )
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn cancellation_before_spawn_makes_no_files_and_does_not_poison_future_jobs() {
    let root = tempfile::tempdir().unwrap();
    let cancel = Cancellation::new();
    cancel.cancel();
    let destination = root.path().join("not-created");
    assert_eq!(
        download(
            executable(),
            None,
            &request(&destination, "ok"),
            &cancel,
            |_| {}
        )
        .unwrap_err(),
        CANCELLED
    );
    assert!(!destination.exists());
    assert!(download(
        executable(),
        None,
        &request(&destination, "ok"),
        &Cancellation::new(),
        |_| {}
    )
    .is_ok());
}

#[test]
fn cancellation_stops_parent_and_descendant_preserves_permanent_files() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("preserve.mp4"), b"existing").unwrap();
    let cancel = Cancellation::new();
    let began = Instant::now();
    let result = download(
        executable(),
        None,
        &request(root.path(), "cancel-tree"),
        &cancel,
        |event| {
            if event
                == (DownloadEvent::Message {
                    message: "STARTED".into(),
                })
            {
                cancel.cancel();
            }
        },
    );
    assert_eq!(result.unwrap_err(), CANCELLED);
    assert!(began.elapsed() < Duration::from_secs(5));
    std::thread::sleep(Duration::from_millis(850));
    assert!(!root.path().join("child-survived").exists());
    assert_eq!(
        fs::read(root.path().join("preserve.mp4")).unwrap(),
        b"existing"
    );
}

#[test]
fn storage_cleans_owned_jobs_preserving_saved_and_unknown_paths() {
    let root = tempfile::tempdir().unwrap();
    let storage = TemporaryStorage::new(root.path().join("cache")).unwrap();
    let job = storage.create().unwrap();
    fs::write(job.join("video.mp4"), b"video").unwrap();
    fs::write(root.path().join("saved.mp4"), b"preserve").unwrap();
    fs::create_dir(storage.root().join("unknown")).unwrap();
    fs::write(storage.root().join("unknown/data"), b"data").unwrap();
    assert_eq!(storage.bytes().unwrap(), 9);
    assert!(storage.contains(&job.join("video.mp4")));
    assert!(!storage.contains(storage.root()));
    assert!(!storage.contains(&storage.root().join("../saved.mp4")));
    assert!(storage.remove_job(root.path()).is_err());
    assert!(storage.remove_job(&storage.root().join("unknown")).is_err());
    storage.clean().unwrap();
    assert!(!job.exists());
    assert_eq!(
        fs::read(root.path().join("saved.mp4")).unwrap(),
        b"preserve"
    );
    assert_eq!(storage.bytes().unwrap(), 4);
}

#[cfg(unix)]
#[test]
fn symlink_escapes_are_rejected_and_cleanup_never_traverses_them() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("outside.mp4"), b"preserve").unwrap();
    fs::create_dir(root.path().join("destination")).unwrap();
    symlink(
        root.path().join("outside.mp4"),
        root.path().join("destination/alias.mp4"),
    )
    .unwrap();
    let result = download(
        executable(),
        None,
        &request(&root.path().join("destination"), "symlink"),
        &Cancellation::new(),
        |_| {},
    );
    assert!(result.unwrap_err().contains("fuera de la carpeta"));
    let storage = TemporaryStorage::new(root.path().join("cache")).unwrap();
    symlink(
        root.path().join("destination"),
        storage.root().join("transfer-link"),
    )
    .unwrap();
    assert_eq!(storage.bytes().unwrap(), 0);
    storage.clean().unwrap();
    assert!(root.path().join("destination/alias.mp4").exists());
    assert_eq!(
        fs::read(root.path().join("outside.mp4")).unwrap(),
        b"preserve"
    );
    symlink(root.path().join("cache"), root.path().join("alias")).unwrap();
    let aliased = TemporaryStorage::new(root.path().join("alias")).unwrap();
    assert_eq!(aliased.root(), storage.root());
}
