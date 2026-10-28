use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

mod private_paths;
use private_paths::PrivateAcl;

const BUNDLE_MAGIC: &[u8; 8] = b"KTZBNDL1";
const FOOTER_MAGIC: &[u8; 8] = b"KTZEND01";
const FOOTER_BYTES: u64 = 56;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const CONTROLLER_NAME: &str = "ktz-g02-controller.exe";
const COMPLETE_FILE: &str = ".ktz-bundle-complete";
const REQUIRED_FILES: &[&str] = &[
    "node/node.exe",
    "controller/ktz-g02-controller.exe",
    "app/main.mjs",
    "app/ui/index.html",
    "poc/launcher/smoke.mjs",
    "node_modules/playwright/index.mjs",
    "node_modules/playwright-core/index.mjs",
    "artifacts/browsers/chromium-1248/chrome-win64/chrome.exe",
    "artifacts/browsers/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe",
    "artifacts/browsers/ffmpeg-1013/ffmpeg-win64.exe",
];
static STAGING_COUNTER: AtomicU64 = AtomicU64::new(1);

struct EmbeddedPayload {
    executable: PathBuf,
    payload_offset: u64,
    payload_len: u64,
    sha256: [u8; 32],
}

struct BundleReader {
    file: File,
    remaining: u64,
    digest: Sha256,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("KindleToZipを起動できませんでした: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    if !cfg!(windows) {
        return Err("この配布物はWindows専用です。".to_owned());
    }
    let embedded = embedded_payload()?;
    let payload_hash = embedded.sha256;

    let portable_root = embedded.executable.parent()
        .ok_or_else(|| "EXEと同じフォルダを確認できません。EXEを通常のフォルダへ置いてください。".to_owned())?
        .to_path_buf();
    ensure_absolute_without_parent(&portable_root)?;
    ensure_directory_chain(&portable_root)?;

    let runtime_parent = portable_root.join("runtime");
    ensure_directory_chain(&runtime_parent)?;
    let private_acl = PrivateAcl::current()?;
    private_acl.protect(&runtime_parent)?;
    // Keep Chromium's executable path short even when the portable folder is
    // located below a long Unicode path. The full payload hash is still
    // checked against the completion receipt before an extracted runtime is
    // reused; a short-name collision therefore fails closed.
    let runtime_name = format!("{APP_VERSION}-{}", &hex(&payload_hash)[..12]);
    let runtime_root = runtime_parent.join(runtime_name);
    ensure_supported_path_lengths(&embedded.executable, &portable_root, &runtime_root)?;
    match fs::symlink_metadata(&runtime_root) {
        Ok(_) => verify_complete_runtime(&runtime_root, &payload_hash)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            extract_runtime(&runtime_parent, &runtime_root, &embedded)?;
        }
        Err(error) => return Err(format!("展開済みランタイムを確認できません: {error}")),
    }
    private_acl.protect_tree(&runtime_root)?;

    let data_dir = portable_root.join("data");
    let temp_dir = portable_root.join("temp");
    ensure_directory_chain(&data_dir)?;
    ensure_directory_chain(&temp_dir)?;
    private_acl.protect_tree(&temp_dir)?;

    let node = regular_file(&runtime_root.join("node/node.exe"))?;
    let controller = regular_file(&runtime_root.join("controller").join(CONTROLLER_NAME))?;
    let browser_root = regular_file_directory(&runtime_root.join("artifacts/browsers"))?;
    // These variables are internal handoff values only. Discard inherited
    // values first so old test overrides or user environment cannot redirect
    // a portable run outside the directory that contains the EXE.
    for name in ["KTZ_PORTABLE_HOME", "KTZ_USER_DATA_DIR", "KTZ_TEMP_DIR", "KTZ_RUNTIME_DIR", "KTZ_PORTABLE_ROOT"] {
        env::remove_var(name);
    }
    env::set_var("KTZ_PORTABLE_ROOT", &portable_root);
    env::set_var("KTZ_USER_DATA_DIR", &data_dir);
    env::set_var("KTZ_RUNTIME_DIR", &runtime_root);
    env::set_var("KTZ_TEMP_DIR", &temp_dir);
    env::set_var("TEMP", &temp_dir);
    env::set_var("TMP", &temp_dir);
    env::set_var("TMPDIR", &temp_dir);
    env::set_var("LOCALAPPDATA", &temp_dir);
    env::set_var("APPDATA", &temp_dir);
    env::set_var("HOME", &temp_dir);
    env::set_var("USERPROFILE", &temp_dir);
    env::set_var("XDG_CACHE_HOME", &temp_dir);
    env::set_var("XDG_CONFIG_HOME", &temp_dir);
    env::set_var("XDG_DATA_HOME", &temp_dir);
    env::set_var("KTZ_CONTROLLER_PATH", controller);
    env::set_var("PLAYWRIGHT_BROWSERS_PATH", browser_root);
    env::remove_var("NODE_OPTIONS");
    env::remove_var("NODE_PATH");

    let mut args = env::args_os().skip(1);
    let first = args.next();
    let distribution_mode = first.as_deref().is_some_and(|arg| matches!(arg.to_str(),
        Some("--distribution-smoke" | "--distribution-resume-smoke" | "--distribution-lock-hold" | "--distribution-lock-probe")
    ));
    let mut child = Command::new(node);
    child.current_dir(&runtime_root);
    if distribution_mode {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x08000000); // CREATE_NO_WINDOW for background checks.
        }
        child.arg("poc/launcher/smoke.mjs");
        if let Some(arg) = first { child.arg(arg); }
    } else {
        child.arg("app/main.mjs");
        if let Some(arg) = first { child.arg(arg); }
    }
    child.args(args);
    child.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    let status = child.status().map_err(|error| format!("同梱Node.jsを起動できません: {error}"))?;
    Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
}

