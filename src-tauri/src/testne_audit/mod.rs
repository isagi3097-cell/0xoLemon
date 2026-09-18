//! Original, test-only experiments informed by the testne audit.
//! No command registration, binary loading, network provider, or live Steam path.

pub(crate) mod metadata;
pub(crate) mod runtime;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

const LAB_BUDGET_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const FREE_SPACE_FLOOR_BYTES: u64 = 10 * 1024 * 1024 * 1024;

pub(crate) fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(crate) fn read_bounded(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Laboratory file exceeds read budget",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Laboratory file grew beyond read budget",
        ));
    }
    Ok(bytes)
}

/// A laboratory capability created only for a fresh directory. Callers cannot
/// turn an existing Steam/testne directory into a fixture by passing its path.
#[derive(Clone)]
pub(crate) struct LabRoot {
    path: PathBuf,
    identity: String,
}

impl LabRoot {
    pub fn approved_parent() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(r"C:\Users\conte\CodexLabs\testne-audit")
        }
        #[cfg(not(windows))]
        {
            std::env::temp_dir().join("testne-audit-laboratory")
        }
    }

    pub fn create(parent: &Path) -> Result<Self, String> {
        // The parent is a fixed, explicitly approved laboratory, not a caller-
        // selected game/Steam folder or a filename inferred from a sample.
        let approved = Self::approved_parent();
        if parent != approved {
            return Err("Unapproved laboratory parent".into());
        }
        for ancestor in parent.ancestors().filter(|path| path.exists()) {
            reject_links(ancestor)?;
        }
        fs::create_dir_all(parent).map_err(err)?;
        check_disk_budget(parent, 0)?;
        let identity = Uuid::new_v4().to_string();
        let path = parent.join(format!("testne-audit-{identity}"));
        fs::create_dir(&path).map_err(err)?;
        let root = Self { path, identity };
        root.write_new("lab-marker", root.identity.as_bytes())?;
        Ok(root)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn validate(&self) -> Result<(), String> {
        reject_links(&self.path)?;
        let marker = self.path.join("lab-marker");
        reject_links(&marker)?;
        if read_bounded(&marker, 128).map_err(err)? != self.identity.as_bytes() {
            return Err("Laboratory identity changed".into());
        }
        Ok(())
    }

    pub fn file(&self, name: &str) -> Result<PathBuf, String> {
        let device = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let numbered_device = ["COM", "LPT"].iter().any(|prefix| {
            device.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
            })
        });
        if name.is_empty()
            || name.len() > 180
            || name.ends_with('.')
            || matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || numbered_device
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
            || Path::new(name).components().count() != 1
            || name == "."
            || name == ".."
        {
            return Err("Only one exact laboratory filename is accepted".into());
        }
        let path = self.path.join(name);
        reject_links(&self.path)?;
        if path.exists() {
            reject_links(&path)?;
        }
        Ok(path)
    }

    pub fn write_new(&self, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
        let path = self.file(name)?;
        check_disk_budget(&Self::approved_parent(), bytes.len() as u64)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.sync_all().map_err(err)?;
        Ok(path)
    }

    pub fn write_atomic(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.validate()?;
        let target = self.file(name)?;
        let stage = self.write_new(&format!("stage-{}", Uuid::new_v4()), bytes)?;
        replace_file(&stage, &target)
    }
}

fn check_disk_budget(parent: &Path, additional: u64) -> Result<(), String> {
    if fs2::available_space(parent).map_err(err)?
        < FREE_SPACE_FLOOR_BYTES.saturating_add(additional)
    {
        return Err("Laboratory requires a 10 GiB free-space floor".into());
    }
    let mut used = 0_u64;
    for entry in walkdir::WalkDir::new(parent).follow_links(false) {
        // Independent laboratory tests atomically rename their own stage files.
        // A vanished entry consumes no remaining budget; access/link errors must
        // still fail closed. Enumeration is an admission estimate, not a snapshot.
        let entry = match entry {
            Ok(entry) => entry,
            Err(error)
                if error
                    .io_error()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue
            }
            Err(error) => return Err(err(error)),
        };
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(err(error)),
        };
        if metadata.file_type().is_symlink() {
            return Err("Laboratory contains a symlink".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Laboratory contains a reparse point".into());
            }
        }
        if metadata.is_file() {
            used = used.saturating_add(metadata.len());
        }
        if used.saturating_add(additional) > LAB_BUDGET_BYTES {
            return Err("Laboratory exceeds the 5 GiB disk budget".into());
        }
    }
    Ok(())
}

fn reject_links(path: &Path) -> Result<(), String> {
    // Inspect every existing ancestor, not just the final component.
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(err)?;
        if metadata.file_type().is_symlink() {
            return Err("Symlink laboratory paths are not accepted".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Reparse laboratory paths are not accepted".into());
            }
        }
    }
    Ok(())
}

fn replace_file(stage: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::winbase::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = stage.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(stage, target).map_err(err)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Freshness {
    Unknown,
    Fresh,
    Stale,
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn refuses_arbitrary_parent_reserved_names_and_overlarge_reads() {
        assert!(LabRoot::create(Path::new(r"E:\testne")).is_err());
        let lab = LabRoot::create(&LabRoot::approved_parent()).unwrap();
        for invalid in [
            "CON",
            "nul.txt",
            "COM1.dll",
            "LPT9",
            "lab-marker.",
            "../escape",
            "a:b",
            "folder/file",
        ] {
            assert!(lab.file(invalid).is_err(), "accepted {invalid}");
        }
        let path = lab.write_new("bounded.txt", b"0123456789").unwrap();
        assert!(read_bounded(&path, 9).is_err());
        assert_eq!(read_bounded(&path, 10).unwrap(), b"0123456789");
    }
}
