use png::{BitDepth, ColorType, Decoder, Encoder, Transformations};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;

pub const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 16_000_000;

#[derive(Clone, Debug)]
pub struct DecodedPng {
    pub width: u32,
    pub height: u32,
    pub color_type: ColorType,
    pub bit_depth: BitDepth,
    pub pixels: Vec<u8>,
    pub sha256: String,
    pub black_candidate: bool,
    pub blank_candidate: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CropRect { pub x: u32, pub y: u32, pub width: u32, pub height: u32 }

impl DecodedPng {
    // Unlike the layout heuristic, every pixel of every discarded edge line
    // must match an opaque, nearly black or white edge. Never skip decorations.
    // Keep a safety band around the first non-matching pixel; this is geometry,
    // not recognition of text, frames, or page numbers.
    pub fn margin_crop(&self) -> Option<CropRect> {
        let channels = match self.color_type { ColorType::Grayscale => 1, ColorType::GrayscaleAlpha => 2, ColorType::Rgb => 3, ColorType::Rgba => 4, ColorType::Indexed => return None };
        let bytes = if self.bit_depth == BitDepth::Sixteen { 2 } else { 1 };
        let max = if bytes == 2 { 65535_u32 } else { 255 };
        let tolerance = 8 * (max / 255);
        let colors = if channels <= 2 { 1 } else { 3 };
        let alpha = match self.color_type { ColorType::GrayscaleAlpha => Some(1), ColorType::Rgba => Some(3), _ => None };
        let sample = |x: u32, y: u32, c: usize| -> u32 {
            let index = ((y * self.width + x) as usize * channels + c) * bytes;
            if bytes == 2 { u32::from(u16::from_be_bytes([self.pixels[index], self.pixels[index + 1]])) } else { u32::from(self.pixels[index]) }
        };
        let edge_run = |horizontal: bool, reverse: bool| -> u32 {
            let length = if horizontal { self.height } else { self.width };
            let across = if horizontal { self.width } else { self.height };
            let point = |line: u32, along: u32| {
                let line = if reverse { length - 1 - line } else { line };
                if horizontal { (along, line) } else { (line, along) }
            };
            let (x, y) = point(0, 0);
            let reference = sample(x, y, 0);
            if reference > tolerance && reference < max - tolerance { return 0; }
            let matches = |x, y| alpha.map(|c| sample(x, y, c) == max).unwrap_or(true)
                && (0..colors).all(|c| sample(x, y, c).abs_diff(reference) <= tolerance
                    && if reference <= tolerance { sample(x, y, c) <= tolerance } else { sample(x, y, c) >= max - tolerance });
            (0..length).take_while(|line| (0..across).all(|along| {
                let (x, y) = point(*line, along); matches(x, y)
            })).count() as u32
        };
        let (left, right, top, bottom) = (edge_run(false, false), edge_run(false, true), edge_run(true, false), edge_run(true, true));
        // A completely uniform image gives no evidence of content.
        if left + right >= self.width || top + bottom >= self.height { return None; }
        let trim = |run: u32, size: u32| if run >= (size / 50).max(3) { run.saturating_sub((size / 50).max(2)) } else { 0 };
        let (left, right, top, bottom) = (trim(left, self.width), trim(right, self.width), trim(top, self.height), trim(bottom, self.height));
        if left + right + top + bottom == 0 { return None; }
        Some(CropRect { x: left, y: top, width: self.width - left - right, height: self.height - top - bottom })
    }

    // Compare the active width AND height after uniform neutral display margins.
    // A smaller two-page view can have top/bottom margins even in a portrait
    // viewport. This is independent of capture number and reader position.
    // This is geometric evidence, not semantic recognition of spread artwork.
    pub fn single_page(&self) -> bool {
        self.single_page_with_asymmetric_band(true)
    }

    pub(crate) fn legacy_single_page(&self) -> bool {
        self.single_page_with_asymmetric_band(false)
    }