fn embedded_payload() -> Result<EmbeddedPayload, String> {
    let executable = env::current_exe().map_err(|error| format!("起動ファイルの場所を確認できません: {error}"))?;
    let mut file = File::open(&executable).map_err(|error| format!("起動ファイルを読めません: {error}"))?;
    let total_len = file.metadata().map_err(|error| format!("起動ファイルを確認できません: {error}"))?.len();
    if total_len < FOOTER_BYTES { return Err("内包データの終端記録がありません。".to_owned()); }
    file.seek(SeekFrom::End(-(FOOTER_BYTES as i64))).map_err(|error| format!("内包データの位置を確認できません: {error}"))?;
    let mut footer = [0_u8; FOOTER_BYTES as usize];
    file.read_exact(&mut footer).map_err(|error| format!("内包データの終端記録を読めません: {error}"))?;
    if &footer[..8] != FOOTER_MAGIC { return Err("内包データの終端記録が一致しません。".to_owned()); }
    let base_len = u64::from_le_bytes(footer[8..16].try_into().unwrap());
    let payload_len = u64::from_le_bytes(footer[16..24].try_into().unwrap());
    let sha256: [u8; 32] = footer[24..56].try_into().unwrap();
    if payload_len == 0 || base_len == 0 || base_len.checked_add(payload_len).and_then(|n| n.checked_add(FOOTER_BYTES)) != Some(total_len) {
        return Err("内包データの長さが一致しません。".to_owned());
    }
    Ok(EmbeddedPayload { executable, payload_offset: base_len, payload_len, sha256 })
}

