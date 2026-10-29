use crate::png_image::{crc32, decode_rendered, decode_stored, is_jpeg, sha256};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use crate::png_image::MAX_PNG_BYTES;

pub struct ArchiveInput<'a> {
    pub name: String,
    pub path: &'a Path,
    pub bytes: u64,
    pub sha256: &'a str,
    pub width: u32,
    pub height: u32,
    pub allow_black: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchiveSummary {
    pub bytes: u64,
    pub sha256: String,
    pub entries: u32,
}

struct CentralEntry {
    name: Vec<u8>,
    crc: u32,
    size: u32,
    local_offset: u32,
}

fn put_u16(writer: &mut impl Write, value: u16) -> Result<(), &'static str> {
    writer.write_all(&value.to_le_bytes()).map_err(|_| "archive_write_failed")
}

fn put_u32(writer: &mut impl Write, value: u32) -> Result<(), &'static str> {
    writer.write_all(&value.to_le_bytes()).map_err(|_| "archive_write_failed")
}

fn get_u16(bytes: &[u8], offset: usize) -> Result<u16, &'static str> {
    let value = bytes.get(offset..offset + 2).ok_or("archive_verify_failed")?;
    Ok(u16::from_le_bytes(value.try_into().unwrap()))
}

fn get_u32(bytes: &[u8], offset: usize) -> Result<u32, &'static str> {
    let value = bytes.get(offset..offset + 4).ok_or("archive_verify_failed")?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