    fn single_page_with_asymmetric_band(&self, allow_asymmetric_band: bool) -> bool {
        let channels = match self.color_type { ColorType::Grayscale => 1, ColorType::GrayscaleAlpha => 2, ColorType::Rgb => 3, _ => 4 };
        let bytes = if self.bit_depth == BitDepth::Sixteen { 2 } else { 1 };
        let colors = if channels <= 2 { 1 } else { 3 };
        // For 16-bit PNGs the high byte gives the same 8-bit color tolerance.
        let sample = |x: u32, y: u32, c: usize| {
            self.pixels[((y * self.width + x) as usize * channels + c) * bytes]
        };
        let background: Vec<_> = (0..colors).map(|c| sample(0, self.height / 50, c)).collect();
        let neutral = background.iter().max().unwrap() - background.iter().min().unwrap() <= 12;
        if !neutral { return self.width < self.height; }
        let matches_background = |x: u32, y: u32| {
            (0..colors).all(|c| sample(x, y, c).abs_diff(background[c]) <= 12)
        };
        // A cover can occupy only one side of a landscape reader, with
        // toolbars at the top/bottom and a navigation button at the outer edge.
        // Consider only a continuous, dark neutral band through the middle of
        // the display. This selects an output layout, never discards pixels;
        // the user can correct an ambiguous classification during review.
        if allow_asymmetric_band && self.width >= self.height && self.width >= 40 && self.height >= 40 {
            let y0 = self.height / 5;
            let y1 = self.height - y0;
            let edge = self.width / 10;
            let band = |from_left: bool| {
                let outer = if from_left { edge } else { self.width - 1 - edge };
                let color: Vec<_> = (0..colors).map(|c| sample(outer, self.height / 2 - self.height / 4, c)).collect();
                if *color.iter().max().unwrap() > 48 || color.iter().max().unwrap() - color.iter().min().unwrap() > 12 { return 0; }
                let neutral_column = |x| (y0..y1).all(|y| (0..colors).all(|c| sample(x, y, c).abs_diff(color[c]) <= 12));
                let run = (edge..self.width - edge).map(|x| if from_left { x } else { self.width - 1 - x })
                    .take_while(|x| neutral_column(*x)).count() as u32;
                if run > 0 { edge + run } else { 0 }
            };
            let left = band(true);
            let right = band(false);
            if left.max(right) >= self.width / 4 && left.min(right) < self.width / 10
                && self.width - left.max(right) < self.height * 3 / 4 {
                return true;
            }
        }
        // Ignore at most the outer 2% when probing an edge, so a subpixel clip
        // border cannot hide real margins. The saved image is never trimmed.
        let inset_y = self.height / 50;
        let margin_column = |x| (inset_y..self.height - inset_y).all(|y| matches_background(x, y));
        // A narrow edge navigation glyph is not book content. Probe from 5%
        // inward, but still require a continuous, symmetric neutral gutter of
        // at least 10% on BOTH sides. Never crop or remove those edge pixels.
        let edge = self.width / 20;
        let left_run = (edge..self.width).take_while(|x| margin_column(*x)).count() as u32;
        let right_run = (edge..self.width).map(|x| self.width - 1 - x).take_while(|x| margin_column(*x)).count() as u32;
        let left = if left_run > 0 { edge + left_run } else { 0 };
        let right = if right_run > 0 { edge + right_run } else { 0 };
        let side_margins = left >= (self.width / 10).max(1) && right >= (self.width / 10).max(1)
            && left.abs_diff(right) <= self.width / 20 && left + right < self.width;
        let inset_x = self.width / 50;
        let margin_row = |y| (inset_x..self.width - inset_x).all(|x| matches_background(x, y));
        let leading = (inset_y..self.height - inset_y).take_while(|y| margin_row(*y)).count() as u32;
        let trailing = (inset_y..self.height - inset_y).rev().take_while(|y| margin_row(*y)).count() as u32;
        let top = if leading > 0 { inset_y + leading } else { 0 };
        let bottom = if trailing > 0 { inset_y + trailing } else { 0 };
        let end_margins = (top >= (self.height / 10).max(1) || bottom >= (self.height / 10).max(1))
            && top + bottom < self.height;
        let active_width = if side_margins { self.width - left - right } else { self.width };
        let active_height = if end_margins { self.height - top - bottom } else { self.height };
        active_width < active_height
    }
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn is_jpeg(bytes: &[u8]) -> bool { bytes.starts_with(&[0xff, 0xd8]) }

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn validate_chunk_stream(bytes: &[u8]) -> Result<(), &'static str> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 8 || &bytes[..8] != SIGNATURE {
        return Err("invalid_png");
    }
    let mut offset = 8_usize;
    let mut first = true;
    let mut saw_data = false;
    let mut saw_end = false;
    let mut chunk_count = 0_u32;
    while offset < bytes.len() {
        if bytes.len() - offset < 12 {
            return Err("invalid_png");
        }
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let chunk_end = offset.checked_add(12).and_then(|n| n.checked_add(length)).ok_or("invalid_png")?;
        if chunk_end > bytes.len() {
            return Err("invalid_png");
        }
        let kind = &bytes[offset + 4..offset + 8];
        let data_end = offset + 8 + length;
        let expected = u32::from_be_bytes(bytes[data_end..data_end + 4].try_into().unwrap());
        if crc32(&bytes[offset + 4..data_end]) != expected {
            return Err("invalid_png");
        }
        if first {
            if kind != b"IHDR" || length != 13 {
                return Err("invalid_png");
            }
            first = false;
        } else if kind == b"IHDR" {
            return Err("invalid_png");
        }
        if kind == b"IDAT" {
            if saw_end {
                return Err("invalid_png");
            }
            saw_data = true;
        }
        if kind == b"IEND" {
            if length != 0 || !saw_data || saw_end || chunk_end != bytes.len() {
                return Err("invalid_png");
            }
            saw_end = true;
        } else if saw_end {
            return Err("invalid_png");
        }
        offset = chunk_end;
        chunk_count += 1;
        if chunk_count > 100_000 {
            return Err("invalid_png");
        }
    }
    if first || !saw_data || !saw_end || offset != bytes.len() {
        return Err("invalid_png");
    }
    Ok(())
}

