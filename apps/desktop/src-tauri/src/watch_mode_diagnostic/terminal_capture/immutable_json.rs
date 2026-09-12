use std::io::Write;

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImmutableJsonReceipt {
    pub(crate) relative_path: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImmutableJsonWriteError {
    code: &'static str,
    detail: String,
}

impl std::fmt::Display for ImmutableJsonWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

fn immutable_write_error(
    code: &'static str,
    label: &str,
    output_path: &str,
    error: impl std::fmt::Display,
) -> ImmutableJsonWriteError {
    ImmutableJsonWriteError {
        code,
        detail: format!("{label} {output_path}: {error}"),
    }
}

pub(crate) fn write_json_immutable<T: Serialize>(
    output_path: &str,
    label: &str,
    value: &T,
) -> Result<ImmutableJsonReceipt, ImmutableJsonWriteError> {
    let path = std::path::PathBuf::from(output_path);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| immutable_write_error("invalid-path", label, output_path, "path has no file name"))?;
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| immutable_write_error("create-parent-failed", label, output_path, error))?;
    }
    if path.exists() {
        return Err(immutable_write_error(
            "immutable-exists",
            label,
            output_path,
            "immutable target already exists",
        ));
    }
    let temporary_path = path.with_file_name(format!(
        ".{file_name}.{}.tmp",
        Uuid::new_v4().simple()
    ));
    let result = write_and_publish(&path, &temporary_path, file_name, label, output_path, value);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

fn write_and_publish<T: Serialize>(
    path: &std::path::Path,
    temporary_path: &std::path::Path,
    file_name: &str,
    label: &str,
    output_path: &str,
    value: &T,
) -> Result<ImmutableJsonReceipt, ImmutableJsonWriteError> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|error| immutable_write_error("serialize-failed", label, output_path, error))?;
    let byte_length = u64::try_from(json.len())
        .map_err(|error| immutable_write_error("length-overflow", label, output_path, error))?;
    let sha256 = format!("{:x}", Sha256::digest(&json));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_path)
        .map_err(|error| immutable_write_error("create-temp-failed", label, output_path, error))?;
    file.write_all(&json)
        .map_err(|error| immutable_write_error("write-failed", label, output_path, error))?;
    file.sync_all()
        .map_err(|error| immutable_write_error("sync-failed", label, output_path, error))?;
    drop(file);
    std::fs::hard_link(temporary_path, path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::AlreadyExists {
            "immutable-exists"
        } else {
            "publish-failed"
        };
        immutable_write_error(code, label, output_path, error)
    })?;
    std::fs::remove_file(temporary_path)
        .map_err(|error| immutable_write_error("remove-temp-failed", label, output_path, error))?;
    Ok(ImmutableJsonReceipt {
        relative_path: file_name.to_string(),
        byte_length,
        sha256,
    })
}