fn extract_runtime(parent: &Path, destination: &Path, embedded: &EmbeddedPayload) -> Result<(), String> {
    let staging = parent.join(format!(
        ".staging-{}-{}-{}",
        hex(&embedded.sha256), std::process::id(), STAGING_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&staging).map_err(|error| portable_path_error(&staging, error))?;
    let result = (|| {
        unpack_payload(embedded, &staging)?;
        let receipt = format!("KindleToZip {APP_VERSION}\nsha256={}\n", hex(&embedded.sha256));
        let receipt_path = staging.join(COMPLETE_FILE);
        let mut file = OpenOptions::new().write(true).create_new(true).open(&receipt_path)
            .map_err(|error| format!("内部展開の完了記録を作れません: {error}"))?;
        file.write_all(receipt.as_bytes()).map_err(|error| format!("内部展開の完了記録を書けません: {error}"))?;
        file.sync_all().map_err(|error| format!("内部展開の完了記録を確定できません: {error}"))?;
        drop(file);
        match fs::rename(&staging, destination) {
            Ok(()) => Ok(()),
            Err(_error) if destination.exists() => verify_complete_runtime(destination, &embedded.sha256),
            Err(error) => Err(format!("内部展開を確定できません: {error}")),
        }
    })();
    if result.is_err() || staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn unpack_payload(embedded: &EmbeddedPayload, destination: &Path) -> Result<(), String> {
    let mut file = File::open(&embedded.executable).map_err(|error| format!("起動ファイルを再度読めません: {error}"))?;
    file.seek(SeekFrom::Start(embedded.payload_offset)).map_err(|error| format!("内包データへ移動できません: {error}"))?;
    let mut reader = BundleReader { file, remaining: embedded.payload_len, digest: Sha256::new() };
    if reader.read_bytes(8)? != BUNDLE_MAGIC { return Err("内包データの形式が正しくありません。".to_owned()); }
    let count = reader.read_u32()? as usize;
    if count == 0 || count > 100_000 { return Err("内包ファイル数が範囲外です。".to_owned()); }
    let mut names = HashSet::with_capacity(count);
    let mut required = HashSet::with_capacity(REQUIRED_FILES.len());
    for _ in 0..count {
        let name_len = reader.read_u16()? as usize;
        let size = reader.read_u64()?;
        if name_len == 0 || name_len > 4096 { return Err("内包パスの長さが範囲外です。".to_owned()); }
        let relative = String::from_utf8(reader.read_bytes(name_len)?)
            .map_err(|_| "内包パスがUTF-8ではありません。".to_owned())?;
        let path = bundle_path(&relative)?;
        if !names.insert(relative.to_lowercase()) { return Err("内包パスが重複しています。".to_owned()); }
        if REQUIRED_FILES.contains(&relative.as_str()) { required.insert(relative.clone()); }
        let output = destination.join(path);
        let output_parent = output.parent().ok_or_else(|| "内包ファイルの親パスがありません。".to_owned())?;
        ensure_directory_chain(output_parent)?;
        let mut output_file = OpenOptions::new().write(true).create_new(true).open(&output)
            .map_err(|error| format!("同梱ファイルを展開できません: {relative} ({error})"))?;
        reader.copy_entry(size, &mut output_file, &relative)?;
        output_file.sync_all().map_err(|error| format!("同梱ファイルを確定できません: {relative} ({error})"))?;
    }
    if reader.remaining != 0 { return Err("内包データの末尾に未定義の内容があります。".to_owned()); }
    if required.len() != REQUIRED_FILES.len() {
        let missing = REQUIRED_FILES.iter().find(|name| !required.contains(**name)).copied().unwrap_or("unknown");
        return Err(format!("配布に必要な同梱ファイルがありません: {missing}"));
    }
    let actual: [u8; 32] = reader.digest.finalize().into();
    if actual != embedded.sha256 { return Err("内包データのSHA-256が一致しません。展開を中止しました。".to_owned()); }
    Ok(())
}

impl BundleReader {
    fn read_hashed(&mut self, output: &mut [u8]) -> Result<(), String> {
        if output.len() as u64 > self.remaining { return Err("内包データが途中で終わっています。".to_owned()); }
        let length = output.len() as u64;
        self.file.read_exact(output).map_err(|_| "内包データが途中で終わっています。".to_owned())?;
        self.digest.update(&*output);
        self.remaining -= length;
        Ok(())
    }

    fn read_bytes(&mut self, length: usize) -> Result<Vec<u8>, String> {
        if length as u64 > self.remaining { return Err("内包データが途中で終わっています。".to_owned()); }
        let mut result = vec![0_u8; length];
        self.read_hashed(&mut result)?;
        Ok(result)
    }

    fn read_u16(&mut self) -> Result<u16, String> { Ok(u16::from_le_bytes(self.read_bytes(2)?.try_into().unwrap())) }
    fn read_u32(&mut self) -> Result<u32, String> { Ok(u32::from_le_bytes(self.read_bytes(4)?.try_into().unwrap())) }
    fn read_u64(&mut self) -> Result<u64, String> { Ok(u64::from_le_bytes(self.read_bytes(8)?.try_into().unwrap())) }

    fn copy_entry(&mut self, mut length: u64, output: &mut File, name: &str) -> Result<(), String> {
        let mut buffer = [0_u8; 64 * 1024];
        while length > 0 {
            let chunk_len = usize::try_from(length.min(buffer.len() as u64)).unwrap();
            self.read_hashed(&mut buffer[..chunk_len])
                .map_err(|_| format!("同梱ファイルが途中で終わっています: {name}"))?;
            output.write_all(&buffer[..chunk_len]).map_err(|error| format!("同梱ファイルを書き込めません: {name} ({error})"))?;
            length -= chunk_len as u64;
        }
        Ok(())
    }
}

fn bundle_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.starts_with('/') || value.contains('\\') || value.contains(':') || value.contains('\0') {
        return Err("内包パスが相対パスではありません。".to_owned());
    }
    let mut path = PathBuf::new();
    for part in value.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.ends_with('.') || part.ends_with(' ')
            || part.chars().any(|character| character.is_control() || "<>\"|?*".contains(character))
        {
            return Err("内包パスに許可されない要素があります。".to_owned());
        }
        path.push(part);
    }
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err("内包パスに許可されない要素があります。".to_owned());
    }
    Ok(path)
}

