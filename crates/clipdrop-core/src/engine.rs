use serde::Serialize;
use std::{
    collections::VecDeque,
    env,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};

pub const CANCELLED: &str = "Descarga cancelada.";
const PROGRESS: &str = "CLIPDROP_PROGRESS:";
const FILE: &str = "CLIPDROP_FILE:";
const MAX_LINE: usize = 64 * 1024;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug)]
pub struct DownloadRequest {
    pub url: String,
    pub destination: PathBuf,
    pub browser: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { value: f64 },
    Message { message: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ParsedLine {
    Event(DownloadEvent),
    File(PathBuf),
}

pub fn search_directories() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|v| {
            env::split_paths(&v)
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    #[cfg(windows)]
    {
        if let Some(v) = env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(v).join("Microsoft/WinGet/Links"));
        }
        if let Some(v) = env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(v).join("scoop/shims"));
        }
    }
    #[cfg(not(windows))]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    let mut unique = Vec::new();
    for dir in dirs {
        if !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

pub fn find_executable(name: &str) -> Option<PathBuf> {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    if stem.is_empty()
        || !stem
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return None;
    }
    let filename = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.into()
    };
    search_directories()
        .into_iter()
        .map(|p| p.join(&filename))
        .find(|p| {
            let Ok(meta) = fs::metadata(p) else {
                return false;
            };
            if !meta.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}

pub fn build_arguments(
    request: &DownloadRequest,
    ffmpeg: Option<&Path>,
) -> Result<Vec<OsString>, String> {
    if request.url.is_empty()
        || request.url.len() > 8192
        || request
            .url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Ingresá un enlace completo que empiece con https:// o http://.".into());
    }
    let url = url::Url::parse(&request.url).map_err(|_| "El enlace del video no es válido.")?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("El enlace del video debe empezar con https:// o http://.".into());
    }
    if !request.destination.is_absolute()
        || request
            .destination
            .as_os_str()
            .to_string_lossy()
            .contains('\0')
    {
        return Err("Elegí una carpeta local para guardar el video.".into());
    }
    if let Some(browser) = request.browser.as_deref().filter(|v| !v.is_empty()) {
        if ![
            "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
        ]
        .contains(&browser)
        {
            return Err("El navegador elegido no es compatible.".into());
        }
    }
    let format = if ffmpeg.is_some() {
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best"
    } else {
        "b[ext=mp4]/b"
    };
    let mut args: Vec<OsString> = [
        "--ignore-config",
        "--no-cache-dir",
        "--no-playlist",
        "--no-overwrites",
        "--newline",
        "--no-colors",
        "--progress",
        "--progress-template",
        "download:CLIPDROP_PROGRESS:%(progress._percent_str)s",
        "--print",
        "after_move:CLIPDROP_FILE:%(filepath)j",
        "--format",
        format,
        "--format-sort",
        "vcodec:h264,res,acodec:aac",
        "--paths",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.push(request.destination.as_os_str().into());
    args.extend(["--output", "%(title).120B [%(id)s].%(ext)s"].map(OsString::from));
    if let Some(path) = ffmpeg {
        args.push("--ffmpeg-location".into());
        args.push(path.as_os_str().into());
        args.extend(["--merge-output-format", "mp4"].map(OsString::from));
    }
    if let Some(browser) = request.browser.as_ref().filter(|v| !v.is_empty()) {
        args.push("--cookies-from-browser".into());
        args.push(browser.into());
    }
    args.push("--".into());
    args.push(request.url.clone().into());
    Ok(args)
}

pub fn parse_line(line: &str) -> Option<ParsedLine> {
    let line = line.trim_end_matches('\r');
    if line.is_empty() {
        return None;
    }
    if let Some(raw) = line.strip_prefix(PROGRESS) {
        let value = raw.trim().trim_end_matches('%').parse::<f64>().ok()?;
        return value
            .is_finite()
            .then_some(ParsedLine::Event(DownloadEvent::Progress {
                value: (value / 100.0).clamp(0.0, 1.0),
            }));
    }
    if let Some(raw) = line.strip_prefix(FILE) {
        let value: String = serde_json::from_str(raw).ok()?;
        return (!value.is_empty()).then_some(ParsedLine::File(value.into()));
    }
    Some(ParsedLine::Event(DownloadEvent::Message {
        message: line.chars().take(2000).collect(),
    }))
}

enum PipeEvent {
    Line(String),
    End,
    Error(String),
}
fn read_pipe(mut pipe: impl Read, sender: mpsc::SyncSender<PipeEvent>) {
    let mut chunk = [0u8; 8192];
    let mut pending = Vec::new();
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                for &byte in &chunk[..n] {
                    if byte == b'\n' || pending.len() == MAX_LINE {
                        if sender
                            .send(PipeEvent::Line(
                                String::from_utf8_lossy(&pending).into_owned(),
                            ))
                            .is_err()
                        {
                            return;
                        }
                        pending.clear();
                    }
                    if byte != b'\n' {
                        pending.push(byte);
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(PipeEvent::Error(error.to_string()));
                break;
            }
        }
    }
    if !pending.is_empty() {
        let _ = sender.send(PipeEvent::Line(
            String::from_utf8_lossy(&pending).into_owned(),
        ));
    }
    let _ = sender.send(PipeEvent::End);
}