#[cfg(test)]
pub fn write_and_verify(file: &mut File, inputs: &[ArchiveInput<'_>]) -> Result<ArchiveSummary, &'static str> {
    write_and_verify_progress(file, inputs, &mut |_, _, _| {})
}

pub fn write_and_verify_progress(file: &mut File, inputs: &[ArchiveInput<'_>], progress: &mut impl FnMut(usize, usize, &'static str)) -> Result<ArchiveSummary, &'static str> {
    let total = inputs.len() * 2 + 2;
    progress(0, total, "write");
    if inputs.is_empty() || inputs.len() >= u16::MAX as usize {
        return Err("archive_entry_count_unsupported");
    }
    let planned_size = inputs.iter().try_fold(22_u64, |total, input| {
        if input.bytes > MAX_PNG_BYTES as u64 { return None; }
        total.checked_add(30 + input.name.len() as u64 + input.bytes + 46 + input.name.len() as u64)
    }).ok_or("archive_size_unsupported")?;
    if planned_size >= u32::MAX as u64 { return Err("archive_size_unsupported"); }
    let mut central = Vec::with_capacity(inputs.len());
    file.seek(SeekFrom::Start(0)).map_err(|_| "archive_write_failed")?;
    for input in inputs {
        if input.name.is_empty() || input.name.len() > u16::MAX as usize || input.name.contains('/')
            || input.name.contains('\\') || input.name == "." || input.name == ".."
        {
            return Err("archive_entry_invalid");
        }
        let source = read_source(input)?;
        let size = u32::try_from(source.len()).map_err(|_| "archive_size_unsupported")?;
        let local_offset = u32::try_from(file.stream_position().map_err(|_| "archive_write_failed")?)
            .map_err(|_| "archive_size_unsupported")?;
        let name = input.name.as_bytes().to_vec();
        let crc = crc32(&source);

        put_u32(file, 0x0403_4b50)?;
        put_u16(file, 20)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u16(file, 0x0021)?;
        put_u32(file, crc)?;
        put_u32(file, size)?;
        put_u32(file, size)?;
        put_u16(file, name.len() as u16)?;
        put_u16(file, 0)?;
        file.write_all(&name).map_err(|_| "archive_write_failed")?;
        file.write_all(&source).map_err(|_| "archive_write_failed")?;
        central.push(CentralEntry { name, crc, size, local_offset });
        progress(central.len(), total, "write");
    }

    let central_offset = u32::try_from(file.stream_position().map_err(|_| "archive_write_failed")?)
        .map_err(|_| "archive_size_unsupported")?;
    for entry in &central {
        put_u32(file, 0x0201_4b50)?;
        put_u16(file, 20)?;
        put_u16(file, 20)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u16(file, 0x0021)?;
        put_u32(file, entry.crc)?;
        put_u32(file, entry.size)?;
        put_u32(file, entry.size)?;
        put_u16(file, entry.name.len() as u16)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u16(file, 0)?;
        put_u32(file, 0)?;
        put_u32(file, entry.local_offset)?;
        file.write_all(&entry.name).map_err(|_| "archive_write_failed")?;
    }
    let central_size = u32::try_from(file.stream_position().map_err(|_| "archive_write_failed")? - u64::from(central_offset))
        .map_err(|_| "archive_size_unsupported")?;
    if central_offset.checked_add(central_size).and_then(|n| n.checked_add(22)).is_none() {
        return Err("archive_size_unsupported");
    }
    put_u32(file, 0x0605_4b50)?;
    put_u16(file, 0)?;
    put_u16(file, 0)?;
    put_u16(file, central.len() as u16)?;
    put_u16(file, central.len() as u16)?;
    put_u32(file, central_size)?;
    put_u32(file, central_offset)?;
    put_u16(file, 0)?;
    file.flush().map_err(|_| "archive_write_failed")?;
    file.sync_all().map_err(|_| "archive_write_failed")?;

    verify_archive(file, inputs, &central, central_offset, central_size, progress)?;
    let bytes = file.metadata().map_err(|_| "archive_verify_failed")?.len();
    let digest = digest_file(file)?;
    progress(inputs.len() * 2 + 1, total, "publish");
    Ok(ArchiveSummary { bytes, sha256: digest, entries: inputs.len() as u32 })
}

fn verify_archive(
    file: &mut File,
    inputs: &[ArchiveInput<'_>],
    central: &[CentralEntry],
    central_offset: u32,
    central_size: u32,
    progress: &mut impl FnMut(usize, usize, &'static str),
) -> Result<(), &'static str> {
    let file_len = file.metadata().map_err(|_| "archive_verify_failed")?.len();
    let expected_end = u64::from(central_offset) + u64::from(central_size) + 22;
    if file_len != expected_end {
        return Err("archive_verify_failed");
    }
    for (index, (input, entry)) in inputs.iter().zip(central).enumerate() {
        file.seek(SeekFrom::Start(u64::from(entry.local_offset))).map_err(|_| "archive_verify_failed")?;
        let mut header = [0_u8; 30];
        file.read_exact(&mut header).map_err(|_| "archive_verify_failed")?;
        if get_u32(&header, 0)? != 0x0403_4b50 || get_u16(&header, 6)? != 0 || get_u16(&header, 8)? != 0
            || get_u32(&header, 14)? != entry.crc || get_u32(&header, 18)? != entry.size
            || get_u32(&header, 22)? != entry.size || get_u16(&header, 26)? as usize != entry.name.len()
            || get_u16(&header, 28)? != 0
        {
            return Err("archive_verify_failed");
        }
        let mut name = vec![0; entry.name.len()];
        file.read_exact(&mut name).map_err(|_| "archive_verify_failed")?;
        if name != entry.name {
            return Err("archive_verify_failed");
        }
        let mut data = vec![0; entry.size as usize];
        file.read_exact(&mut data).map_err(|_| "archive_verify_failed")?;
        if crc32(&data) != entry.crc || sha256(&data) != input.sha256 || is_jpeg(&data) != input.name.ends_with(".jpg") {
            return Err("archive_verify_failed");
        }
        let image = if input.allow_black { decode_rendered(&data) } else { decode_stored(&data) }
            .map_err(|_| "archive_verify_failed")?;
        if image.width != input.width || image.height != input.height {
            return Err("archive_verify_failed");
        }
        progress(inputs.len() + index + 1, inputs.len() * 2 + 2, "verify");
    }

    file.seek(SeekFrom::Start(u64::from(central_offset))).map_err(|_| "archive_verify_failed")?;
    for entry in central {
        let mut header = [0_u8; 46];
        file.read_exact(&mut header).map_err(|_| "archive_verify_failed")?;
        if get_u32(&header, 0)? != 0x0201_4b50 || get_u16(&header, 8)? != 0 || get_u16(&header, 10)? != 0
            || get_u32(&header, 16)? != entry.crc || get_u32(&header, 20)? != entry.size
            || get_u32(&header, 24)? != entry.size || get_u16(&header, 28)? as usize != entry.name.len()
            || get_u16(&header, 30)? != 0 || get_u16(&header, 32)? != 0 || get_u32(&header, 42)? != entry.local_offset
        {
            return Err("archive_verify_failed");
        }
        let mut name = vec![0; entry.name.len()];
        file.read_exact(&mut name).map_err(|_| "archive_verify_failed")?;
        if name != entry.name {
            return Err("archive_verify_failed");
        }
    }
    if file.stream_position().map_err(|_| "archive_verify_failed")? != u64::from(central_offset) + u64::from(central_size) {
        return Err("archive_verify_failed");
    }
    let mut eocd = [0_u8; 22];
    file.read_exact(&mut eocd).map_err(|_| "archive_verify_failed")?;
    if get_u32(&eocd, 0)? != 0x0605_4b50 || get_u16(&eocd, 4)? != 0 || get_u16(&eocd, 6)? != 0
        || get_u16(&eocd, 8)? as usize != inputs.len() || get_u16(&eocd, 10)? as usize != inputs.len()
        || get_u32(&eocd, 12)? != central_size || get_u32(&eocd, 16)? != central_offset || get_u16(&eocd, 20)? != 0
    {
        return Err("archive_verify_failed");
    }
    Ok(())
}

fn read_source(input: &ArchiveInput<'_>) -> Result<Vec<u8>, &'static str> {
    if input.bytes == 0 || input.bytes > MAX_PNG_BYTES as u64 {
        return Err("archive_source_invalid");
    }
    let source = open_source(input.path)?;
    if source.metadata().map_err(|_| "archive_source_invalid")?.len() != input.bytes {
        return Err("archive_source_invalid");
    }
    let mut bytes = Vec::with_capacity(input.bytes as usize);
    source.take(input.bytes + 1).read_to_end(&mut bytes).map_err(|_| "archive_source_invalid")?;
    if bytes.len() as u64 != input.bytes {
        return Err("archive_source_invalid");
    }
    let image = if input.allow_black { decode_rendered(&bytes) } else { decode_stored(&bytes) }
        .map_err(|_| "archive_source_invalid")?;
    if is_jpeg(&bytes) != input.name.ends_with(".jpg") || image.sha256 != input.sha256 || image.width != input.width || image.height != input.height {
        return Err("archive_source_invalid");
    }
    Ok(bytes)
}

#[cfg(windows)]
fn open_source(path: &Path) -> Result<File, &'static str> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let file = std::fs::OpenOptions::new().read(true).custom_flags(OPEN_REPARSE_POINT)
        .open(path).map_err(|_| "archive_source_invalid")?;
    let metadata = file.metadata().map_err(|_| "archive_source_invalid")?;
    if !metadata.is_file() || metadata.file_attributes() & 0x0000_0400 != 0 {
        return Err("archive_source_invalid");
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_source(path: &Path) -> Result<File, &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "archive_source_invalid")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("archive_source_invalid"); }
    File::open(path).map_err(|_| "archive_source_invalid")
}

fn digest_file(file: &mut File) -> Result<String, &'static str> {
    file.seek(SeekFrom::Start(0)).map_err(|_| "archive_verify_failed")?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "archive_verify_failed")?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| "archive_verify_failed")?;
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use png::{BitDepth, ColorType, Encoder};
    use std::io::Seek;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn image() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[100; 12]).unwrap();
        }
        bytes
    }

    #[test]
    fn stored_zip_roundtrips_png_hash_crc_and_order() {
        let bytes = image();
        let digest = sha256(&bytes);
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/mvp-tests/rust-archive");
        std::fs::create_dir_all(&base).unwrap();
        let base = std::fs::canonicalize(base).unwrap();
        let directory = (0..32).find_map(|_| {
            let candidate = base.join(format!("{}-{}", std::process::id(), TEST_COUNTER.fetch_add(1, Ordering::Relaxed)));
            match std::fs::create_dir(&candidate) {
                Ok(()) => Some(candidate),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => panic!("failed to create archive test directory: {error}"),
            }
        }).expect("could not allocate unique archive test directory");
        let source = directory.join("source.png");
        std::fs::write(&source, &bytes).unwrap();
        let input = ArchiveInput { name: "000001.png".to_string(), path: &source, bytes: bytes.len() as u64, sha256: &digest, width: 2, height: 2, allow_black: false };
        let temp = directory.join("output.zip");
        let mut file = File::options().read(true).write(true).create_new(true).open(&temp).unwrap();
        let summary = write_and_verify(&mut file, &[input]).unwrap();
        assert_eq!(summary.entries, 1);
        assert_eq!(summary.bytes, file.metadata().unwrap().len());
        assert!(file.seek(SeekFrom::Start(0)).is_ok());
        drop(file);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
