#![recursion_limit = "256"]

#[cfg(not(windows))]
fn main() {
    eprintln!("omni-bridge-service is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    if let Err(error) = windows::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