fn verify_complete_runtime(root: &Path, payload_hash: &[u8; 32]) -> Result<(), String> {
    // A regular leaf can still be reached through an intermediate junction.
    // Check every imported dependency too, before ACL changes or execution.
    validated_tree_paths(root)?;
    if path_is_reparse(root)? || !fs::symlink_metadata(root).map_err(|error| format!("展開済みランタイムを確認できません: {error}"))?.is_dir() {
        return Err("Portable版の既存ランタイムが安全な通常フォルダではありません。既存データを変更せず停止しました。書き込み可能な通常フォルダへEXEと付随フォルダごと移すか、配置先の安全性を確認してください。".to_owned());
    }
    let receipt_path = root.join(COMPLETE_FILE);
    let receipt_metadata = fs::symlink_metadata(&receipt_path)
        .map_err(|_| "同じ版の展開先に完了記録がありません。既存データを上書きせず停止しました。".to_owned())?;
    if !receipt_metadata.is_file() || path_is_reparse(&receipt_path)? {
        return Err("Portable版の既存ランタイム内に安全でない完了記録があります。既存データを変更せず停止しました。書き込み可能な通常フォルダへEXEと付随フォルダごと移してください。".to_owned());
    }
    let mut receipt = String::new();
    File::open(&receipt_path).and_then(|mut file| file.read_to_string(&mut receipt))
        .map_err(|_| "同じ版の展開先に完了記録を読めません。既存データを上書きせず停止しました。".to_owned())?;
    let expected = format!("KindleToZip {APP_VERSION}\nsha256={}\n", hex(payload_hash));
    if receipt != expected {
        return Err("同じ版の展開先が別内容です。既存ファイルを上書きせず停止しました。".to_owned());
    }
    for name in REQUIRED_FILES {
        let path = root.join(bundle_path(name)?);
        let metadata = fs::symlink_metadata(&path).map_err(|_| format!("展開済みの必須ファイルがありません: {name}"))?;
        if !metadata.is_file() || path_is_reparse(&path)? {
            return Err(format!("展開済みの必須ファイルが安全な通常ファイルではありません: {name}。上書きせず停止しました。書き込み可能な通常フォルダへEXEと付随フォルダごと移してください。"));
        }
    }
    Ok(())
}

