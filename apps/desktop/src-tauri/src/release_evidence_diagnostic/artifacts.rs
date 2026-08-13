use std::fs;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactHash {
    pub(super) path: String,
    pub(super) kind: String,
    pub(super) sha256: String,
    pub(super) file_count: usize,
    pub(super) byte_count: u64,
}

pub(super) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

pub(super) fn hash_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) fn hash_artifact(path: &Path, relative: &str) -> Result<ArtifactHash, String> {
    if path.is_file() {
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        return Ok(ArtifactHash {
            path: relative.replace('\\', "/"),
            kind: "file".to_string(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            file_count: 1,
            byte_count: bytes.len() as u64,
        });
    }
    if !path.is_dir() {
        return Err(format!("evidence artifact is unavailable: {}", path.display()));
    }
    let mut digest = Sha256::new();
    let mut byte_count = 0_u64;
    let mut records = Vec::new();
    for file in walk_files(path)? {
        let relative_path = file
            .strip_prefix(path)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        records.push((relative_path, file));
    }
    records.sort_by(|left, right| left.0.cmp(&right.0));
    for (relative_path, file) in &records {
        let bytes = fs::read(file).map_err(|error| error.to_string())?;
        byte_count += bytes.len() as u64;
        digest.update(b"file\0");
        digest.update(relative_path.as_bytes());
        digest.update(b"\0");
        digest.update(bytes.len().to_string().as_bytes());
        digest.update(b"\0");
        digest.update(&bytes);
        digest.update(b"\0");
    }
    Ok(ArtifactHash {
        path: relative.replace('\\', "/"),
        kind: "directory".to_string(),
        sha256: format!("{:x}", digest.finalize()),
        file_count: records.len(),
        byte_count,
    })
}

pub(super) fn walk_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "release evidence may not contain symbolic links: {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            files.extend(walk_files(&entry.path())?);
        } else if file_type.is_file() {
            files.push(entry.path());
        }
    }
    Ok(files)
}

pub(super) fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err(format!("evidence target already exists: {}", target.display()));
    }
    fs::create_dir(target).map_err(|error| error.to_string())?;
    let mut entries = fs::read_dir(source)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(format!(
                "diagnostics bundle may not contain symbolic links: {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