fn configure_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn stop_tree(child: &mut Child, pid: u32) {
    #[cfg(unix)]
    {
        // This child is a process-group leader created above. Its descendants,
        // including ffmpeg, inherit the group. No unrelated group is targeted.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system = env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| "C:\\Windows".into());
        let result = Command::new(system.join("System32/taskkill.exe"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !result.is_ok_and(|s| s.success()) {
            let _ = child.kill();
        }
    }
}

/// Blocking operation; call on a worker thread. A bounded channel drains both
/// pipes concurrently. Cancellation remains effective while a pipe is quiet.
pub fn download(
    executable: &Path,
    ffmpeg: Option<&Path>,
    request: &DownloadRequest,
    cancellation: &Cancellation,
    mut on_event: impl FnMut(DownloadEvent),
) -> Result<Vec<PathBuf>, String> {
    cancellation.check()?;
    let args = build_arguments(request, ffmpeg)?;
    cancellation.check()?;
    fs::create_dir_all(&request.destination)
        .map_err(|e| format!("No se pudo crear la carpeta elegida: {e}"))?;
    let root = fs::canonicalize(&request.destination)
        .map_err(|e| format!("No se pudo abrir la carpeta elegida: {e}"))?;
    cancellation.check()?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Ok(path) = env::join_paths(search_directories()) {
        command.env("PATH", path);
    }
    configure_process(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar yt-dlp: {e}"))?;
    let pid = child.id();
    let (sender, receiver) = mpsc::sync_channel(64);
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_sender = sender.clone();
    let stdout = thread::spawn(move || read_pipe(stdout, out_sender));
    let stderr = thread::spawn(move || read_pipe(stderr, sender));
    let mut files = Vec::new();
    let mut diagnostics = VecDeque::new();
    let mut ended = 0;
    let mut status = None;
    let mut stopped = false;
    let mut failure = None;
    while ended < 2 || status.is_none() {
        if cancellation.is_cancelled() && !stopped {
            stop_tree(&mut child, pid);
            stopped = true;
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(PipeEvent::Line(line)) => match parse_line(&line) {
                Some(ParsedLine::File(path)) => {
                    if !files.contains(&path) {
                        files.push(path);
                    }
                }
                Some(ParsedLine::Event(event)) => {
                    if let DownloadEvent::Message { message } = &event {
                        diagnostics.push_back(message.clone());
                        if diagnostics.len() > 12 {
                            diagnostics.pop_front();
                        }
                    }
                    // An observer panic must not leave the subprocess running.
                    let _ =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_event(event)));
                }
                None => (),
            },
            Ok(PipeEvent::End) => ended += 1,
            Ok(PipeEvent::Error(error)) => {
                failure.get_or_insert(error);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => ended = 2,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => {
                    stop_tree(&mut child, pid);
                    failure.get_or_insert(error.to_string());
                    status = child.wait().ok();
                    if status.is_none() {
                        break;
                    }
                }
            }
        }
        if ended == 2 && status.is_none() {
            thread::sleep(Duration::from_millis(10));
        }
    }
    let _ = stdout.join();
    let _ = stderr.join();
    cancellation.check()?;
    if let Some(error) = failure {
        return Err(format!("No se pudo ejecutar yt-dlp: {error}"));
    }
    let status = status.ok_or("No se pudo obtener el resultado de yt-dlp.")?;
    if !status.success() {
        let detail = if diagnostics.is_empty() {
            format!("yt-dlp terminó con estado {status}.")
        } else {
            diagnostics.into_iter().collect::<Vec<_>>().join("\n")
        };
        return Err(format!("No se pudo descargar el video.\n{detail}"));
    }
    let mut verified = Vec::new();
    for file in files {
        cancellation.check()?;
        if !file.is_absolute() {
            return Err("yt-dlp devolvió una ruta de archivo inválida.".into());
        }
        let actual = fs::canonicalize(file)
            .map_err(|e| format!("El archivo descargado no está disponible: {e}"))?;
        if actual == root || !actual.starts_with(&root) {
            return Err("yt-dlp devolvió un archivo fuera de la carpeta elegida.".into());
        }
        let meta = fs::metadata(&actual).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() == 0 {
            return Err("El video descargado está vacío o no es un archivo.".into());
        }
        if !verified.contains(&actual) {
            verified.push(actual);
        }
    }
    cancellation.check()?;
    if verified.is_empty() {
        return Err("yt-dlp terminó sin devolver un archivo descargado.".into());
    }
    Ok(verified)
}
