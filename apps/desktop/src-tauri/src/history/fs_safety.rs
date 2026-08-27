use std::fs::Metadata;
use std::path::{Component, Path, PathBuf};

pub(super) fn canonical_archive_file(
    history_root: &Path,
    candidate: &Path,
) -> Result<Option<PathBuf>, String> {
    let canonical_root = canonical_history_root(history_root)?;
    let relative = candidate.strip_prefix(history_root).map_err(|_| {
        format!(
            "历史音频路径不在历史目录中：{}",
            candidate.display()
        )
    })?;
    let components = relative.components().collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("历史音频路径包含不安全分量：{}", candidate.display()));
    }

    let mut current = history_root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if is_link_or_reparse_point(&metadata) {
            return Err(format!(
                "历史音频路径经过链接或 reparse point：{}",
                current.display()
            ));
        }
        let is_final = index + 1 == components.len();
        if !is_final && !metadata.is_dir() {
            return Err(format!("历史音频父路径不是目录：{}", current.display()));
        }
        if is_final && !metadata.is_file() {
            return Err(format!("历史音频目标不是常规文件：{}", current.display()));
        }
    }

    let canonical_target = std::fs::canonicalize(&current).map_err(|error| error.to_string())?;
    if canonical_target == canonical_root || !canonical_target.starts_with(&canonical_root) {
        return Err(format!(
            "历史音频最终路径逃逸历史目录：{}",
            canonical_target.display()
        ));
    }
    Ok(Some(canonical_target))
}

pub(super) fn walk_regular_archive_files(history_root: &Path) -> Result<Vec<PathBuf>, String> {
    if !history_root.exists() {
        return Ok(Vec::new());
    }
    let canonical_root = canonical_history_root(history_root)?;
    let mut directories = vec![history_root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(directory) = directories.pop() {
        let canonical_directory = std::fs::canonicalize(&directory).map_err(|error| error.to_string())?;
        if !canonical_directory.starts_with(&canonical_root) {
            return Err(format!(
                "历史遍历目录逃逸历史目录：{}",
                canonical_directory.display()
            ));
        }
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if is_link_or_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                directories.push(path);
            } else if metadata.is_file() {
                let canonical_file = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
                if !canonical_file.starts_with(&canonical_root) {
                    return Err(format!(
                        "历史文件逃逸历史目录：{}",
                        canonical_file.display()
                    ));
                }
                files.push(path);
            }
        }
    }
    Ok(files)
}

/// Remove entries from the dedicated history root without ever traversing a
/// link, junction, or other reparse point. Link entries themselves are
/// unlinked; their targets are never touched.
pub(super) fn clear_history_contents(history_root: &Path) -> Result<(), String> {
    if !history_root.exists() {
        std::fs::create_dir_all(history_root).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let canonical_root = canonical_history_root(history_root)?;
    clear_directory_entries(history_root, &canonical_root)
}

fn clear_directory_entries(directory: &Path, canonical_root: &Path) -> Result<(), String> {
    let canonical_directory = std::fs::canonicalize(directory).map_err(|error| error.to_string())?;
    if !canonical_directory.starts_with(canonical_root) {
        return Err(format!(
            "历史清理目录逃逸历史目录：{}",
            canonical_directory.display()
        ));
    }
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if is_link_or_reparse_point(&metadata) {
            remove_link_entry(&path)?;
            continue;
        }
        if metadata.is_dir() {
            clear_directory_entries(&path, canonical_root)?;
            std::fs::remove_dir(&path).map_err(|error| error.to_string())?;
        } else if metadata.is_file() {
            let canonical_file = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
            if !canonical_file.starts_with(canonical_root) {
                return Err(format!(
                    "历史清理文件逃逸历史目录：{}",
                    canonical_file.display()
                ));
            }
            std::fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn remove_link_entry(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(file_error) => std::fs::remove_dir(path).map_err(|directory_error| {
            format!(
                "无法删除历史目录中的链接 {}：file={file_error}; directory={directory_error}",
                path.display()
            )
        }),
    }
}

fn canonical_history_root(history_root: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(history_root).map_err(|error| {
        format!(
            "无法读取字幕历史目录 {}：{error}",
            history_root.display()
        )
    })?;
    if is_link_or_reparse_point(&metadata) {
        return Err(format!(
            "字幕历史根目录不能是链接或 reparse point：{}",
            history_root.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "字幕历史根路径不是目录：{}",
            history_root.display()
        ));
    }
    std::fs::canonicalize(history_root).map_err(|error| {
        format!(
            "无法解析字幕历史目录 {}：{error}",
            history_root.display()
        )
    })
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_file_rejects_parent_directory_escape() {
        let sandbox = tempfile::tempdir().unwrap();
        let history = sandbox.path().join("history");
        std::fs::create_dir_all(&history).unwrap();
        let outside = sandbox.path().join("outside.flac.enc");
        std::fs::write(&outside, b"outside").unwrap();

        assert!(canonical_archive_file(&history, &history.join("..").join("outside.flac.enc"))
            .is_err());
        assert!(outside.exists());
    }

    #[test]
    fn traversal_does_not_follow_directory_link_escape() {
        let sandbox = tempfile::tempdir().unwrap();
        let history = sandbox.path().join("history");
        let outside = sandbox.path().join("outside");
        std::fs::create_dir_all(&history).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let escaped_file = outside.join("escaped.flac.enc");
        std::fs::write(&escaped_file, b"outside").unwrap();
        let link = history.join("linked");
        if let Err(error) = create_directory_link(&outside, &link) {
            eprintln!("directory-link test unavailable on this host: {error}");
            return;
        }

        assert!(walk_regular_archive_files(&history).unwrap().is_empty());
        assert!(canonical_archive_file(&history, &link.join("escaped.flac.enc")).is_err());
        assert!(escaped_file.exists());
        remove_directory_link(&link).unwrap();
    }

    #[test]
    fn clear_does_not_delete_directory_link_target() {
        let sandbox = tempfile::tempdir().unwrap();
        let history = sandbox.path().join("history");
        let outside = sandbox.path().join("outside");
        std::fs::create_dir_all(&history).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("keep.flac.enc");
        std::fs::write(&outside_file, b"outside").unwrap();
        std::fs::write(history.join("subtitle-history.db"), b"db").unwrap();
        let link = history.join("linked");
        if let Err(error) = create_directory_link(&outside, &link) {
            eprintln!("directory-link test unavailable on this host: {error}");
            return;
        }

        clear_history_contents(&history).unwrap();

        assert!(outside_file.exists());
        assert!(std::fs::read_dir(&history).unwrap().next().is_none());
    }

    #[test]
    fn linked_history_root_is_rejected_without_touching_target() {
        let sandbox = tempfile::tempdir().unwrap();
        let outside = sandbox.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("keep.flac.enc");
        std::fs::write(&outside_file, b"outside").unwrap();
        let history_link = sandbox.path().join("history");
        if let Err(error) = create_directory_link(&outside, &history_link) {
            eprintln!("directory-link test unavailable on this host: {error}");
            return;
        }

        assert!(walk_regular_archive_files(&history_link).is_err());
        assert!(clear_history_contents(&history_link).is_err());
        assert!(outside_file.exists());
        remove_directory_link(&history_link).unwrap();
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(windows)]
    fn remove_directory_link(link: &Path) -> std::io::Result<()> {
        std::fs::remove_dir(link)
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(unix)]
    fn remove_directory_link(link: &Path) -> std::io::Result<()> {
        std::fs::remove_file(link)
    }
}
