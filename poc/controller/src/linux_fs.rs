//! Linux descriptor-based path resolution, with no dependency or process umask changes.
//! Each operation walks from / with O_NOFOLLOW on *every* component, not just
//! the final name. This does not defend against a malicious process with the
//! same UID (which can also read our private files) or a privileged administrator.
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::io::Read;
use crate::mutation::{MutationError, MutationResult};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

// arm64 overrides these asm-generic flags in its Linux UAPI. Do not silently
// use either set on an unsupported ABI.
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("Linux storage currently supports only x86_64 and aarch64 ABIs");
#[cfg(any(test, target_arch = "x86_64"))]
const X86_64_PATH_FLAGS: (i32, i32) = (0x10000, 0x20000);
#[cfg(any(test, target_arch = "aarch64"))]
const AARCH64_PATH_FLAGS: (i32, i32) = (0x4000, 0x8000);
#[cfg(target_arch = "x86_64")]
const PATH_FLAGS: (i32, i32) = X86_64_PATH_FLAGS;
#[cfg(target_arch = "aarch64")]
const PATH_FLAGS: (i32, i32) = AARCH64_PATH_FLAGS;
const O_DIRECTORY: i32 = PATH_FLAGS.0;
const O_NOFOLLOW: i32 = PATH_FLAGS.1;
const O_CLOEXEC: i32 = 0x80000;
const O_NONBLOCK: i32 = 0x800;
const O_CREAT: i32 = 0x40;
const O_EXCL: i32 = 0x80;
unsafe extern "C" {
    fn openat(dir: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn mkdirat(dir: i32, path: *const std::ffi::c_char, mode: u32) -> i32;
    fn unlinkat(dir: i32, path: *const std::ffi::c_char, flags: i32) -> i32;
    fn linkat(srcdir: i32, src: *const std::ffi::c_char, dstdir: i32, dst: *const std::ffi::c_char, flags: i32) -> i32;
    fn renameat(srcdir: i32, src: *const std::ffi::c_char, dstdir: i32, dst: *const std::ffi::c_char) -> i32;
    fn geteuid() -> u32;
}

fn invalid() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, "unsafe storage path, owner, type, links or permissions") }
fn name(value: &std::ffi::OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| invalid())
}
fn fd(result: i32) -> io::Result<File> {
    if result < 0 { Err(io::Error::last_os_error()) }
    // Each successful openat returns a fresh owned descriptor, closed by File.
    else { Ok(unsafe { File::from_raw_fd(result) }) }
}
fn status(result: i32) -> io::Result<()> {
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

pub(crate) fn directory(path: &Path) -> io::Result<File> {
    if !path.is_absolute() { return Err(invalid()); }
    let mut current = File::open("/")?;
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {},
            Component::Normal(value) => {
                let value = name(value)?;
                current = fd(unsafe { openat(current.as_raw_fd(), value.as_ptr(), O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) })?;
            },
            _ => return Err(invalid()),
        }
    }
    Ok(current)
}

fn parent(path: &Path) -> io::Result<(File, CString)> {
    let parent = path.parent().ok_or_else(invalid)?;
    let leaf = path.file_name().ok_or_else(invalid)?;
    Ok((directory(parent)?, name(leaf)?))
}

