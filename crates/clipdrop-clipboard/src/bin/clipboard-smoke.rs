use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() -> Result<(), String> {
    if std::env::var("CI").as_deref() != Ok("true") {
        return Err("Este smoke reemplaza el portapapeles y sólo se permite en CI.".into());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "ClipDropClipboardSmoke-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir(&root).map_err(|error| error.to_string())?;
    let result = (|| {
        let files: Vec<PathBuf> = ["Video ñ 中文 💾.mp4", "segundo video.mp4"]
            .iter()
            .map(|name| {
                let file = root.join(name);
                std::fs::write(&file, b"synthetic clipboard fixture")
                    .map_err(|error| error.to_string())?;
                file.canonicalize().map_err(|error| error.to_string())
            })
            .collect::<Result<_, String>>()?;
        clipdrop_clipboard::ci_roundtrip(&files)
    })();
    let _ = std::fs::remove_dir_all(&root);
    result?;
    println!("Native file clipboard roundtrip passed (no visible window, no video download).");
    Ok(())
}