pub fn decode(bytes: &[u8]) -> Result<DecodedPng, &'static str> {
    let decoded = decode_rendered(bytes)?;
    if decoded.black_candidate { return Err("black_image"); }
    Ok(decoded)
}

pub fn decode_rendered(bytes: &[u8]) -> Result<DecodedPng, &'static str> {
    decode_pixels(bytes, 995)
}

// A confirmed original keeps the pre-existing storage contract. Tightening
// capture safety must not retroactively invalidate a hash-verified old page.
pub(crate) fn decode_stored(bytes: &[u8]) -> Result<DecodedPng, &'static str> {
    let decoded = decode_pixels(bytes, 999)?;
    if decoded.black_candidate { return Err("black_image"); }
    Ok(decoded)
}

fn decode_pixels(bytes: &[u8], black_per_thousand: u64) -> Result<DecodedPng, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_PNG_BYTES {
        return Err(if bytes.len() > MAX_PNG_BYTES { "png_too_large" } else { "invalid_png" });
    }
    if is_jpeg(bytes) {
        if !bytes.ends_with(&[0xff, 0xd9]) { return Err("invalid_jpeg"); }
        let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
        decoder.set_max_decoding_buffer_size(MAX_PNG_BYTES * 4);
        decoder.read_info().map_err(|_| "invalid_jpeg")?;
        let info = decoder.info().ok_or("invalid_jpeg")?;
        let width = u32::from(info.width); let height = u32::from(info.height);
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS { return Err("invalid_dimensions"); }
        let color = match info.pixel_format {
            jpeg_decoder::PixelFormat::L8 => ColorType::Grayscale,
            jpeg_decoder::PixelFormat::RGB24 => ColorType::Rgb,
            _ => return Err("invalid_jpeg"),
        };
        let pixels = decoder.decode().map_err(|_| "invalid_jpeg")?;
        return build_decoded(width, height, color, BitDepth::Eight, pixels, bytes, black_per_thousand);
    }
    validate_chunk_stream(bytes)?;
    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(|_| "invalid_png")?;
    let width = reader.info().width;
    let height = reader.info().height;
    if width == 0 || height == 0 || u64::from(width).checked_mul(u64::from(height)).ok_or("invalid_dimensions")? > MAX_PIXELS {
        return Err("invalid_dimensions");
    }
    let output_capacity = reader.output_buffer_size();
    if output_capacity > MAX_PNG_BYTES.checked_mul(16).ok_or("invalid_dimensions")? {
        return Err("invalid_dimensions");
    }
    let mut pixels = vec![0; output_capacity];
    let info = reader.next_frame(&mut pixels).map_err(|_| "invalid_png")?;
    let pixel_size = info.buffer_size();
    pixels.truncate(pixel_size);
    build_decoded(width, height, info.color_type, info.bit_depth, pixels, bytes, black_per_thousand)
}