pub(crate) fn private_metadata(metadata: &Metadata, is_dir: bool) -> io::Result<()> {
    let expected = if is_dir { 0o700 } else { 0o600 };
    if metadata.uid() != unsafe { geteuid() } || metadata.mode() & 0o7777 != expected
        || (if is_dir { !metadata.is_dir() } else { !metadata.is_file() || metadata.nlink() != 1 }) {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn private_directory(path: &Path) -> io::Result<()> {
    private_metadata(&directory(path)?.metadata()?, true)
}

pub(crate) fn create_directory(path: &Path) -> MutationResult<()> {
    let (parent, leaf) = parent(path)?;
    status(unsafe { mkdirat(parent.as_raw_fd(), leaf.as_ptr(), 0o700) })?;
    (|| {
        let created = fd(unsafe { openat(parent.as_raw_fd(), leaf.as_ptr(), O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) })?;
        private_metadata(&created.metadata()?, true)?;
        sync(&parent, FaultPoint::CreateDirectorySync)
    })().map_err(MutationError::AppliedDurabilityUnknown)
}

// O_NONBLOCK prevents a substituted FIFO from hanging before the FD type check.
// create_new keeps the kernel's non-overwrite guarantee, including symlinks.
pub(crate) fn open_regular(path: &Path, write: bool, create: bool, exclusive: bool) -> MutationResult<File> {
    let (parent, leaf) = parent(path)?;
    let flags = (if write { 2 } else { 0 }) | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    let (file, created) = if create {
        match fd(unsafe { openat(parent.as_raw_fd(), leaf.as_ptr(), flags | O_CREAT | O_EXCL, 0o600_u32) }) {
            Ok(file) => (file, true),
            Err(error) if !exclusive && error.kind() == io::ErrorKind::AlreadyExists =>
                (fd(unsafe { openat(parent.as_raw_fd(), leaf.as_ptr(), flags) })?, false),
            Err(error) => return Err(error.into()),
        }
    } else { (fd(unsafe { openat(parent.as_raw_fd(), leaf.as_ptr(), flags) })?, false) };
    let checked = (|| {
        private_metadata(&file.metadata()?, false)?;
        if created { sync(&parent, FaultPoint::CreateFileSync)?; }
        Ok(())
    })();
    checked.map_err(|error| if created { MutationError::AppliedDurabilityUnknown(error) } else { error.into() })?;
    Ok(file)
}

pub(crate) fn remove_file(path: &Path) -> MutationResult<()> {
    let (parent, leaf) = parent(path)?;
    status(unsafe { unlinkat(parent.as_raw_fd(), leaf.as_ptr(), 0) })?;
    sync(&parent, FaultPoint::RemoveSync).map_err(MutationError::AppliedDurabilityUnknown)
}

// Both publication operations use the same anchored directory FD for the two
// names. All callers keep the temp and destination in the same directory.
pub(crate) fn publish(source: &Path, destination: &Path, replace: bool) -> MutationResult<()> {
    if source.parent() != destination.parent() { return Err(invalid().into()); }
    let (parent, source) = parent(source)?;
    private_metadata(&parent.metadata()?, true)?;
    let file = fd(unsafe { openat(parent.as_raw_fd(), source.as_ptr(), O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK) })?;
    private_metadata(&file.metadata()?, false)?;
    let destination = name(destination.file_name().ok_or_else(invalid)?)?;
    fault(FaultPoint::ManifestRenameBefore)?;
    status(unsafe {
        if replace { renameat(parent.as_raw_fd(), source.as_ptr(), parent.as_raw_fd(), destination.as_ptr()) }
        else { linkat(parent.as_raw_fd(), source.as_ptr(), parent.as_raw_fd(), destination.as_ptr(), 0) }
    })?;
    sync(&parent, FaultPoint::ManifestRenameSync).map_err(MutationError::AppliedDurabilityUnknown)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FaultPoint { CreateDirectorySync, CreateFileSync, RemoveSync, ManifestRenameBefore, ManifestRenameSync, ExportLinkBefore, ExportLinkSync }
#[cfg(test)]
thread_local! { static FAILURE: std::cell::Cell<Option<FaultPoint>> = const { std::cell::Cell::new(None) }; }
#[cfg(test)]
pub(crate) fn fail_once(point: FaultPoint) { FAILURE.with(|failure| failure.set(Some(point))); }
fn fault(_point: FaultPoint) -> io::Result<()> {
    #[cfg(test)]
    if FAILURE.with(|failure| { if failure.get() == Some(_point) { failure.set(None); true } else { false } }) {
        return Err(io::Error::other("injected after-syscall/before-sync failure"));
    }
    Ok(())
}
fn sync(file: &File, point: FaultPoint) -> io::Result<()> { fault(point)?; file.sync_all() }
fn same_inode(left: &File, right: &File) -> io::Result<bool> {
    let (a, b) = (left.metadata()?, right.metadata()?);
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}
fn changed() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "output_path_changed") }

/// Private staging is separate from the user's (possibly shared) output folder.
/// Both FDs remain live from creation through validation and publication.
pub(crate) struct ExportStage {
    output: File,
    output_path: PathBuf,
    stage: File,
    stage_name: CString,
    destination: CString,
    pub(crate) file: File,
    abandoned: bool,
    cleaned: bool,
}
impl ExportStage {
    pub(crate) fn new(destination: &Path) -> MutationResult<Self> {
        let (output, destination_name) = parent(destination)?;
        let mut random = [0_u8; 16];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        let stage_name = CString::new(format!(".ktz-stage-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>())).unwrap();
        status(unsafe { mkdirat(output.as_raw_fd(), stage_name.as_ptr(), 0o700) })?;
        let stage_result = (|| -> io::Result<(File, File)> {
            let stage = fd(unsafe { openat(output.as_raw_fd(), stage_name.as_ptr(), O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) })?;
            // A shared setgid parent gives even a mode-0700 mkdir its setgid
            // bit. Clear only that inherited bit on our newly created, owned
            // stage FD; never chmod the user's existing output directory.
            let metadata = stage.metadata()?;
            if metadata.is_dir() && metadata.uid() == unsafe { geteuid() }
                && metadata.mode() & 0o7777 == 0o2700 {
                stage.set_permissions(std::fs::Permissions::from_mode(0o700))?;
            }
            private_metadata(&stage.metadata()?, true)?;
            let file = fd(unsafe { openat(stage.as_raw_fd(), c"archive.tmp".as_ptr(), 2 | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600_u32) })?;
            private_metadata(&file.metadata()?, false)?;
            sync(&stage, FaultPoint::CreateFileSync)?;
            sync(&output, FaultPoint::CreateDirectorySync)?;
            Ok((stage, file))
        })();
        let (stage, file) = stage_result.map_err(MutationError::AppliedDurabilityUnknown)?;
        let result = Self { output, output_path: destination.parent().unwrap().to_path_buf(), stage, stage_name,
            destination: destination_name, file, abandoned: false, cleaned: false };
        result.identity(false).map_err(MutationError::AppliedDurabilityUnknown)?;
        Ok(result)
    }

    fn identity(&self, published: bool) -> io::Result<()> {
        if !same_inode(&self.output, &directory(&self.output_path)?)? { return Err(changed()); }
        let stage_at_name = fd(unsafe { openat(self.output.as_raw_fd(), self.stage_name.as_ptr(), O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) })?;
        if !same_inode(&self.stage, &stage_at_name)? { return Err(changed()); }
        private_metadata(&self.stage.metadata()?, true)?;
        let source = fd(unsafe { openat(self.stage.as_raw_fd(), c"archive.tmp".as_ptr(), O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) })?;
        if !same_inode(&self.file, &source)? { return Err(changed()); }
        if !published { private_metadata(&source.metadata()?, false)?; }
        if published {
            let destination = fd(unsafe { openat(self.output.as_raw_fd(), self.destination.as_ptr(), O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) })?;
            if !same_inode(&self.file, &destination)? { return Err(changed()); }
        }
        Ok(())
    }

    pub(crate) fn publish(&mut self) -> MutationResult<()> {
        self.identity(false).map_err(|_| MutationError::NotApplied(changed()))?;
        fault(FaultPoint::ExportLinkBefore)?;
        status(unsafe { linkat(self.stage.as_raw_fd(), c"archive.tmp".as_ptr(), self.output.as_raw_fd(), self.destination.as_ptr(), 0) })?;
        // No destructor cleanup on an uncertain outcome; never erase evidence or
        // roll back a possibly published destination.
        self.abandoned = true;
        sync(&self.output, FaultPoint::ExportLinkSync).and_then(|_| self.identity(true))
            .map_err(MutationError::AppliedDurabilityUnknown)?;
        self.abandoned = false;
        Ok(())
    }

    pub(crate) fn cleanup(&mut self) -> io::Result<()> {
        if self.cleaned { return Ok(()); }
        // Check both the source inode and the directory entry before deleting.
        let stage_at_name = fd(unsafe { openat(self.output.as_raw_fd(), self.stage_name.as_ptr(), O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) })?;
        let source = fd(unsafe { openat(self.stage.as_raw_fd(), c"archive.tmp".as_ptr(), O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) })?;
        if !same_inode(&self.stage, &stage_at_name)? || !same_inode(&self.file, &source)? { return Err(changed()); }
        status(unsafe { unlinkat(self.stage.as_raw_fd(), c"archive.tmp".as_ptr(), 0) })?;
        self.stage.sync_all()?;
        status(unsafe { unlinkat(self.output.as_raw_fd(), self.stage_name.as_ptr(), 0x200) })?; // AT_REMOVEDIR
        self.output.sync_all()?;
        self.cleaned = true;
        Ok(())
    }

    pub(crate) fn finish(&mut self) -> bool {
        let warning = self.cleanup().is_err();
        self.abandoned = true; // No hidden cleanup retries after returning a warning.
        warning
    }
}
impl Drop for ExportStage {
    fn drop(&mut self) { if !self.abandoned && !self.cleaned { let _ = self.cleanup(); } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_flags_match_each_supported_linux_uapi() {
        // Linux include/uapi/asm-generic/fcntl.h and
        // arch/arm64/include/uapi/asm/fcntl.h, respectively.
        assert_eq!(X86_64_PATH_FLAGS, (0o200000, 0o400000));
        assert_eq!(AARCH64_PATH_FLAGS, (0o40000, 0o100000));
        let expected = if cfg!(target_arch = "aarch64") { AARCH64_PATH_FLAGS } else { X86_64_PATH_FLAGS };
        assert_eq!((O_DIRECTORY, O_NOFOLLOW), expected);
    }
}
