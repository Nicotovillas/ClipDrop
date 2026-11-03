//! Window-free downloader and private temporary storage. Never runs a shell.
mod engine;
mod storage;

pub use engine::{
    build_arguments, download, find_executable, parse_line, search_directories, Cancellation,
    DownloadEvent, DownloadRequest, ParsedLine, CANCELLED,
};
pub use storage::TemporaryStorage;