fn build_decoded(width: u32, height: u32, color_type: ColorType, bit_depth: BitDepth, pixels: Vec<u8>, bytes: &[u8], black_per_thousand: u64) -> Result<DecodedPng, &'static str> {
    let channels = match color_type {
        ColorType::Grayscale => 1_usize,
        ColorType::Rgb => 3,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgba => 4,
        ColorType::Indexed => return Err("invalid_png"),
    };
    let sample_bytes = match bit_depth {
        BitDepth::Eight => 1_usize,
        BitDepth::Sixteen => 2,
        _ => return Err("invalid_png"),
    };
    let stride = channels.checked_mul(sample_bytes).ok_or("invalid_dimensions")?;
    let expected = (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(stride)).ok_or("invalid_dimensions")?;
    if pixels.len() != expected {
        return Err("invalid_png");
    }

    let max_sample = if sample_bytes == 1 { 255_u32 } else { 65_535_u32 };
    let dark_limit = if sample_bytes == 1 { 3_u32 } else { 771_u32 };
    let white_limit = max_sample - if sample_bytes == 1 { 4 } else { 1028 };
    let alpha_index = match color_type {
        ColorType::GrayscaleAlpha => Some(1),
        ColorType::Rgba => Some(3),
        _ => None,
    };
    let visible_threshold = max_sample / 100;
    let mut opaque_pixels = 0_u64;
    let mut very_dark = 0_u64;
    let mut near_white = 0_u64;
    for pixel in pixels.chunks_exact(stride) {
        let sample = |index: usize| -> u32 {
            let offset = index * sample_bytes;
            if sample_bytes == 1 {
                u32::from(pixel[offset])
            } else {
                u32::from(u16::from_be_bytes([pixel[offset], pixel[offset + 1]]))
            }
        };
        let alpha = alpha_index.map(sample).unwrap_or(max_sample);
        if alpha <= visible_threshold {
            continue;
        }
        opaque_pixels += 1;
        let (red, green, blue) = match color_type {
            ColorType::Grayscale | ColorType::GrayscaleAlpha => {
                let gray = sample(0);
                (gray, gray, gray)
            }
            ColorType::Rgb | ColorType::Rgba => (sample(0), sample(1), sample(2)),
            ColorType::Indexed => unreachable!(),
        };
        if red <= dark_limit && green <= dark_limit && blue <= dark_limit {
            very_dark += 1;
        }
        if red >= white_limit && green >= white_limit && blue >= white_limit {
            near_white += 1;
        }
    }
    if opaque_pixels == 0 {
        return Err("empty_png");
    }
    // New captures allow a thin clip border at 99.5%; stored originals retain
    // the former 99.9% policy, independently of the current capture heuristic.
    let black_candidate = very_dark.saturating_mul(1000) >= opaque_pixels.saturating_mul(black_per_thousand);
    let blank_candidate = near_white.saturating_mul(1000) >= opaque_pixels.saturating_mul(999);
    Ok(DecodedPng {
        width,
        height,
        color_type,
        bit_depth,
        pixels,
        sha256: sha256(bytes),
        black_candidate,
        blank_candidate,
    })
}

