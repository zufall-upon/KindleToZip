use crate::archive::{ArchiveInput, ArchiveSummary};
use crate::png_image::{crop_same_format, decode, decode_rendered, decode_stored, is_jpeg, sha256, DecodedPng, MAX_PNG_BYTES};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 34_000;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Ready,
    Capturing,
    Paused,
    Interrupted,
    NeedsAttention,
    Stopped,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CropRecord {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub version: u64,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageOutputMode {
    SingleImage,
    SplitSpread,
}

impl Default for PageOutputMode {
    fn default() -> Self { Self::SingleImage }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadingDirection {
    RightToLeft,
    LeftToRight,
}

impl Default for ReadingDirection {
    fn default() -> Self { Self::RightToLeft }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat { #[default] Png, Jpeg }
impl ImageFormat { fn extension(self) -> &'static str { match self { Self::Png => "png", Self::Jpeg => "jpg" } } }
fn default_jpeg_quality() -> u8 { 85 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureSettings {
    #[serde(default = "legacy_capture_scale")]
    pub capture_scale: u8,
    #[serde(default)]
    pub page_output_mode: PageOutputMode,
    #[serde(default)]
    pub reading_direction: ReadingDirection,
    #[serde(default)]
    pub image_format: ImageFormat,
    #[serde(default = "default_jpeg_quality")]
    pub jpeg_quality: u8,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self { capture_scale: legacy_capture_scale(), page_output_mode: PageOutputMode::SingleImage, reading_direction: ReadingDirection::RightToLeft, image_format: ImageFormat::Png, jpeg_quality: default_jpeg_quality() }
    }
}

fn legacy_capture_scale() -> u8 { 1 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageSide {
    Left,
    Right,
}

impl PageSide {
    fn opposite(self) -> Self { if self == Self::Left { Self::Right } else { Self::Left } }
}

fn first_page_for_direction(direction: ReadingDirection) -> PageSide {
    match direction { ReadingDirection::RightToLeft => PageSide::Right, ReadingDirection::LeftToRight => PageSide::Left }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SplitPageRecord {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpreadSplitRecord {
    pub version: u64,
    pub source_width: u32,
    pub source_height: u32,
    pub source_sha256: String,
    pub boundary_x: u32,
    pub first_page: PageSide,
    pub left: SplitPageRecord,
    pub right: SplitPageRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub book: Option<BookIdentity>,
    pub capture_id: u64,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub sha256: String,
    pub captured_at_ms: u64,
    pub blank_candidate: bool,
    pub duplicate_candidate: bool,
    #[serde(default = "legacy_capture_scale")]
    pub capture_scale: u8,
    #[serde(default)]
    pub image_format: ImageFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<u8>,
    pub crop: Option<CropRecord>,
    #[serde(default)]
    pub split: Option<SpreadSplitRecord>,
    // Missing on legacy jobs. Existing split records remain authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_layout: Option<PageOutputMode>,
    // Explicit review decisions must not be reclassified when reopening.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub layout_override: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BookIdentity {
    pub title: String,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRecord {
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub format: String,
    pub bytes: u64,
    pub sha256: String,
    pub entry_count: u32,
    pub range_confirmed: bool,
    pub exported_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub job_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub app_version: String,
    pub state: JobState,
    pub next_capture_id: u64,
    pub next_render_version: u64,
    pub last_capture_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<CaptureCheckpoint>,
    pub range_confirmed: bool,
    pub range_confirmed_at_ms: Option<u64>,
    #[serde(default)]
    pub capture_settings: CaptureSettings,
    pub images: Vec<ImageRecord>,
    pub selected_capture_ids: Vec<u64>,
    pub excluded_capture_ids: Vec<u64>,
    pub exports: Vec<ExportRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reset_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureCheckpoint {
    pub capture_id: u64,
    pub position: String,
    pub dispatch: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobSnapshot {
    pub job_path: String,
    pub manifest: Manifest,
    pub orphan_files: Vec<String>,
    pub issues: Vec<String>,
    pub resume_check_required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureResult {
    pub capture_id: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub sha256: String,
    pub blank_candidate: bool,
    pub duplicate_candidate: bool,
    pub capture_scale: u8,
    pub cleanup_warning: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub file_name: String,
    pub format: String,
    pub bytes: u64,
    pub sha256: String,
    pub entry_count: u32,
    pub range_confirmed: bool,
    pub cleanup_warning: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CropResult {
    pub crop: CropRecord,
    pub cleanup_warning: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    Cbz,
}

impl ArchiveFormat {
    pub fn parse(value: &str) -> Result<Self, StoreError> {
        match value {
            "zip" => Ok(Self::Zip),
            "cbz" => Ok(Self::Cbz),
            _ => Err(StoreError("invalid_archive_format")),
        }
    }

    fn extension(self) -> &'static str {
        match self { Self::Zip => "zip", Self::Cbz => "cbz" }
    }

    fn as_str(self) -> &'static str {
        self.extension()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StoreError(pub &'static str);

impl StoreError {
    pub fn code(self) -> &'static str { self.0 }
}

struct PendingCapture {
    capture_id: u64,
    path: PathBuf,
    bytes: u64,
    file: Option<File>,
}

pub struct Store {
    path: PathBuf,
    manifest: Manifest,
    lock: Option<JobLock>,
    pending: Option<PendingCapture>,
}

// Kept outside the browser profile so the browser can be closed and its own
// profile deleted without releasing the application's cross-process exclusion.
pub struct DataLock { _lock: JobLock }

pub fn lock_data_directory(path: &Path) -> Result<DataLock, StoreError> {
    ensure_real_directory(path)?;
    apply_current_user_acl(path)?;
    Ok(DataLock { _lock: acquire_job_lock(path)? })
}

impl Store {
    pub fn create(base: &Path) -> Result<Self, StoreError> {
        ensure_real_directory(base)?;
        let jobs = base.join("jobs");
        match fs::symlink_metadata(&jobs) {
            Ok(_) => ensure_real_directory(&jobs)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&jobs).map_err(|_| StoreError("job_create_failed"))?;
                if let Err(error) = apply_current_user_acl(&jobs) {
                    let _ = fs::remove_dir(&jobs);
                    return Err(error);
                }
            }
            Err(_) => return Err(StoreError("job_create_failed")),
        }
        for _ in 0..16 {
            let job_id = new_job_id();
            let path = jobs.join(&job_id);
            match fs::create_dir(&path) {
                Ok(()) => {
                    if let Err(error) = apply_current_user_acl(&path) {
                        let _ = fs::remove_dir(&path);
                        return Err(error);
                    }
                    let created = now_ms();
                    let manifest = Manifest {
                        schema_version: SCHEMA_VERSION,
                        job_id,
                        created_at_ms: created,
                        updated_at_ms: created,
                        app_version: env!("CARGO_PKG_VERSION").to_owned(),
                        state: JobState::Ready,
                        next_capture_id: 1,
                        next_render_version: 1,
                        last_capture_id: None,
                        checkpoint: None,
                        range_confirmed: false,
                        range_confirmed_at_ms: None,
                        capture_settings: CaptureSettings { capture_scale: 2, page_output_mode: PageOutputMode::SingleImage, reading_direction: ReadingDirection::RightToLeft, ..CaptureSettings::default() },
                        images: Vec::new(),
                        selected_capture_ids: Vec::new(),
                        excluded_capture_ids: Vec::new(),
                        exports: Vec::new(),
                        reset_files: Vec::new(),
                    };
                    for name in ["originals", "pending", "rendered"] {
                        fs::create_dir(path.join(name)).map_err(|_| StoreError("job_create_failed"))?;
                    }
                    let lock = acquire_job_lock(&path)?;
                    write_manifest(&path, &manifest, false)?;
                    return Ok(Self { path, manifest, lock: Some(lock), pending: None });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(StoreError("job_create_failed")),
            }
        }
        Err(StoreError("job_create_failed"))
    }

    pub fn open(path: &Path) -> Result<Self, StoreError> {
        ensure_real_directory(path)?;
        for name in ["originals", "pending", "rendered"] {
            ensure_real_directory(&path.join(name))?;
        }
        let lock = acquire_job_lock(path)?;
        let manifest_path = path.join("manifest.json");
        let file = open_existing_regular(&manifest_path)?;
        let metadata = file.metadata().map_err(|_| StoreError("manifest_invalid"))?;
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(StoreError("manifest_invalid"));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes).map_err(|_| StoreError("manifest_invalid"))?;
        if bytes.len() as u64 > MAX_MANIFEST_BYTES { return Err(StoreError("manifest_invalid")); }
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| StoreError("manifest_invalid"))?;
        if manifest.schema_version > SCHEMA_VERSION {
            return Err(StoreError("future_manifest"));
        }
        if manifest.schema_version != SCHEMA_VERSION {
            return Err(StoreError("unsupported_manifest"));
        }
        validate_manifest(&manifest)?;
        let mut store = Self { path: path.to_path_buf(), manifest, lock: Some(lock), pending: None };
        // A persisted deletion journal is already explicitly authorized. Never
        // publish old image records after an interrupted reset.
        if !store.manifest.reset_files.is_empty() { store.finish_reset()?; }
        let report = store.inspect_internal()?;
        if !report.issues.is_empty() {
            // Corrupt or missing images remain visible and block resumption/export.
        }
        if store.manifest.state == JobState::Capturing {
            store.manifest.state = JobState::Interrupted;
            store.persist()?;
        }
        if report.issues.is_empty() { store.refresh_single_pages()?; }
        Ok(store)
    }

    pub fn snapshot(&self) -> Result<JobSnapshot, StoreError> {
        self.inspect_internal()
    }

    pub fn manifest(&self) -> &Manifest { &self.manifest }

    pub fn reset_images(&mut self) -> Result<JobSnapshot, StoreError> {
        if self.pending.is_some() || self.manifest.state == JobState::Capturing {
            return Err(StoreError("capture_pending"));
        }
        if self.manifest.reset_files.is_empty() {
            let mut files = Vec::new();
            for dir in ["originals", "rendered", "pending"] {
                let directory = self.path.join(dir);
                ensure_real_directory(&directory)?;
                for entry in fs::read_dir(directory).map_err(|_| StoreError("job_read_failed"))? {
                    let entry = entry.map_err(|_| StoreError("job_read_failed"))?;
                    let relative = format!("{dir}/{}", entry.file_name().to_string_lossy());
                    if !reset_owned_path(&relative) { return Err(StoreError("reset_unowned_file")); }
                    ensure_regular_file(&entry.path())?;
                    files.push(relative);
                }
            }
            let previous = self.manifest.clone();
            self.manifest.images.clear();
            self.manifest.selected_capture_ids.clear();
            self.manifest.excluded_capture_ids.clear();
            self.manifest.last_capture_id = None;
            self.manifest.checkpoint = None;
            self.manifest.range_confirmed = false;
            self.manifest.range_confirmed_at_ms = None;
            self.manifest.state = JobState::Ready;
            // Do not reuse IDs: stale image requests cannot resolve new images.
            self.manifest.reset_files = files;
            if let Err(error) = self.persist() { self.manifest = previous; return Err(error); }
        }
        self.finish_reset()?;
        self.snapshot()
    }

    fn finish_reset(&mut self) -> Result<(), StoreError> {
        for relative in &self.manifest.reset_files {
            if !reset_owned_path(relative) { return Err(StoreError("manifest_path_invalid")); }
            let file = self.path.join(relative);
            match fs::symlink_metadata(&file) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(StoreError("reset_cleanup_failed")),
                Ok(_) => ensure_regular_file(&file)?,
            }
            fs::remove_file(file).map_err(|_| StoreError("reset_cleanup_failed"))?;
        }
        let previous = self.manifest.clone();
        self.manifest.reset_files.clear();
        self.manifest.state = JobState::Ready;
        self.manifest.range_confirmed = false;
        self.manifest.range_confirmed_at_ms = None;
        if let Err(error) = self.persist() { self.manifest = previous; return Err(error); }
        Ok(())
    }

    // Repair old mechanical splits using verified original pixels, never the
    // current capture settings or capture number. Keep old rendered files and
    // exports, crop geometry, selection and reading order untouched.
    fn refresh_single_pages(&mut self) -> Result<(), StoreError> {
        let previous = self.manifest.clone();
        for index in 0..self.manifest.images.len() {
            let image = &self.manifest.images[index];
            if image.split.is_none() || image.layout_override { continue; }
            let original = self.read_original(image)?;
            if decode_stored(&original).map_err(StoreError)?.legacy_single_page() {
                self.manifest.images[index].split = None;
                self.manifest.images[index].page_layout = Some(PageOutputMode::SingleImage);
            }
        }
        if self.manifest.images.iter().zip(&previous.images).any(|(a,b)| a.split.is_some() != b.split.is_some()) {
            if self.persist().is_err() { self.manifest = previous; return Err(StoreError("manifest_write_failed")); }
        }
        Ok(())
    }

    pub fn set_capture_settings(&mut self, settings: CaptureSettings) -> Result<JobSnapshot, StoreError> {
        if self.pending.is_some() || self.manifest.state == JobState::Capturing {
            return Err(StoreError("wrong_state"));
        }
        if !matches!(settings.capture_scale, 1 | 2) || !(1..=100).contains(&settings.jpeg_quality) {
            return Err(StoreError("invalid_capture_scale"));
        }
        let previous = self.manifest.clone();
        self.manifest.capture_settings = settings;
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        self.snapshot()
    }

    pub fn start_capture(&mut self) -> Result<JobState, StoreError> {
        if !self.manifest.reset_files.is_empty() { return Err(StoreError("reset_cleanup_failed")); }
        if self.manifest.state != JobState::Ready || self.pending.is_some() {
            return Err(StoreError("wrong_state"));
        }
        self.update_state(JobState::Capturing)?;
        Ok(self.manifest.state)
    }

    pub fn pause_capture(&mut self) -> Result<JobState, StoreError> {
        if self.manifest.state != JobState::Capturing {
            return Err(StoreError("wrong_state"));
        }
        self.update_state(JobState::Paused)?;
        Ok(self.manifest.state)
    }

    pub fn stop_capture(&mut self) -> Result<JobState, StoreError> {
        if !matches!(self.manifest.state, JobState::Ready | JobState::Capturing | JobState::Paused | JobState::NeedsAttention | JobState::Interrupted) {
            return Err(StoreError("wrong_state"));
        }
        self.update_state(JobState::Stopped)?;
        Ok(self.manifest.state)
    }

    pub fn confirm_resume(&mut self, last_capture_id: Option<u64>, target_confirmed: bool) -> Result<JobState, StoreError> {
        if self.pending.is_some() || !matches!(self.manifest.state,
            JobState::Paused | JobState::Interrupted | JobState::NeedsAttention | JobState::Stopped | JobState::Review)
            || !target_confirmed || last_capture_id != self.manifest.last_capture_id
        {
            return Err(StoreError("resume_confirmation_required"));
        }
        let snapshot = self.inspect_internal()?;
        if !snapshot.issues.is_empty() {
            return Err(StoreError("job_inconsistent"));
        }
        self.update_state(JobState::Ready)?;
        Ok(self.manifest.state)
    }

    pub fn begin_capture(&mut self) -> Result<u64, StoreError> {
        if self.manifest.state != JobState::Capturing {
            return Err(StoreError("wrong_state"));
        }
        if self.pending.is_some() {
            return Err(StoreError("capture_pending"));
        }
        let capture_id = self.manifest.next_capture_id;
        if capture_id == 0 || capture_id == u64::MAX {
            return Err(StoreError("capture_id_exhausted"));
        }
        let previous = self.manifest.clone();
        self.manifest.next_capture_id += 1;
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        let pending_dir = self.path.join("pending");
        ensure_real_directory(&pending_dir)?;
        let path = pending_dir.join(format!("{capture_id:06}.upload"));
        if fs::symlink_metadata(&path).is_ok() {
            return Err(StoreError("pending_exists"));
        }
        let file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| StoreError("pending_create_failed"))?;
        self.pending = Some(PendingCapture { capture_id, path, bytes: 0, file: Some(file) });
        Ok(capture_id)
    }

    pub fn write_capture_chunk(&mut self, capture_id: u64, bytes: &[u8]) -> Result<u64, StoreError> {
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(StoreError("invalid_chunk"));
        }
        let pending = self.pending.as_mut().ok_or(StoreError("capture_not_started"))?;
        if pending.capture_id != capture_id {
            return Err(StoreError("capture_id_mismatch"));
        }
        let new_size = pending.bytes.checked_add(bytes.len() as u64).ok_or(StoreError("png_too_large"))?;
        if new_size > MAX_PNG_BYTES as u64 {
            return Err(StoreError("png_too_large"));
        }
        let file = pending.file.as_mut().ok_or(StoreError("capture_pending_closed"))?;
        file.write_all(bytes).map_err(|_| StoreError("pending_write_failed"))?;
        pending.bytes = new_size;
        Ok(new_size)
    }

    pub fn commit_capture(&mut self) -> Result<CaptureResult, StoreError> {
        self.commit_capture_with_book(None)
    }

    pub fn commit_capture_with_book(&mut self, book: Option<BookIdentity>) -> Result<CaptureResult, StoreError> {
        self.commit_capture_at(book, None)
    }

    pub fn record_advance(&mut self, capture_id: u64, dispatch: String) -> Result<(), StoreError> {
        let checkpoint = self.manifest.checkpoint.as_ref().ok_or(StoreError("resume_checkpoint_required"))?;
        if self.manifest.state != JobState::Capturing || checkpoint.capture_id != capture_id
            || self.manifest.last_capture_id != Some(capture_id)
            || !matches!((checkpoint.dispatch.as_str(), dispatch.as_str()), ("not_sent", "unknown") | ("unknown", "sent") | ("sent", "confirmed")) {
            return Err(StoreError("invalid_advance_checkpoint"));
        }
        let previous = self.manifest.clone();
        self.manifest.checkpoint.as_mut().unwrap().dispatch = dispatch;
        if let Err(error) = self.persist() { self.manifest = previous; return Err(error); }
        Ok(())
    }

    pub fn commit_capture_at(&mut self, book: Option<BookIdentity>, position: Option<String>) -> Result<CaptureResult, StoreError> {
        if position.as_ref().is_some_and(|value| value.is_empty() || value.chars().count() > 200) {
            return Err(StoreError("invalid_capture_position"));
        }
        if let Some(ref book) = book {
            if book.title.is_empty() || book.title.chars().count() > 500
                || book.identity.len() != 64 || !book.identity.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(StoreError("invalid_book_identity"));
            }
            if self.manifest.images.iter().filter_map(|image| image.book.as_ref()).any(|owner| owner.identity != book.identity) {
                return Err(StoreError("book_identity_changed"));
            }
        }
        if self.manifest.state != JobState::Capturing {
            return Err(StoreError("wrong_state"));
        }
        let pending = self.pending.as_mut().ok_or(StoreError("capture_not_started"))?;
        if let Some(mut file) = pending.file.take() {
            file.flush().map_err(|_| StoreError("pending_write_failed"))?;
            file.sync_all().map_err(|_| StoreError("pending_write_failed"))?;
        }
        let pending_id = pending.capture_id;
        let pending_path = pending.path.clone();
        ensure_regular_file(&pending_path)?;
        let bytes = read_bounded(&pending_path, MAX_PNG_BYTES as u64).map_err(|error| StoreError(error))?;
        if is_jpeg(&bytes) != (self.manifest.capture_settings.image_format == ImageFormat::Jpeg) { return Err(StoreError("capture_format_mismatch")); }
        let decoded = match decode(&bytes) {
            Ok(decoded) => decoded,
            Err(code) => {
                let previous = self.manifest.clone();
                self.manifest.state = JobState::NeedsAttention;
                if self.persist().is_err() { self.manifest = previous; }
                return Err(StoreError(code));
            }
        };
        let split_version = if self.manifest.capture_settings.page_output_mode == PageOutputMode::SplitSpread && !decoded.single_page() {
            if decoded.width < 2 { return Err(StoreError("spread_width_too_small")); }
            let version = self.manifest.next_render_version;
            if version == 0 || version == u64::MAX { return Err(StoreError("render_version_exhausted")); }
            Some(version)
        } else { None };
        let duplicate_candidate = self.manifest.images.iter().any(|image| image.sha256 == decoded.sha256);
        let format = self.manifest.capture_settings.image_format;
        let quality = self.manifest.capture_settings.jpeg_quality;
        let relative = format!("originals/{pending_id:06}.{}", format.extension());
        ensure_real_directory(&self.path.join("originals"))?;
        let destination = self.path.join(&relative);
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(StoreError("capture_conflict"));
        }
        let mut destination_file = OpenOptions::new().write(true).create_new(true).open(&destination)
            .map_err(|error| StoreError(if error.kind() == std::io::ErrorKind::AlreadyExists { "capture_conflict" } else { "capture_commit_failed" }))?;
        if destination_file.write_all(&bytes).is_err() || destination_file.sync_all().is_err() {
            return Err(StoreError("capture_commit_failed"));
        }
        drop(destination_file);
        let committed_bytes = read_bounded(&destination, MAX_PNG_BYTES as u64).map_err(StoreError)?;
        let committed = decode(&committed_bytes).map_err(StoreError)?;
        if committed_bytes != bytes || committed.sha256 != decoded.sha256 || committed.width != decoded.width || committed.height != decoded.height {
            return Err(StoreError("capture_commit_failed"));
        }
        let split = if let Some(version) = split_version {
            Some(self.persist_split(pending_id, &bytes, &decoded, version, first_page_for_direction(self.manifest.capture_settings.reading_direction), quality)?)
        } else { None };
        let record = ImageRecord {
            book,
            capture_id: pending_id,
            path: relative,
            width: decoded.width,
            height: decoded.height,
            bytes: bytes.len() as u64,
            sha256: decoded.sha256.clone(),
            captured_at_ms: now_ms(),
            blank_candidate: decoded.blank_candidate,
            duplicate_candidate,
            capture_scale: self.manifest.capture_settings.capture_scale,
            image_format: format,
            jpeg_quality: (format == ImageFormat::Jpeg).then_some(quality),
            crop: None,
            split,
            page_layout: Some(if split_version.is_some() { PageOutputMode::SplitSpread } else { PageOutputMode::SingleImage }),
            layout_override: false,
        };
        let previous = self.manifest.clone();
        if split_version.is_some() { self.manifest.next_render_version += 1; }
        self.manifest.last_capture_id = Some(pending_id);
        self.manifest.checkpoint = position.map(|position| CaptureCheckpoint { capture_id: pending_id, position, dispatch: "not_sent".to_owned() });
        self.manifest.selected_capture_ids.push(pending_id);
        self.manifest.images.push(record);
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        self.pending = None;
        let cleanup_warning = fs::remove_file(&pending_path).is_err();
        Ok(CaptureResult {
            capture_id: pending_id,
            width: decoded.width,
            height: decoded.height,
            bytes: bytes.len() as u64,
            sha256: decoded.sha256,
            blank_candidate: decoded.blank_candidate,
            duplicate_candidate,
            capture_scale: self.manifest.capture_settings.capture_scale,
            cleanup_warning,
        })
    }

    pub fn abort_capture(&mut self) -> Result<(), StoreError> {
        let pending = self.pending.as_mut().ok_or(StoreError("capture_not_started"))?;
        pending.file.take();
        ensure_regular_file(&pending.path)?;
        fs::remove_file(&pending.path).map_err(|_| StoreError("pending_cleanup_failed"))?;
        self.pending = None;
        if self.manifest.state == JobState::Capturing {
            self.update_state(JobState::NeedsAttention)?;
        }
        Ok(())
    }

    pub fn set_review_order(&mut self, order: Vec<u64>) -> Result<JobSnapshot, StoreError> {
        if self.pending.is_some() || self.manifest.state == JobState::Capturing {
            return Err(StoreError("wrong_state"));
        }
        let known: HashSet<u64> = self.manifest.images.iter().map(|image| image.capture_id).collect();
        let selected: HashSet<u64> = order.iter().copied().collect();
        if selected.len() != order.len() || order.iter().any(|id| !known.contains(id)) {
            return Err(StoreError("invalid_selection"));
        }
        let previous = self.manifest.clone();
        self.manifest.selected_capture_ids = order;
        self.manifest.excluded_capture_ids = known.difference(&selected).copied().collect::<BTreeSet<_>>().into_iter().collect();
        self.manifest.state = JobState::Review;
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        self.snapshot()
    }

    pub fn confirm_range(&mut self, confirmed: bool) -> Result<JobSnapshot, StoreError> {
        if self.pending.is_some() || self.manifest.state == JobState::Capturing {
            return Err(StoreError("capture_in_progress"));
        }
        let previous = self.manifest.clone();
        self.manifest.range_confirmed = confirmed;
        self.manifest.range_confirmed_at_ms = if confirmed { Some(now_ms()) } else { None };
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        self.snapshot()
    }

    pub fn crop_image(&mut self, capture_id: u64, x: u32, y: u32, width: u32, height: u32) -> Result<CropResult, StoreError> {
        if self.manifest.state != JobState::Review || self.pending.is_some() {
            return Err(StoreError("wrong_state"));
        }
        let source = self.manifest.images.iter().find(|image| image.capture_id == capture_id).ok_or(StoreError("capture_not_found"))?.clone();
        let bytes = self.read_original(&source)?;
        let rendered = crop_same_format(&bytes, x, y, width, height, source.jpeg_quality.unwrap_or(default_jpeg_quality())).map_err(StoreError)?;
        let decoded = decode_rendered(&rendered).map_err(StoreError)?;
        // Reject an impossible split before creating any versioned files so a
        // later valid crop/reset can still use the unchanged render version.
        if source.split.is_some() && decoded.width < 2 { return Err(StoreError("spread_width_too_small")); }
        let version = self.manifest.next_render_version;
        let split_version = source.split.as_ref().map(|_| version.checked_add(1).ok_or(StoreError("render_version_exhausted"))).transpose()?;
        if version == 0 || version == u64::MAX || split_version == Some(u64::MAX) {
            return Err(StoreError("render_version_exhausted"));
        }
        let relative = format!("rendered/{capture_id:06}-v{version}.{}", source.image_format.extension());
        self.write_rendered(&relative, &rendered, &decoded, "crop_write_failed", "crop_verify_failed")?;
        let crop = CropRecord {
            x, y, width: decoded.width, height: decoded.height, version, path: relative,
            bytes: rendered.len() as u64, sha256: decoded.sha256.clone(),
        };
        let split = if let Some(split_version) = split_version {
            Some(self.persist_split(capture_id, &rendered, &decoded, split_version,
                source.split.as_ref().expect("split version came from a split image").first_page, source.jpeg_quality.unwrap_or(default_jpeg_quality()))?)
        } else { None };
        let previous = self.manifest.clone();
        let image = self.manifest.images.iter_mut().find(|image| image.capture_id == capture_id).ok_or(StoreError("capture_not_found"))?;
        image.crop = Some(crop.clone());
        image.split = split;
        self.manifest.next_render_version = split_version.map(|value| value + 1).unwrap_or(version + 1);
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        Ok(CropResult { crop, cleanup_warning: false })
    }

    // Review changes only the derived output. Never overwrite originals or
    // prior exports; require an explicit order for each requested split.
    pub fn set_page_layout(&mut self, capture_id: u64, mode: PageOutputMode, first_page: PageSide) -> Result<JobSnapshot, StoreError> {
        if self.manifest.state != JobState::Review || self.pending.is_some() { return Err(StoreError("wrong_state")); }
        let source = self.manifest.images.iter().find(|image| image.capture_id == capture_id).ok_or(StoreError("capture_not_found"))?.clone();
        let (bytes, _, _, _) = self.read_selected(&source)?;
        let split = if mode == PageOutputMode::SplitSpread {
            let decoded = decode_rendered(&bytes).map_err(StoreError)?;
            let version = self.manifest.next_render_version;
            if version == 0 || version == u64::MAX { return Err(StoreError("render_version_exhausted")); }
            Some(self.persist_split(capture_id, &bytes, &decoded, version, first_page, source.jpeg_quality.unwrap_or(default_jpeg_quality()))?)
        } else { None };
        let previous = self.manifest.clone();
        let image = self.manifest.images.iter_mut().find(|image| image.capture_id == capture_id).ok_or(StoreError("capture_not_found"))?;
        image.split = split;
        image.page_layout = Some(mode);
        image.layout_override = true;
        if mode == PageOutputMode::SplitSpread { self.manifest.next_render_version += 1; }
        if self.persist().is_err() { self.manifest = previous; return Err(StoreError("manifest_write_failed")); }
        self.snapshot()
    }

    pub fn reset_crop(&mut self, capture_id: u64) -> Result<JobSnapshot, StoreError> {
        if self.manifest.state != JobState::Review || self.pending.is_some() { return Err(StoreError("wrong_state")); }
        let source = self.manifest.images.iter().find(|image| image.capture_id == capture_id).ok_or(StoreError("capture_not_found"))?.clone();
        let bytes = self.read_original(&source)?;
        let split = if let Some(current) = source.split.as_ref() {
            let version = self.manifest.next_render_version;
            if version == 0 || version == u64::MAX { return Err(StoreError("render_version_exhausted")); }
            let decoded = decode_stored(&bytes).map_err(StoreError)?;
            Some(self.persist_split(capture_id, &bytes, &decoded, version, current.first_page, source.jpeg_quality.unwrap_or(default_jpeg_quality()))?)
        } else { None };
        let previous = self.manifest.clone();
        let image = self.manifest.images.iter_mut().find(|image| image.capture_id == capture_id).ok_or(StoreError("capture_not_found"))?;
        image.crop = None; image.split = split;
        if source.split.is_some() { self.manifest.next_render_version += 1; }
        if self.persist().is_err() { self.manifest = previous; return Err(StoreError("manifest_write_failed")); }
        self.snapshot()
    }

    pub fn export(&mut self, destination: &Path, format: ArchiveFormat) -> Result<ExportResult, StoreError> {
        self.export_progress(destination, format, &mut |_, _, _| {})
    }

    pub fn export_progress(&mut self, destination: &Path, format: ArchiveFormat, progress: &mut impl FnMut(usize, usize, &'static str)) -> Result<ExportResult, StoreError> {
        if self.pending.is_some() || self.manifest.state == JobState::Capturing {
            return Err(StoreError("capture_in_progress"));
        }
        if self.manifest.selected_capture_ids.is_empty() {
            return Err(StoreError("empty_selection"));
        }
        let output_destination = destination.to_string_lossy().into_owned();
        let (destination, file_name) = validate_output_path(destination, format)?;
        let snapshot = self.inspect_internal()?;
        if !snapshot.issues.is_empty() {
            return Err(StoreError("job_inconsistent"));
        }
        let mut sources = Vec::<(PathBuf, u32, u32, u64, String, bool)>::with_capacity(self.manifest.selected_capture_ids.len());
        for id in &self.manifest.selected_capture_ids {
            let image = self.manifest.images.iter().find(|image| image.capture_id == *id).ok_or(StoreError("invalid_selection"))?;
            if image.split.is_some() { sources.extend(self.split_sources(image)?); }
            else { sources.push(self.selected_source(image)?); }
        }
        if sources.is_empty() || sources.len() >= u16::MAX as usize { return Err(StoreError("archive_entry_count_unsupported")); }
        let inputs: Vec<_> = sources.iter().enumerate().map(|(index, (path, width, height, bytes, digest, allow_black))| ArchiveInput {
            name: format!("{:06}.{}", index + 1, path.extension().and_then(|ext| ext.to_str()).unwrap_or("png")), path, bytes: *bytes, sha256: digest, width: *width, height: *height, allow_black: *allow_black,
        }).collect();
        let parent = destination.parent().ok_or(StoreError("invalid_output_path"))?;
        let temp_path = (0..16).find_map(|_| {
            let suffix = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(".partial-{}-{}-{}.tmp", self.manifest.job_id, std::process::id(), suffix));
            match OpenOptions::new().read(true).write(true).create_new(true).open(&candidate) {
                Ok(file) => Some((candidate, file)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(_) => None,
            }
        }).ok_or(StoreError("archive_temp_create_failed"))?;
        let (temp_path, mut temp_file) = temp_path;
        let summary: ArchiveSummary = match crate::archive::write_and_verify_progress(&mut temp_file, &inputs, progress) {
            Ok(summary) => summary,
            Err(error) => {
                drop(temp_file);
                let _ = fs::remove_file(&temp_path);
                return Err(StoreError(error));
            }
        };
        drop(temp_file);
        match fs::hard_link(&temp_path, &destination) {
            Ok(()) => {},
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                return Err(StoreError(if error.kind() == std::io::ErrorKind::AlreadyExists { "output_exists" } else { "output_publish_failed" }));
            }
        }
        let cleanup_warning = fs::remove_file(&temp_path).is_err();
        let record = ExportRecord {
            file_name: file_name.clone(), destination: Some(output_destination), format: format.as_str().to_owned(), bytes: summary.bytes,
            sha256: summary.sha256.clone(), entry_count: summary.entries,
            range_confirmed: self.manifest.range_confirmed, exported_at_ms: now_ms(),
        };
        let previous = self.manifest.clone();
        self.manifest.exports.push(record);
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("output_published_manifest_update_failed"));
        }
        Ok(ExportResult {
            file_name, format: format.as_str().to_owned(), bytes: summary.bytes,
            sha256: summary.sha256, entry_count: summary.entries,
            range_confirmed: self.manifest.range_confirmed, cleanup_warning,
        })
    }

    pub fn close(mut self) -> Result<(), StoreError> {
        if self.manifest.state == JobState::Capturing {
            self.manifest.state = JobState::Interrupted;
            self.persist()?;
        }
        self.lock.take();
        Ok(())
    }

    fn update_state(&mut self, state: JobState) -> Result<(), StoreError> {
        let previous = self.manifest.clone();
        self.manifest.state = state;
        if self.persist().is_err() {
            self.manifest = previous;
            return Err(StoreError("manifest_write_failed"));
        }
        Ok(())
    }

    fn persist(&mut self) -> Result<(), StoreError> {
        self.manifest.updated_at_ms = now_ms();
        write_manifest(&self.path, &self.manifest, true)
    }

    fn read_original(&self, image: &ImageRecord) -> Result<Vec<u8>, StoreError> {
        let expected = format!("originals/{:06}.{}", image.capture_id, image.image_format.extension());
        if image.path != expected { return Err(StoreError("manifest_path_invalid")); }
        let path = self.path.join(expected);
        ensure_regular_file(&path)?;
        let bytes = read_bounded(&path, MAX_PNG_BYTES as u64).map_err(StoreError)?;
        let decoded = decode_stored(&bytes).map_err(StoreError)?;
        if is_jpeg(&bytes) != (image.image_format == ImageFormat::Jpeg) || bytes.len() as u64 != image.bytes || decoded.width != image.width || decoded.height != image.height || decoded.sha256 != image.sha256 {
            return Err(StoreError("image_integrity_failed"));
        }
        Ok(bytes)
    }

    fn read_selected(&self, image: &ImageRecord) -> Result<(Vec<u8>, u32, u32, String), StoreError> {
        if let Some(crop) = &image.crop {
            let expected = format!("rendered/{:06}-v{}.{}", image.capture_id, crop.version, image.image_format.extension());
            if crop.path != expected { return Err(StoreError("manifest_path_invalid")); }
            let path = self.path.join(expected);
            ensure_regular_file(&path)?;
            let bytes = read_bounded(&path, MAX_PNG_BYTES as u64).map_err(StoreError)?;
            let decoded = decode_rendered(&bytes).map_err(StoreError)?;
            if is_jpeg(&bytes) != (image.image_format == ImageFormat::Jpeg) || bytes.len() as u64 != crop.bytes || decoded.width != crop.width || decoded.height != crop.height || decoded.sha256 != crop.sha256 {
                return Err(StoreError("image_integrity_failed"));
            }
            Ok((bytes, crop.width, crop.height, crop.sha256.clone()))
        } else {
            let bytes = self.read_original(image)?;
            Ok((bytes, image.width, image.height, image.sha256.clone()))
        }
    }

    fn write_rendered(&self, relative: &str, bytes: &[u8], expected: &DecodedPng, write_error: &'static str, verify_error: &'static str) -> Result<(), StoreError> {
        ensure_real_directory(&self.path.join("rendered"))?;
        let destination = self.path.join(relative);
        if fs::symlink_metadata(&destination).is_ok() { return Err(StoreError(write_error)); }
        let mut file = OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|_| StoreError(write_error))?;
        if file.write_all(bytes).is_err() || file.sync_all().is_err() { return Err(StoreError(write_error)); }
        drop(file);
        let committed = read_bounded(&destination, MAX_PNG_BYTES as u64).map_err(|_| StoreError(verify_error))?;
        let verified = decode_rendered(&committed).map_err(|_| StoreError(verify_error))?;
        if committed != bytes || verified.sha256 != expected.sha256 || verified.width != expected.width || verified.height != expected.height {
            return Err(StoreError(verify_error));
        }
        Ok(())
    }

    fn persist_split(&self, capture_id: u64, source_bytes: &[u8], source: &DecodedPng, version: u64, first_page: PageSide, quality: u8) -> Result<SpreadSplitRecord, StoreError> {
        if source.width < 2 { return Err(StoreError("spread_width_too_small")); }
        let boundary_x = source.width / 2;
        let left_bytes = crop_same_format(source_bytes, 0, 0, boundary_x, source.height, quality).map_err(StoreError)?;
        let right_width = source.width - boundary_x;
        let right_bytes = crop_same_format(source_bytes, boundary_x, 0, right_width, source.height, quality).map_err(StoreError)?;
        let left_decoded = decode_rendered(&left_bytes).map_err(StoreError)?;
        let right_decoded = decode_rendered(&right_bytes).map_err(StoreError)?;
        let extension = if is_jpeg(source_bytes) { "jpg" } else { "png" };
        let left_path = format!("rendered/{capture_id:06}-v{version}-left.{extension}");
        let right_path = format!("rendered/{capture_id:06}-v{version}-right.{extension}");
        self.write_rendered(&left_path, &left_bytes, &left_decoded, "split_write_failed", "split_verify_failed")?;
        self.write_rendered(&right_path, &right_bytes, &right_decoded, "split_write_failed", "split_verify_failed")?;
        Ok(SpreadSplitRecord {
            version, source_width: source.width, source_height: source.height, source_sha256: source.sha256.clone(), boundary_x, first_page,
            left: SplitPageRecord { path: left_path, width: left_decoded.width, height: left_decoded.height, bytes: left_bytes.len() as u64, sha256: left_decoded.sha256 },
            right: SplitPageRecord { path: right_path, width: right_decoded.width, height: right_decoded.height, bytes: right_bytes.len() as u64, sha256: right_decoded.sha256 },
        })
    }

    fn read_split_page(&self, image: &ImageRecord, split: &SpreadSplitRecord, side: PageSide) -> Result<(PathBuf, u32, u32, u64, String), StoreError> {
        let page = if side == PageSide::Left { &split.left } else { &split.right };
        let label = if side == PageSide::Left { "left" } else { "right" };
        let expected = format!("rendered/{:06}-v{}-{label}.{}", image.capture_id, split.version, image.image_format.extension());
        if page.path != expected { return Err(StoreError("manifest_path_invalid")); }
        let path = self.path.join(&expected);
        ensure_regular_file(&path)?;
        let bytes = read_bounded(&path, MAX_PNG_BYTES as u64).map_err(StoreError)?;
        let decoded = decode_rendered(&bytes).map_err(StoreError)?;
        if is_jpeg(&bytes) != (image.image_format == ImageFormat::Jpeg) || bytes.len() as u64 != page.bytes || decoded.width != page.width || decoded.height != page.height || decoded.sha256 != page.sha256 {
            return Err(StoreError("image_integrity_failed"));
        }
        Ok((path, page.width, page.height, page.bytes, page.sha256.clone()))
    }

    fn split_sources(&self, image: &ImageRecord) -> Result<Vec<(PathBuf, u32, u32, u64, String, bool)>, StoreError> {
        let split = image.split.as_ref().ok_or(StoreError("split_not_available"))?;
        let (_, source_width, source_height, source_sha256) = self.read_selected(image)?;
        if split.source_width != source_width || split.source_height != source_height || split.source_sha256 != source_sha256 {
            return Err(StoreError("image_integrity_failed"));
        }
        let ordered = [split.first_page, split.first_page.opposite()];
        ordered.into_iter().map(|side| {
            let (path, width, height, bytes, digest) = self.read_split_page(image, split, side)?;
            Ok((path, width, height, bytes, digest, true))
        }).collect()
    }

    fn selected_source(&self, image: &ImageRecord) -> Result<(PathBuf, u32, u32, u64, String, bool), StoreError> {
        if let Some(crop) = &image.crop {
            let expected = format!("rendered/{:06}-v{}.{}", image.capture_id, crop.version, image.image_format.extension());
            if crop.path != expected { return Err(StoreError("manifest_path_invalid")); }
            let path = self.path.join(expected);
            ensure_regular_file(&path)?;
            Ok((path, crop.width, crop.height, crop.bytes, crop.sha256.clone(), true))
        } else {
            let expected = format!("originals/{:06}.{}", image.capture_id, image.image_format.extension());
            if image.path != expected { return Err(StoreError("manifest_path_invalid")); }
            let path = self.path.join(expected);
            ensure_regular_file(&path)?;
            Ok((path, image.width, image.height, image.bytes, image.sha256.clone(), false))
        }
    }

    fn inspect_internal(&self) -> Result<JobSnapshot, StoreError> {
        ensure_real_directory(&self.path)?;
        let mut issues = Vec::new();
        let mut referenced = HashSet::<String>::new();
        let mut latest = 0_u64;
        for image in &self.manifest.images {
            latest = latest.max(image.capture_id);
            let expected = format!("originals/{:06}.{}", image.capture_id, image.image_format.extension());
            if image.path != expected {
                return Err(StoreError("manifest_path_invalid"));
            }
            referenced.insert(expected.clone());
            match self.read_original(image) {
                Ok(_) => {},
                Err(error) => issues.push(format!("image_{}:{}", image.capture_id, error.code())),
            }
            if let Some(crop) = &image.crop {
                let expected = format!("rendered/{:06}-v{}.{}", image.capture_id, crop.version, image.image_format.extension());
                if crop.path != expected { return Err(StoreError("manifest_path_invalid")); }
                referenced.insert(expected.clone());
                match self.read_selected(image) {
                    Ok(_) => {},
                    Err(error) => issues.push(format!("crop_{}:{}", image.capture_id, error.code())),
                }
            }
            if let Some(split) = &image.split {
                let left = format!("rendered/{:06}-v{}-left.{}", image.capture_id, split.version, image.image_format.extension());
                let right = format!("rendered/{:06}-v{}-right.{}", image.capture_id, split.version, image.image_format.extension());
                if split.left.path != left || split.right.path != right { return Err(StoreError("manifest_path_invalid")); }
                referenced.insert(left);
                referenced.insert(right);
                if let Err(error) = self.split_sources(image) {
                    issues.push(format!("split_{}:{}", image.capture_id, error.code()));
                }
            }
        }
        if self.manifest.next_capture_id <= latest {
            return Err(StoreError("manifest_invalid"));
        }
        let mut orphan_files = Vec::new();
        for entry in fs::read_dir(&self.path).map_err(|_| StoreError("job_read_failed"))? {
            let entry = entry.map_err(|_| StoreError("job_read_failed"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "manifest.json" || name == ".job.lock" || matches!(name.as_str(), "originals" | "pending" | "rendered") {
                continue;
            }
            let item = entry.path();
            let file_type = entry.file_type().map_err(|_| StoreError("job_read_failed"))?;
            if file_type.is_symlink() || is_reparse_point(&item)? {
                return Err(StoreError("reparse_point_rejected"));
            }
            orphan_files.push(name);
        }
        for dir in ["originals", "pending", "rendered"] {
            let directory = self.path.join(dir);
            ensure_real_directory(&directory)?;
            for entry in fs::read_dir(&directory).map_err(|_| StoreError("job_read_failed"))? {
                let entry = entry.map_err(|_| StoreError("job_read_failed"))?;
                let file_type = entry.file_type().map_err(|_| StoreError("job_read_failed"))?;
                let item = entry.path();
                if file_type.is_symlink() || is_reparse_point(&item)? {
                    return Err(StoreError("reparse_point_rejected"));
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let relative = format!("{dir}/{name}");
                if file_type.is_dir() || !referenced.contains(&relative) {
                    orphan_files.push(relative);
                }
            }
        }
        orphan_files.sort();
        let resume_check_required = matches!(self.manifest.state, JobState::Interrupted | JobState::Paused | JobState::NeedsAttention);
        Ok(JobSnapshot { job_path: self.path.to_string_lossy().to_string(), manifest: self.manifest.clone(), orphan_files, issues, resume_check_required })
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        // A live capture is deliberately left uncommitted and is never auto-resumed.
        if self.manifest.state == JobState::Capturing {
            self.manifest.state = JobState::Interrupted;
            self.manifest.updated_at_ms = now_ms();
            let _ = write_manifest(&self.path, &self.manifest, true);
        }
        self.lock.take();
    }
}

fn validate_manifest(manifest: &Manifest) -> Result<(), StoreError> {
    if manifest.reset_files.iter().any(|file| !reset_owned_path(file))
        || (!manifest.reset_files.is_empty() && (!manifest.images.is_empty() || manifest.state == JobState::Capturing)) {
        return Err(StoreError("manifest_invalid"));
    }
    if manifest.job_id.is_empty() || manifest.job_id.len() > 80 || !manifest.job_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(StoreError("manifest_invalid"));
    }
    if !matches!(manifest.capture_settings.capture_scale, 1 | 2) || !(1..=100).contains(&manifest.capture_settings.jpeg_quality) { return Err(StoreError("manifest_invalid")); }
    let mut ids = HashSet::new();
    for image in &manifest.images {
        if image.capture_id == 0 || !ids.insert(image.capture_id) { return Err(StoreError("manifest_invalid")); }
        if !matches!(image.capture_scale, 1 | 2) { return Err(StoreError("manifest_invalid")); }
        if (image.image_format == ImageFormat::Jpeg) != image.jpeg_quality.is_some() || image.jpeg_quality.is_some_and(|q| !(1..=100).contains(&q)) { return Err(StoreError("manifest_invalid")); }
        let path = format!("originals/{:06}.{}", image.capture_id, image.image_format.extension());
        if image.path != path { return Err(StoreError("manifest_path_invalid")); }
        if let Some(crop) = &image.crop {
            if crop.version == 0 || crop.path != format!("rendered/{:06}-v{}.{}", image.capture_id, crop.version, image.image_format.extension()) {
                return Err(StoreError("manifest_path_invalid"));
            }
        }
        if let Some(split) = &image.split {
            let (source_width, source_height, source_sha256) = image.crop.as_ref().map(|crop| (crop.width, crop.height, crop.sha256.as_str()))
                .unwrap_or((image.width, image.height, image.sha256.as_str()));
            if split.version == 0 || split.version >= manifest.next_render_version
                || split.source_width != source_width || split.source_height != source_height || split.source_sha256 != source_sha256
                || split.source_width < 2 || split.boundary_x != split.source_width / 2
                || split.left.path != format!("rendered/{:06}-v{}-left.{}", image.capture_id, split.version, image.image_format.extension())
                || split.right.path != format!("rendered/{:06}-v{}-right.{}", image.capture_id, split.version, image.image_format.extension())
                || split.left.width != split.boundary_x || split.right.width != split.source_width - split.boundary_x
                || split.left.height != split.source_height || split.right.height != split.source_height
            {
                return Err(StoreError("manifest_invalid"));
            }
        }
    }
    if manifest.next_capture_id == 0 || manifest.next_render_version == 0 {
        return Err(StoreError("manifest_invalid"));
    }
    let selected: HashSet<_> = manifest.selected_capture_ids.iter().copied().collect();
    let excluded: HashSet<_> = manifest.excluded_capture_ids.iter().copied().collect();
    if selected.len() != manifest.selected_capture_ids.len() || excluded.len() != manifest.excluded_capture_ids.len()
        || selected.iter().any(|id| !ids.contains(id)) || excluded.iter().any(|id| !ids.contains(id))
        || !selected.is_disjoint(&excluded) || selected.union(&excluded).any(|id| !ids.contains(id))
        || selected.union(&excluded).count() != ids.len()
    {
        return Err(StoreError("manifest_invalid"));
    }
    if let Some(last) = manifest.last_capture_id {
        if !ids.contains(&last) { return Err(StoreError("manifest_invalid")); }
    }
    if let Some(checkpoint) = &manifest.checkpoint {
        if Some(checkpoint.capture_id) != manifest.last_capture_id || checkpoint.position.is_empty()
            || checkpoint.position.chars().count() > 200
            || !matches!(checkpoint.dispatch.as_str(), "not_sent" | "unknown" | "sent" | "confirmed") {
            return Err(StoreError("manifest_invalid"));
        }
    }
    Ok(())
}

fn reset_owned_path(value: &str) -> bool {
    let Some((dir, name)) = value.split_once('/') else { return false; };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match dir {
        "originals" => name.strip_suffix(".png").or_else(|| name.strip_suffix(".jpg")).is_some_and(digits),
        "pending" => name.strip_suffix(".upload").is_some_and(digits),
        "rendered" => name.strip_suffix(".png").or_else(|| name.strip_suffix(".jpg")).and_then(|s| s.split_once("-v")).is_some_and(|(id, rest)| {
            digits(id) && digits(rest.strip_suffix("-left").or_else(|| rest.strip_suffix("-right")).unwrap_or(rest))
        }),
        _ => false,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u128::from(u64::MAX)) as u64
}

fn new_job_id() -> String {
    let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{time}-{}-{sequence}", std::process::id());
    sha256(seed.as_bytes())[..32].to_owned()
}

fn reject_parent_components(path: &Path) -> Result<(), StoreError> {
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(StoreError("invalid_path"));
    }
    Ok(())
}

fn ensure_no_reparse_chain(path: &Path) -> Result<(), StoreError> {
    let ancestors: Vec<_> = path.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                if is_reparse_point(ancestor)? { return Err(StoreError("reparse_point_rejected")); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err(StoreError("path_access_denied")),
        }
    }
    Ok(())
}

fn ensure_real_directory(path: &Path) -> Result<(), StoreError> {
    reject_parent_components(path)?;
    ensure_no_reparse_chain(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| StoreError("directory_not_found"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(StoreError("directory_invalid")); }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), StoreError> {
    reject_parent_components(path)?;
    ensure_no_reparse_chain(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| StoreError("file_not_found"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(StoreError("file_invalid")); }
    Ok(())
}

fn open_existing_regular(path: &Path) -> Result<File, StoreError> {
    ensure_regular_file(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let file = OpenOptions::new().read(true).custom_flags(OPEN_REPARSE_POINT)
            .open(path).map_err(|_| StoreError("file_read_failed"))?;
        let metadata = file.metadata().map_err(|_| StoreError("file_read_failed"))?;
        if !metadata.is_file() || metadata.file_attributes() & 0x0000_0400 != 0 {
            return Err(StoreError("reparse_point_rejected"));
        }
        Ok(file)
    }
    #[cfg(not(windows))]
    {
        File::open(path).map_err(|_| StoreError("file_read_failed"))
    }
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> Result<bool, StoreError> {
    use std::os::windows::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).map_err(|_| StoreError("path_access_denied"))?;
    Ok(metadata.file_attributes() & 0x0000_0400 != 0)
}

#[cfg(not(windows))]
fn is_reparse_point(path: &Path) -> Result<bool, StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| StoreError("path_access_denied"))?;
    Ok(metadata.file_type().is_symlink())
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, &'static str> {
    let file = open_existing_regular(path).map_err(|error| error.code())?;
    let metadata = file.metadata().map_err(|_| "file_read_failed")?;
    if metadata.len() > max_bytes { return Err("file_too_large"); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1).read_to_end(&mut bytes).map_err(|_| "file_read_failed")?;
    if bytes.len() as u64 > max_bytes { return Err("file_too_large"); }
    Ok(bytes)
}

fn write_manifest(path: &Path, manifest: &Manifest, replace: bool) -> Result<(), StoreError> {
    ensure_real_directory(path)?;
    let manifest_path = path.join("manifest.json");
    if replace {
        ensure_regular_file(&manifest_path)?;
    } else if fs::symlink_metadata(&manifest_path).is_ok() {
        return Err(StoreError("manifest_exists"));
    }
    let bytes = serde_json::to_vec(manifest).map_err(|_| StoreError("manifest_write_failed"))?;
    let temp_path = path.join(format!(".manifest-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp_path).map_err(|_| StoreError("manifest_write_failed"))?;
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        drop(file);
        let _ = fs::remove_file(&temp_path);
        return Err(StoreError("manifest_write_failed"));
    }
    drop(file);
    let result = if replace {
        replace_file(&temp_path, &manifest_path)
    } else {
        fs::hard_link(&temp_path, &manifest_path).map_err(|_| StoreError("manifest_write_failed"))
    };
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
        return result;
    }
    if fs::remove_file(&temp_path).is_err() {
        // The destination is durable; an extra uniquely-owned manifest temp is visible on recovery.
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), StoreError> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" { fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32; }
    let source = source.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let destination = destination.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x0000_0001 | 0x0000_0008) };
    if result == 0 { Err(StoreError("manifest_write_failed")) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), StoreError> {
    fs::rename(source, destination).map_err(|_| StoreError("manifest_write_failed"))
}

fn validate_output_path(path: &Path, format: ArchiveFormat) -> Result<(PathBuf, String), StoreError> {
    reject_parent_components(path)?;
    let parent = path.parent().ok_or(StoreError("invalid_output_path"))?;
    ensure_real_directory(parent)?;
    let file_name = path.file_name().and_then(|name| name.to_str()).ok_or(StoreError("invalid_output_path"))?;
    if file_name.is_empty() || file_name == "." || file_name == ".." || file_name.chars().any(|character| character == '/' || character == '\\') {
        return Err(StoreError("invalid_output_path"));
    }
    let ext = path.extension().and_then(|extension| extension.to_str()).ok_or(StoreError("invalid_output_path"))?;
    if !ext.eq_ignore_ascii_case(format.extension()) { return Err(StoreError("output_extension_mismatch")); }
    let parent = fs::canonicalize(parent).map_err(|_| StoreError("invalid_output_path"))?;
    let destination = parent.join(file_name);
    if fs::symlink_metadata(&destination).is_ok() { return Err(StoreError("output_exists")); }
    Ok((destination, file_name.to_owned()))
}

pub fn create_private_session_directory(path: &Path) -> Result<String, StoreError> {
    reject_parent_components(path)?;
    let parent = path.parent().ok_or(StoreError("invalid_path"))?;
    ensure_real_directory(parent)?;
    if fs::symlink_metadata(path).is_ok() { return Err(StoreError("directory_exists")); }
    fs::create_dir(path).map_err(|_| StoreError("directory_create_failed"))?;
    if let Err(error) = apply_current_user_acl(path) {
        let _ = fs::remove_dir(path);
        return Err(error);
    }
    Ok(path.to_string_lossy().to_string())
}

#[cfg(windows)]
fn apply_current_user_acl(path: &Path) -> Result<(), StoreError> {
    use std::process::Command;
    ensure_real_directory(path)?;
    let system_root = std::env::var_os("SystemRoot").ok_or(StoreError("acl_unavailable"))?;
    let user = std::env::var("USERNAME").map_err(|_| StoreError("acl_unavailable"))?;
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    if user.is_empty() { return Err(StoreError("acl_unavailable")); }
    let principal = if domain.is_empty() { user } else { format!("{domain}\\{user}") };
    let icacls = PathBuf::from(system_root).join("System32").join("icacls.exe");
    let grant = format!("{principal}:(OI)(CI)F");
    let result = Command::new(icacls)
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(grant)
        .output()
        .map_err(|_| StoreError("acl_apply_failed"))?;
    if !result.status.success() { return Err(StoreError("acl_apply_failed")); }
    Ok(())
}

#[cfg(not(windows))]
fn apply_current_user_acl(_path: &Path) -> Result<(), StoreError> {
    Err(StoreError("acl_unsupported"))
}

#[cfg(windows)]
struct JobLock {
    file: File,
    overlapped: Box<Overlapped>,
    locked: bool,
}

#[cfg(windows)]
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: isize,
}

#[cfg(windows)]
fn acquire_job_lock(path: &Path) -> Result<JobLock, StoreError> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const FILE_SHARE_ALL: u32 = 0x0000_0001 | 0x0000_0002 | 0x0000_0004;
    let lock_path = path.join(".job.lock");
    if fs::symlink_metadata(&lock_path).is_ok() && is_reparse_point(&lock_path)? {
        return Err(StoreError("reparse_point_rejected"));
    }
    let file = OpenOptions::new().read(true).write(true).create(true)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED)
        .open(&lock_path).map_err(|_| StoreError("job_lock_failed"))?;
    if is_reparse_point(&lock_path)? || !file.metadata().map_err(|_| StoreError("job_lock_failed"))?.is_file() {
        return Err(StoreError("reparse_point_rejected"));
    }
    #[link(name = "kernel32")]
    unsafe extern "system" { fn LockFileEx(file: isize, flags: u32, reserved: u32, low: u32, high: u32, overlapped: *mut Overlapped) -> i32; }
    let mut overlapped = Box::new(Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event: 0 });
    let result = unsafe { LockFileEx(file.as_raw_handle() as isize, 0x0000_0002 | 0x0000_0001, 0, 1, 0, &mut *overlapped) };
    if result == 0 { return Err(StoreError("job_busy")); }
    Ok(JobLock { file, overlapped, locked: true })
}

