//! Synthetic downloader for finite, cross-platform tests. Never accesses network.
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process::{self, Command, Stdio},
    thread,
    time::Duration,
};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().is_some_and(|v| v == "--fixture-child") {
        thread::sleep(Duration::from_millis(650));
        fs::write(&args[1], b"child escaped").unwrap();
        thread::sleep(Duration::from_secs(15));
        return;
    }
    let root = PathBuf::from(&args[args.iter().position(|v| v == "--paths").unwrap() + 1]);
    let url = args.last().unwrap();
    let mode = url::Url::parse(url)
        .unwrap()
        .path()
        .trim_start_matches('/')
        .to_owned();
    fs::write(root.join("args.json"), serde_json::to_vec(&args).unwrap()).unwrap();
    match mode.as_str() {
        "error" => {
            eprintln!("ERROR: fixture unavailable");
            process::exit(2);
        }
        "empty-error" => process::exit(7),
        "no-file" => return,
        "malformed" => {
            println!("CLIPDROP_FILE:{{bad");
            return;
        }
        "relative" => {
            println!("CLIPDROP_FILE:\"relative.mp4\"");
            return;
        }
        "drain" => {
            for i in 0..3000 {
                println!("stdout diagnostic {i}");
                eprintln!("stderr diagnostic {i}");
            }
        }
        "long-line" => {
            print!("{}", "ñ".repeat(100_000));
            io::stdout().flush().unwrap();
        }
        "cancel" | "cancel-tree" => {
            if mode == "cancel-tree" {
                let child = Command::new(env::current_exe().unwrap())
                    .arg("--fixture-child")
                    .arg(root.join("child-survived"))
                    .stdin(Stdio::null())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                // Deliberately keep the descendant alive; engine owns the tree.
                drop(child);
            }
            println!("STARTED");
            io::stdout().flush().unwrap();
            thread::sleep(Duration::from_secs(20));
            return;
        }
        _ => (),
    }
    let file = if mode == "outside" {
        root.parent().unwrap().join("outside.mp4")
    } else {
        root.join("Mañana 🎬 [123].mp4")
    };
    if mode == "symlink" {
        // Test creates the alias beforehand. Never overwrite or follow it here.
        let alias = root.join("alias.mp4");
        println!("CLIPDROP_FILE:{}", serde_json::to_string(&alias).unwrap());
        return;
    }
    fs::write(
        &file,
        if mode == "zero" {
            b"".as_slice()
        } else {
            b"synthetic video fixture"
        },
    )
    .unwrap();
    println!("CLIPDROP_PROGRESS:50%");
    println!("CLIPDROP_FILE:{}", serde_json::to_string(&file).unwrap());
    if mode == "duplicate" {
        println!("CLIPDROP_FILE:{}", serde_json::to_string(&file).unwrap());
    }
}