fn validated_tree_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut paths = Vec::new();
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(|error| portable_path_error(&path, error))?;
        if path_is_reparse(&path)? || !(metadata.is_dir() || metadata.is_file()) {
            return Err(format!("Portable版の専用領域に安全でない既存パスがあります: {}。リンク先や既存データを変更せず停止しました。書き込み可能な通常フォルダへEXEと付随フォルダごと移し、配置先の安全性を確認してください。", path.display()));
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|error| portable_path_error(&path, error))? {
                pending.push(entry.map_err(|error| portable_path_error(&path, error))?.path());
            }
        }
        paths.push(path);
    }
    Ok(paths)
}

fn ensure_absolute_without_parent(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("保存・展開先は親参照を含まない絶対パスにしてください。".to_owned());
    }
    Ok(())
}

fn ensure_directory_chain(path: &Path) -> Result<(), String> {
    ensure_absolute_without_parent(path)?;
    let ancestors: Vec<_> = path.ancestors().collect();
    for current in ancestors.into_iter().rev() {
        match fs::symlink_metadata(current) {
            Ok(metadata) => {
                if !metadata.is_dir() || path_is_reparse(current)? {
                    return Err(format!("Portable版の保存先に安全でない既存パスがあります: {}。既存ファイルやリンクは変更せず、書き込み可能な通常フォルダへEXEと付随フォルダごと移してください。", current.display()));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(current) {
                    Ok(()) => {},
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        let metadata = fs::symlink_metadata(current)
                            .map_err(|error| portable_path_error(current, error))?;
                        if !metadata.is_dir() || path_is_reparse(current)? {
                            return Err(format!("Portable版の保存先に安全でない既存パスがあります: {}。既存ファイルやリンクは変更せず、書き込み可能な通常フォルダへEXEと付随フォルダごと移してください。", current.display()));
                        }
                    }
                    Err(error) => return Err(portable_path_error(current, error)),
                }
            }
            Err(error) => return Err(portable_path_error(current, error)),
        }
    }
    Ok(())
}

fn portable_path_error(path: &Path, error: io::Error) -> String {
    if matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem)
        || matches!(error.raw_os_error(), Some(5 | 19 | 32 | 33))
    {
        format!("Portable版の保存先へ書き込めません: {}。書き込み可能な通常フォルダへEXEと付随フォルダごと移してから起動してください。利用者プロファイルなどへ保存先を切り替えることはありません。", path.display())
    } else {
        format!("Portable版の保存先を確認できません: {} ({error})。既存データを変更せず、必要なら書き込み可能な通常フォルダへEXEと付随フォルダごと移してください。", path.display())
    }
}

fn ensure_supported_path_lengths(executable: &Path, root: &Path, runtime: &Path) -> Result<(), String> {
    let likely_chromium = runtime.join("artifacts/browsers/chromium-1248/chrome-win64/chrome.exe");
    let likely_temporary_profile = root.join("temp/playwright_chromiumdev_profile-00000000-0000-0000-0000-000000000000");
    let longest = [executable, likely_chromium.as_path(), likely_temporary_profile.as_path()]
        .iter().map(|path| path.to_string_lossy().encode_utf16().count()).max().unwrap_or(0);
    if longest > 240 {
        return Err("Portable版の保存場所がWindowsのパス長上限に近すぎます。ドライブ直下など短く、空白や日本語を含んでもよい書き込み可能な通常フォルダへ、EXEと付随フォルダごと移してください。既存データは変更していません。".to_owned());
    }
    Ok(())
}

fn path_is_reparse(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("パスを確認できません: {} ({error})", path.display()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(metadata.file_attributes() & 0x0000_0400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(metadata.file_type().is_symlink())
    }
}

fn regular_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("必須ファイルを確認できません: {} ({error})", path.display()))?;
    if !metadata.is_file() || path_is_reparse(path)? { return Err(format!("必須ファイルが通常ファイルではありません: {}", path.display())); }
    Ok(path.to_path_buf())
}

fn regular_file_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("Chromiumの同梱先を確認できません: {} ({error})", path.display()))?;
    if !metadata.is_dir() || path_is_reparse(path)? { return Err("Chromiumの同梱先が安全なフォルダではありません。".to_owned()); }
    Ok(path.to_path_buf())
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

#[cfg(all(test, windows))]
mod security_tests;