#[cfg(windows)]
impl Drop for JobLock {
    fn drop(&mut self) {
        if !self.locked { return; }
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" { fn UnlockFileEx(file: isize, reserved: u32, low: u32, high: u32, overlapped: *mut Overlapped) -> i32; }
        let _ = unsafe { UnlockFileEx(self.file.as_raw_handle() as isize, 0, 1, 0, &mut *self.overlapped) };
        self.locked = false;
    }
}

#[cfg(not(windows))]
struct JobLock;

#[cfg(not(windows))]
fn acquire_job_lock(_path: &Path) -> Result<JobLock, StoreError> {
    Err(StoreError("job_lock_unsupported"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use png::{BitDepth, ColorType, Encoder};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/mvp-tests/rust-store");
            fs::create_dir_all(&base).unwrap();
            let base = fs::canonicalize(base).unwrap();
            for _ in 0..32 {
                let path = base.join(format!("{label}-{}-{}", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("failed to create test directory: {error}"),
                }
            }
            panic!("could not allocate a unique Rust store test directory")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, width, height);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![127; (width * height * 3) as usize]).unwrap();
        }
        bytes
    }

    fn odd_spread_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, 5, 2);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let pixels = (0..2).flat_map(|_| [10_u8, 20, 30, 40, 50].into_iter().flat_map(|v| [v, v + 1, v + 2])).collect::<Vec<_>>();
            writer.write_image_data(&pixels).unwrap();
        }
        bytes
    }

    fn capture(store: &mut Store, bytes: &[u8]) -> u64 {
        let id = store.begin_capture().unwrap();
        for chunk in bytes.chunks(MAX_CHUNK_BYTES) { store.write_capture_chunk(id, chunk).unwrap(); }
        store.commit_capture().unwrap();
        id
    }

    #[test]
    fn reset_rejects_writer_and_recovers_durable_cleanup_without_reviving_images() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = TempDir::new("reset");
        let mut store = Store::create(&temp.0).unwrap();
        let other = Store::create(&temp.0).unwrap();
        let other_manifest = fs::read(other.path.join("manifest.json")).unwrap();
        store.start_capture().unwrap();
        let first = capture(&mut store, &png(3, 2));
        assert_eq!(store.reset_images().unwrap_err().code(), "capture_pending");
        store.begin_capture().unwrap();
        store.pause_capture().unwrap();
        assert_eq!(store.reset_images().unwrap_err().code(), "capture_pending");
        store.abort_capture().unwrap();
        store.stop_capture().unwrap();
        store.set_review_order(vec![first]).unwrap();
        let crop = store.crop_image(first, 0, 0, 2, 2).unwrap().crop;
        let derived = store.path.join(&crop.path);
        store.set_review_order(vec![]).unwrap();
        let original = store.path.join(&store.manifest.images[0].path);
        fs::write(store.path.join("keep.zip"), b"existing-output").unwrap();
        let locked = OpenOptions::new().read(true).share_mode(1).open(&original).unwrap();
        assert_eq!(store.reset_images().unwrap_err().code(), "reset_cleanup_failed");
        assert!(store.manifest.images.is_empty());
        assert!(!store.manifest.reset_files.is_empty());
        assert_eq!(store.start_capture().unwrap_err().code(), "reset_cleanup_failed");
        // A user may leave the failed reset through review/normal close. Those
        // empty-state transitions must not make the durable journal unreadable.
        store.set_review_order(vec![]).unwrap();
        store.confirm_range(true).unwrap();
        let path = store.path.clone();
        store.close().unwrap();
        drop(locked);
        let mut reopened = Store::open(&path).unwrap();
        assert!(!original.exists());
        assert!(!derived.exists());
        assert!(reopened.manifest.reset_files.is_empty());
        assert!(reopened.manifest.images.is_empty());
        assert!(reopened.manifest.selected_capture_ids.is_empty());
        assert!(reopened.manifest.excluded_capture_ids.is_empty());
        assert_eq!(reopened.manifest.state, JobState::Ready);
        assert!(!reopened.manifest.range_confirmed);
        assert_eq!(fs::read(path.join("keep.zip")).unwrap(), b"existing-output");
        assert_eq!(fs::read(other.path.join("manifest.json")).unwrap(), other_manifest);
        reopened.start_capture().unwrap();
        let next = capture(&mut reopened, &png(3, 2));
        assert!(next > first);
        assert!(!reopened.manifest.images[0].duplicate_candidate);
    }

    #[test]
    fn reset_preflight_refuses_unowned_paths_and_manifest_failure_preserves_originals() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = TempDir::new("reset-failure");
        let mut store = Store::create(&temp.0).unwrap();
        store.start_capture().unwrap();
        capture(&mut store, &png(3, 2));
        store.pause_capture().unwrap();
        let original = store.path.join(&store.manifest.images[0].path);
        let unknown = store.path.join("rendered/do-not-delete.zip");
        fs::write(&unknown, b"preserve").unwrap();
        assert_eq!(store.reset_images().unwrap_err().code(), "reset_unowned_file");
        assert!(original.exists());
        fs::remove_file(unknown).unwrap();
        let locked = OpenOptions::new().read(true).share_mode(1).open(store.path.join("manifest.json")).unwrap();
        assert!(store.reset_images().is_err());
        assert_eq!(store.manifest.images.len(), 1);
        assert!(original.exists());
        drop(locked);
        store.reset_images().unwrap();
        assert!(!original.exists());
        assert!(!reset_owned_path("originals/../keep.zip"));
        assert!(!reset_owned_path("rendered/1-v2.png/other"));
    }

    #[test]
    fn export_destination_preserves_exact_folder_and_reads_legacy_filename_only_records() {
        let temp = TempDir::new("export-destination");
        let mut store = Store::create(&temp.0).unwrap();
        store.start_capture().unwrap();
        capture(&mut store, &png(3, 2));
        store.pause_capture().unwrap();
        let external = temp.0.join("chosen-folder");
        fs::create_dir(&external).unwrap();
        let destination = external.join("same.zip");
        store.export(&destination, ArchiveFormat::Zip).unwrap();
        let archive = fs::read(&destination).unwrap();
        assert_eq!(store.manifest.exports[0].destination.as_deref(), destination.to_str());
        let job_path = store.path.clone();
        store.close().unwrap();
        let manifest_path = job_path.join("manifest.json");
        let mut legacy: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        legacy["exports"][0].as_object_mut().unwrap().remove("destination");
        fs::write(&manifest_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut reopened = Store::open(&job_path).unwrap();
        assert!(reopened.manifest.exports[0].destination.is_none());
        reopened.export(&job_path.join("same.zip"), ArchiveFormat::Zip).unwrap();
        assert_eq!(reopened.export(&destination, ArchiveFormat::Zip).unwrap_err().code(), "output_exists");
        assert_eq!(fs::read(destination).unwrap(), archive);
        assert!(reopened.snapshot().unwrap().issues.is_empty());
    }

    #[test]
    fn persisted_capture_reopen_requires_explicit_target_and_position_confirmation() {
        let temp = TempDir::new("resume");
        let mut store = Store::create(&temp.0).unwrap();
        let job = store.path.clone();
        store.start_capture().unwrap();
        let first = capture(&mut store, &png(3, 2));
        store.pause_capture().unwrap();
        store.close().unwrap();
        let mut reopened = Store::open(&job).unwrap();
        assert_eq!(reopened.manifest.state, JobState::Paused);
        assert!(reopened.confirm_resume(Some(first + 1), true).is_err());
        assert!(reopened.confirm_resume(Some(first), false).is_err());
        reopened.confirm_resume(Some(first), true).unwrap();
        reopened.start_capture().unwrap();
        assert_eq!(capture(&mut reopened, &png(3, 2)), first + 1);
    }

    #[test]
    fn review_state_requires_fresh_target_position_and_last_capture_confirmation_before_resume() {
        let temp = TempDir::new("review-resume");
        let mut store = Store::create(&temp.0).unwrap();
        store.start_capture().unwrap();
        let first = capture(&mut store, &png(3, 2));
        store.stop_capture().unwrap();
        store.set_review_order(vec![first]).unwrap();

        assert!(store.confirm_resume(Some(first + 1), true).is_err());
        assert!(store.confirm_resume(Some(first), false).is_err());
        assert_eq!(store.manifest.state, JobState::Review, "a failed confirmation never leaves review");
        assert_eq!(store.confirm_resume(Some(first), true).unwrap(), JobState::Ready);
        assert_eq!(store.manifest.images.len(), 1, "resume preserves the committed original");
    }

    #[test]
    fn opening_a_crashed_capture_marks_it_interrupted_without_adopting_pending_bytes() {
        let temp = TempDir::new("crash");
        let mut store = Store::create(&temp.0).unwrap();
        let job = store.path.clone();
        store.start_capture().unwrap();
        let pending = store.begin_capture().unwrap();
        store.write_capture_chunk(pending, &png(2, 2)).unwrap();
        // Simulate abrupt process loss by releasing only the OS lock.
        store.manifest.state = JobState::Capturing;
        store.lock.take();
        std::mem::forget(store);
        let reopened = Store::open(&job).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(snapshot.manifest.state, JobState::Interrupted);
        assert_eq!(snapshot.manifest.images.len(), 0);
        assert!(snapshot.resume_check_required);
        assert!(snapshot.orphan_files.iter().any(|file| file == &format!("pending/{pending:06}.upload")));
    }

    #[test]
    fn output_selection_is_ordered_and_exclusions_do_not_delete_originals() {
        let temp = TempDir::new("review");
        let mut store = Store::create(&temp.0).unwrap();
        store.start_capture().unwrap();
        let first = capture(&mut store, &png(2, 2));
        let second = capture(&mut store, &png(3, 2));
        let job = store.path.clone();
        store.stop_capture().unwrap();
        let snapshot = store.set_review_order(vec![second]).unwrap();
        assert_eq!(snapshot.manifest.selected_capture_ids, vec![second]);
        assert_eq!(snapshot.manifest.excluded_capture_ids, vec![first]);
        assert!(job.join(format!("originals/{first:06}.png")).is_file());
        assert!(job.join(format!("originals/{second:06}.png")).is_file());
    }

    #[test]
    fn split_spreads_keeps_odd_center_pixel_original_crop_and_reading_order() {
        let temp = TempDir::new("split-spread");
        let mut store = Store::create(&temp.0).unwrap();
        let job = store.path.clone();
        let original = odd_spread_png();
        let original_hash = sha256(&original);
        store.set_capture_settings(CaptureSettings {
            capture_scale: 2,
            page_output_mode: PageOutputMode::SplitSpread,
            reading_direction: ReadingDirection::RightToLeft,
            ..CaptureSettings::default()
        }).unwrap();
        store.start_capture().unwrap();
        let id = capture(&mut store, &original);
        let image = store.manifest.images.iter().find(|image| image.capture_id == id).unwrap();
        let original_path = image.path.clone();
        let split = image.split.as_ref().unwrap();
        assert_eq!((image.width, image.height, image.capture_scale), (5, 2, 2));
        assert_eq!(image.sha256, original_hash);
        assert_eq!((split.boundary_x, split.left.width, split.right.width, split.left.height), (2, 2, 3, 2));
        assert_eq!(split.first_page, PageSide::Right);
        let ordered = store.split_sources(image).unwrap();
        assert!(ordered[0].0.to_string_lossy().ends_with("-right.png"));
        assert!(ordered[1].0.to_string_lossy().ends_with("-left.png"));
        let right = decode_rendered(&fs::read(&ordered[0].0).unwrap()).unwrap();
        let left = decode_rendered(&fs::read(&ordered[1].0).unwrap()).unwrap();
        assert_eq!((right.width, left.width), (3, 2));
        assert_eq!((right.pixels[0], left.pixels[0]), (30, 10), "奇数幅の中央画素は右ページ側に一度だけ含める");
        assert_eq!(fs::read(store.path.join(&original_path)).unwrap(), original, "分割後も原本を保持する");

        store.stop_capture().unwrap();
        store.set_review_order(vec![id]).unwrap();
        let crop = store.crop_image(id, 1, 0, 3, 2).unwrap().crop;
        let image = store.manifest.images.iter().find(|image| image.capture_id == id).unwrap();
        let split = image.split.as_ref().unwrap();
        assert_eq!((crop.width, crop.height, split.source_width, split.boundary_x), (3, 2, 3, 1));
        assert_eq!(split.source_sha256, crop.sha256, "既存クロップ結果を入力として同じ1ページ単位を保つ");
        assert_eq!((split.left.width, split.right.width), (1, 2));
        assert_eq!(split.first_page, PageSide::Right);
        let output = temp.0.join("split.cbz");
        let export = store.export(&output, ArchiveFormat::Cbz).unwrap();
        assert_eq!(export.entry_count, 2, "選択順の1画像を右・左の2出力ページへ展開する");
        let archive = fs::read(output).unwrap();
        assert!(archive.windows(b"000001.png".len()).any(|part| part == b"000001.png"));
        assert!(archive.windows(b"000002.png".len()).any(|part| part == b"000002.png"));
        assert_eq!(fs::read(store.path.join(&original_path)).unwrap(), original, "クロップ・分割・出力も原本を変更しない");
        store.close().unwrap();
        let reopened = Store::open(&job).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert!(snapshot.issues.is_empty());
        assert_eq!(snapshot.manifest.capture_settings.capture_scale, 2);
        assert_eq!(snapshot.manifest.capture_settings.page_output_mode, PageOutputMode::SplitSpread);
        assert_eq!(snapshot.manifest.capture_settings.reading_direction, ReadingDirection::RightToLeft);
        assert_eq!(snapshot.manifest.images[0].split.as_ref().unwrap().boundary_x, 1);
    }

    #[test]
    fn legacy_manifest_without_capture_settings_keeps_single_image_and_standard_scale() {
        let temp = TempDir::new("legacy-capture-settings");
        let store = Store::create(&temp.0).unwrap();
        let mut document: serde_json::Value = serde_json::to_value(store.manifest()).unwrap();
        document.as_object_mut().unwrap().remove("capture_settings");
        let legacy: Manifest = serde_json::from_value(document).unwrap();
        assert_eq!(legacy.capture_settings.capture_scale, 1);
        assert_eq!(legacy.capture_settings.page_output_mode, PageOutputMode::SingleImage);
        assert_eq!(legacy.capture_settings.reading_direction, ReadingDirection::RightToLeft);
    }

    #[test]
    fn duplicate_white_images_are_kept_and_marked_for_review() {
        let temp = TempDir::new("duplicate");
        let mut store = Store::create(&temp.0).unwrap();
        store.start_capture().unwrap();
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[255; 12]).unwrap();
        }
        let first = capture(&mut store, &bytes);
        let second = capture(&mut store, &bytes);
        assert_eq!(store.manifest.images.len(), 2);
        assert!(store.manifest.images.iter().all(|image| image.blank_candidate));
        assert!(store.manifest.images.iter().find(|image| image.capture_id == second).unwrap().duplicate_candidate);
        assert_eq!(store.manifest.images[0].capture_id, first);
    }

    #[test]
    fn job_lock_is_exclusive_and_future_manifest_is_not_rewritten() {
        let temp = TempDir::new("lock-future");
        let store = Store::create(&temp.0).unwrap();
        let job = store.path.clone();
        match Store::open(&job) {
            Err(error) => assert_eq!(error.code(), "job_busy"),
            Ok(opened) => { drop(opened); panic!("second opener unexpectedly acquired the job lock"); }
        }
        drop(store);

        let manifest_path = job.join("manifest.json");
        let mut document: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        document["schema_version"] = serde_json::json!(SCHEMA_VERSION + 1);
        let future = serde_json::to_vec(&document).unwrap();
        fs::write(&manifest_path, &future).unwrap();
        match Store::open(&job) {
            Err(error) => assert_eq!(error.code(), "future_manifest"),
            Ok(opened) => { drop(opened); panic!("future manifest unexpectedly opened"); }
        }
        assert_eq!(fs::read(manifest_path).unwrap(), future);
    }

    #[test]
    fn manifest_relative_path_escape_is_rejected_without_touching_target() {
        let temp = TempDir::new("path-escape");
        let mut store = Store::create(&temp.0).unwrap();
        store.start_capture().unwrap();
        capture(&mut store, &png(2, 2));
        store.stop_capture().unwrap();
        let job = store.path.clone();
        store.close().unwrap();

        let manifest_path = job.join("manifest.json");
        let mut document: serde_json::Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        document["images"][0]["path"] = serde_json::json!("../outside.png");
        fs::write(&manifest_path, serde_json::to_vec(&document).unwrap()).unwrap();
        let outside = job.parent().unwrap().join("outside.png");
        fs::write(&outside, b"keep").unwrap();
        match Store::open(&job) {
            Err(error) => assert_eq!(error.code(), "manifest_path_invalid"),
            Ok(opened) => { drop(opened); panic!("escaping manifest path unexpectedly opened"); }
        }
        assert_eq!(fs::read(outside).unwrap(), b"keep");
    }
}