pub fn crop(bytes: &[u8], x: u32, y: u32, width: u32, height: u32) -> Result<Vec<u8>, &'static str> {
    let decoded = decode_stored(bytes)?;
    crop_decoded(&decoded, x, y, width, height, None)
}

// Derived pages may be deliberately black after a user-selected crop. Raw
// screenshots still enter through decode() before becoming originals.
pub(crate) fn crop_same_format(bytes: &[u8], x: u32, y: u32, width: u32, height: u32, quality: u8) -> Result<Vec<u8>, &'static str> {
    let decoded = decode_rendered(bytes)?;
    crop_decoded(&decoded, x, y, width, height, is_jpeg(bytes).then_some(quality))
}

fn crop_decoded(decoded: &DecodedPng, x: u32, y: u32, width: u32, height: u32, jpeg_quality: Option<u8>) -> Result<Vec<u8>, &'static str> {
    if width == 0 || height == 0 || x.checked_add(width).filter(|right| *right <= decoded.width).is_none()
        || y.checked_add(height).filter(|bottom| *bottom <= decoded.height).is_none()
    {
        return Err("invalid_crop");
    }
    let channels = match decoded.color_type {
        ColorType::Grayscale => 1_usize,
        ColorType::Rgb => 3,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgba => 4,
        ColorType::Indexed => return Err("invalid_png"),
    };
    let bytes_per_sample = match decoded.bit_depth {
        BitDepth::Eight => 1_usize,
        BitDepth::Sixteen => 2,
        _ => return Err("invalid_png"),
    };
    let pixel_stride = channels * bytes_per_sample;
    let source_stride = decoded.width as usize * pixel_stride;
    let crop_stride = width as usize * pixel_stride;
    let output_len = crop_stride.checked_mul(height as usize).ok_or("invalid_crop")?;
    let mut cropped = Vec::with_capacity(output_len);
    for row in y..y + height {
        let start = row as usize * source_stride + x as usize * pixel_stride;
        cropped.extend_from_slice(&decoded.pixels[start..start + crop_stride]);
    }
    let mut output = Vec::new();
    if let Some(quality) = jpeg_quality {
        let color = match decoded.color_type {
            ColorType::Grayscale => jpeg_encoder::ColorType::Luma,
            ColorType::Rgb => jpeg_encoder::ColorType::Rgb,
            _ => return Err("invalid_jpeg"),
        };
        jpeg_encoder::Encoder::new(&mut output, quality).encode(&cropped, width.try_into().map_err(|_| "invalid_dimensions")?, height.try_into().map_err(|_| "invalid_dimensions")?, color)
            .map_err(|_| "crop_encode_failed")?;
    } else {
        let mut encoder = Encoder::new(&mut output, width, height);
        encoder.set_color(decoded.color_type);
        encoder.set_depth(decoded.bit_depth);
        let mut writer = encoder.write_header().map_err(|_| "crop_encode_failed")?;
        writer.write_image_data(&cropped).map_err(|_| "crop_encode_failed")?;
    }
    let verified = decode_rendered(&output).map_err(|_| "crop_verify_failed")?;
    if verified.width != width || verified.height != height {
        return Err("crop_verify_failed");
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_png(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, width, height);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let pixels = (0..width * height).flat_map(|_| color).collect::<Vec<_>>();
            writer.write_image_data(&pixels).unwrap();
        }
        bytes
    }

    #[test]
    fn validates_hash_dimensions_blank_and_black_without_removing_white_images() {
        let white = decode(&make_png(2, 3, [255, 255, 255])).unwrap();
        assert_eq!((white.width, white.height), (2, 3));
        assert!(white.blank_candidate);
        assert_eq!(white.sha256.len(), 64);
        assert_eq!(decode(&make_png(1, 1, [0, 0, 0])).unwrap_err(), "black_image");
        assert!(white.single_page());
        for margin in [0, 32, 128, 255] {
            let mut page = decode(&make_png(100, 80, [100, 80, 60])).unwrap();
            assert!(!page.single_page(), "two-page-sized active area is not portrait");
            for y in 0..80_usize {
                for x in (0..30).chain(70..100) {
                    page.pixels[(y * 100 + x) * 3..(y * 100 + x + 1) * 3].fill(margin);
                }
            }
            assert!(page.single_page(), "center portrait with uniform margins");
        }
    }

    #[test]
    fn page_layout_compares_both_active_dimensions_in_landscape_and_portrait_viewports() {
        for (width, height, left, top) in [(100, 80, 20, 20), (80, 100, 10, 30)] {
            let mut page = decode(&make_png(width, height, [32, 32, 32])).unwrap();
            // Two 30x40 pages form a landscape 60x40 active area. Neither the
            // outer viewport's shape nor its blank vertical space is a page.
            for y in top..top + 40 {
                for x in left..left + 60 {
                    let color = if x < left + 30 { [199, 91, 56] } else { [50, 100, 171] };
                    let offset = ((y * width + x) * 3) as usize;
                    page.pixels[offset..offset + 3].copy_from_slice(&color);
                }
            }
            assert!(!page.single_page(), "letterboxed two-page content must still split");
        }
    }

    #[test]
    fn centered_page_with_edge_navigation_matches_observed_2200_by_1700_geometry() {
        for margin in [0, 32, 255] {
            let mut page = decode_rendered(&make_png(2200, 1700, [margin; 3])).unwrap();
            // Fictional pixels only: center content plus the observed narrow
            // left navigation decoration, separated by a large neutral gutter.
            for y in 0..1700_usize { for x in 512..1688_usize {
                page.pixels[(y * 2200 + x) * 3..(y * 2200 + x) * 3 + 3].copy_from_slice(&[199, 91, 56]);
            }}
            for y in 777..927_usize { for x in 0..72_usize {
                page.pixels[(y * 2200 + x) * 3..(y * 2200 + x) * 3 + 3].copy_from_slice(&[120, 120, 120]);
            }}
            assert!(page.single_page());
        }
    }

    #[test]
    fn black_capture_with_a_thin_browser_clip_border_stops_before_commit() {
        let (width, height) = (1200_u32, 960_u32);
        let mut pixels = vec![0_u8; (width * height * 3) as usize];
        for pixel in pixels[..(width * 3) as usize].chunks_exact_mut(3) {
            pixel.copy_from_slice(&[85, 85, 85]);
        }
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, width, height);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
        }
        assert_eq!(decode(&bytes).unwrap_err(), "black_image");
    }

    #[test]
    fn crop_is_non_destructive_and_revalidates_dimensions() {
        let original = make_png(3, 2, [30, 40, 50]);
        let cropped = crop(&original, 1, 0, 2, 2).unwrap();
        assert_eq!((decode(&original).unwrap().width, decode(&original).unwrap().height), (3, 2));
        assert_eq!((decode(&cropped).unwrap().width, decode(&cropped).unwrap().height), (2, 2));
        assert_eq!(crop(&original, 2, 0, 2, 1).unwrap_err(), "invalid_crop");
    }

    #[test]
    fn margin_crop_requires_complete_opaque_extreme_edges_and_keeps_isolated_content() {
        for background in [0_u8, 255] {
            let mut image = decode_rendered(&make_png(100, 100, [background; 3])).unwrap();
            let paint = |image: &mut DecodedPng, x: usize, y: usize, color: [u8; 3]| {
                let i = (y * 100 + x) * 3; image.pixels[i..i + 3].copy_from_slice(&color);
            };
            for y in 20..80 { for x in 20..80 { paint(&mut image, x, y, [90, 130, 170]); } }
            assert_eq!(image.margin_crop(), Some(CropRect { x: 18, y: 18, width: 64, height: 64 }));
            let ink = if background == 0 { [255; 3] } else { [0; 3] };
            paint(&mut image, 3, 50, ink); // thin frame or near-edge text
            paint(&mut image, 50, 96, ink); // isolated page number
            let rect = image.margin_crop().unwrap();
            assert!(rect.x <= 3 && rect.y + rect.height > 96);
        }
        for background in [[255, 255, 255], [0, 0, 0], [128, 128, 128], [255, 230, 220]] {
            let image = decode_rendered(&make_png(40, 40, background)).unwrap();
            assert_eq!(image.margin_crop(), None);
        }
        // Decoder pixels use big-endian 16-bit samples; an almost opaque edge
        // is not identical to an opaque edge and must never be discarded.
        let mut image = decode_rendered(&make_png(100, 100, [255; 3])).unwrap();
        image.color_type = ColorType::Rgba; image.bit_depth = BitDepth::Sixteen;
        image.pixels = vec![255; 100 * 100 * 8];
        for y in 20..80 { for x in 20..80 {
            let i = (y * 100 + x) * 8; image.pixels[i..i + 6].fill(80);
        } }
        assert_eq!(image.margin_crop().unwrap().x, 18);
        image.pixels[6] = 255; image.pixels[7] = 254;
        let guarded = image.margin_crop().unwrap();
        assert_eq!((guarded.x, guarded.y), (0, 0));
    }

    #[test]
    fn a_user_selected_black_crop_is_validated_without_rejecting_the_original() {
        let mut bytes = Vec::new();
        {
            let mut encoder = Encoder::new(&mut bytes, 2, 1);
            encoder.set_color(ColorType::Rgb);
            encoder.set_depth(BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0, 0, 0, 80, 90, 100]).unwrap();
        }
        assert!(decode(&bytes).is_ok());
        let crop = crop(&bytes, 0, 0, 1, 1).unwrap();
        assert!(decode_rendered(&crop).unwrap().black_candidate);
    }

    #[test]
    fn rejects_crc_damage_and_trailing_data() {
        let mut bytes = make_png(1, 1, [1, 2, 3]);
        bytes[29] ^= 0x01;
        assert_eq!(decode(&bytes).unwrap_err(), "invalid_png");
        let mut bytes = make_png(1, 1, [1, 2, 3]);
        bytes.push(0);
        assert_eq!(decode(&bytes).unwrap_err(), "invalid_png");
    }

    #[test]
    fn jpeg_is_decoded_bounded_cropped_and_corruption_is_rejected() {
        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, 65).encode(&[80, 140, 180, 190, 70, 30, 100, 80, 200, 160, 140, 90], 2, 2, jpeg_encoder::ColorType::Rgb).unwrap();
        let decoded = decode(&jpeg).unwrap();
        assert_eq!((decoded.width, decoded.height, decoded.sha256), (2, 2, sha256(&jpeg)));
        let cropped = crop_same_format(&jpeg, 1, 0, 1, 2, 65).unwrap();
        assert!(is_jpeg(&cropped));
        let decoded_crop = decode_rendered(&cropped).unwrap();
        assert_eq!((decoded_crop.width, decoded_crop.height), (1, 2));
        let mut truncated = jpeg.clone(); truncated.truncate(truncated.len() - 2);
        assert_eq!(decode(&truncated).unwrap_err(), "invalid_jpeg");
        let mut trailing = jpeg; trailing.push(0);
        assert_eq!(decode(&trailing).unwrap_err(), "invalid_jpeg");
    }
}
