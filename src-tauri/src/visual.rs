//! Pixel work on the canvas's own snapshots: the visual regression gate
//! (FR-5.6 #3) and the visual similarity signal (FR-5.2).
//!
//! Both read PNGs produced by `thumbs::snapshot_png` — the WKWebView
//! self-snapshot — and both are pure functions over those bytes, so the
//! comparison logic is testable without a screen. The capture half is the
//! only part that needs a live window.
//!
//! Two different questions, two different answers:
//!
//! * **Regression** asks "did this pixel change?" and must be strict, because
//!   its job is to catch a merge that quietly moved something. It compares
//!   full resolution with a small per-channel tolerance for compositing noise.
//! * **Similarity** asks "do these look like the same component?" and must be
//!   forgiving of size, position and colour detail, because two duplicates
//!   are near-identical, not identical. That's a perceptual hash.

use serde::Serialize;

/// Decoded 8-bit RGBA image.
pub struct Image {
    pub width: u32,
    pub height: u32,
    /// RGBA, row-major, 4 bytes per pixel.
    pub pixels: Vec<u8>,
}

pub fn decode_png(bytes: &[u8]) -> Result<Image, String> {
    let decoder = png::Decoder::new(bytes);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("snapshot is not a readable PNG: {e}"))?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("snapshot decode failed: {e}"))?;
    buf.truncate(info.buffer_size());

    let channels = info.color_type.samples();
    let depth = info.bit_depth as usize;
    if depth != 8 {
        return Err(format!("unsupported snapshot bit depth: {depth}"));
    }
    let pixel_count = (info.width as usize) * (info.height as usize);
    let mut pixels = vec![255u8; pixel_count * 4];
    for i in 0..pixel_count {
        let src = i * channels;
        let dst = i * 4;
        match channels {
            1 => {
                let v = buf[src];
                pixels[dst] = v;
                pixels[dst + 1] = v;
                pixels[dst + 2] = v;
            }
            2 => {
                let v = buf[src];
                pixels[dst] = v;
                pixels[dst + 1] = v;
                pixels[dst + 2] = v;
                pixels[dst + 3] = buf[src + 1];
            }
            3 => {
                pixels[dst..dst + 3].copy_from_slice(&buf[src..src + 3]);
            }
            4 => {
                pixels[dst..dst + 4].copy_from_slice(&buf[src..src + 4]);
            }
            other => return Err(format!("unsupported channel count: {other}")),
        }
    }
    Ok(Image {
        width: info.width,
        height: info.height,
        pixels,
    })
}

/// Per-channel slack for antialiasing and compositing jitter between two
/// snapshots of the *same* pixels. Above this, something really changed.
const CHANNEL_TOLERANCE: i32 = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    /// Fraction of compared pixels that differ, 0.0–1.0.
    pub ratio: f64,
    pub changed_pixels: u64,
    pub total_pixels: u64,
    pub width: u32,
    pub height: u32,
    /// True when the two captures aren't even the same size — a layout shift
    /// is itself the regression, and is reported rather than resized away.
    pub size_changed: bool,
}

/// Compare two snapshots. Differing dimensions are not an error: the shared
/// region is compared pixel-by-pixel and every pixel outside it counts as
/// changed, so a merge that resized something can never diff as clean.
pub fn compare(before: &Image, after: &Image) -> DiffResult {
    let w = before.width.min(after.width);
    let h = before.height.min(after.height);
    let union_w = before.width.max(after.width);
    let union_h = before.height.max(after.height);

    let mut changed: u64 = 0;
    for y in 0..h as usize {
        for x in 0..w as usize {
            let a = (y * before.width as usize + x) * 4;
            let b = (y * after.width as usize + x) * 4;
            let differs = (0..4).any(|c| {
                (before.pixels[a + c] as i32 - after.pixels[b + c] as i32).abs() > CHANNEL_TOLERANCE
            });
            if differs {
                changed += 1;
            }
        }
    }
    let total = (union_w as u64) * (union_h as u64);
    let overlap = (w as u64) * (h as u64);
    changed += total - overlap; // everything only one image has

    DiffResult {
        ratio: if total == 0 { 0.0 } else { changed as f64 / total as f64 },
        changed_pixels: changed,
        total_pixels: total,
        width: union_w,
        height: union_h,
        size_changed: before.width != after.width || before.height != after.height,
    }
}

// --- perceptual hash (FR-5.2 visual signal) ----------------------------------

const GRID: usize = 8; // 8×8 cells = the 64 bits of the hash

/**
 * Median-threshold average hash: box-downscale to an 8×8 greyscale grid, then
 * set one bit per cell for "brighter than the image's median cell".
 *
 * The textbook choice here is dHash (each cell against its right neighbour),
 * and it is the wrong one for this input. dHash only sees *horizontal*
 * gradients, so a component with a dark left column and one with a dark top
 * row hash identically — and UI components are full of exactly those flat,
 * axis-aligned blocks. Thresholding every cell against the median instead
 * keeps the whole 2-D layout, and using the median rather than the mean keeps
 * the invariance that matters: a uniformly darker or lighter render of the
 * same component crosses the threshold in the same places.
 *
 * Transparent pixels are composited onto white first, so a component rendered
 * on the harness's transparent background hashes the same as one on the page.
 */
pub fn phash(image: &Image) -> u64 {
    if image.width == 0 || image.height == 0 {
        return 0;
    }
    let mut cells = [0f64; GRID * GRID];
    for (cy, row) in cells.chunks_mut(GRID).enumerate() {
        for (cx, cell) in row.iter_mut().enumerate() {
            // Box-average the cell's source region — sampling a single pixel
            // makes the hash depend on where the grid happens to land.
            let x0 = cx * image.width as usize / GRID;
            let x1 = (((cx + 1) * image.width as usize) / GRID).max(x0 + 1);
            let y0 = cy * image.height as usize / GRID;
            let y1 = (((cy + 1) * image.height as usize) / GRID).max(y0 + 1);
            let mut sum = 0f64;
            let mut n = 0f64;
            for y in y0..y1.min(image.height as usize) {
                for x in x0..x1.min(image.width as usize) {
                    let i = (y * image.width as usize + x) * 4;
                    let alpha = image.pixels[i + 3] as f64 / 255.0;
                    let lum = 0.2126 * image.pixels[i] as f64
                        + 0.7152 * image.pixels[i + 1] as f64
                        + 0.0722 * image.pixels[i + 2] as f64;
                    sum += lum * alpha + 255.0 * (1.0 - alpha);
                    n += 1.0;
                }
            }
            *cell = if n > 0.0 { sum / n } else { 255.0 };
        }
    }

    let mut sorted = cells;
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = (sorted[GRID * GRID / 2 - 1] + sorted[GRID * GRID / 2]) / 2.0;

    let mut hash = 0u64;
    for (i, value) in cells.iter().enumerate() {
        if *value > median {
            hash |= 1 << i;
        }
    }
    hash
}

/// Visual similarity in [0, 1] — 1.0 means the hashes agree on every bit.
pub fn hash_similarity(a: u64, b: u64) -> f64 {
    1.0 - ((a ^ b).count_ones() as f64 / 64.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode an RGBA buffer as PNG so the decoder is exercised for real.
    fn encode(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(pixels).unwrap();
        }
        out
    }

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Image {
        Image {
            width,
            height,
            pixels: rgba.repeat((width * height) as usize),
        }
    }

    #[test]
    fn decodes_rgba_and_rgb_pngs() {
        let img = solid(4, 3, [10, 20, 30, 255]);
        let decoded = decode_png(&encode(4, 3, &img.pixels)).unwrap();
        assert_eq!((decoded.width, decoded.height), (4, 3));
        assert_eq!(&decoded.pixels[0..4], &[10, 20, 30, 255]);
        assert!(decode_png(b"not a png").is_err());
    }

    #[test]
    fn identical_captures_diff_to_zero() {
        let a = solid(20, 10, [200, 200, 200, 255]);
        let b = solid(20, 10, [200, 200, 200, 255]);
        let diff = compare(&a, &b);
        assert_eq!(diff.changed_pixels, 0);
        assert_eq!(diff.ratio, 0.0);
        assert!(!diff.size_changed);
    }

    #[test]
    fn compositing_noise_stays_under_the_gate() {
        let a = solid(20, 10, [200, 200, 200, 255]);
        let b = solid(20, 10, [204, 203, 202, 255]); // within CHANNEL_TOLERANCE
        assert_eq!(compare(&a, &b).changed_pixels, 0);
    }

    #[test]
    fn a_real_change_is_counted_as_a_fraction_of_the_image() {
        let mut b = solid(10, 10, [0, 0, 0, 255]);
        // Repaint the top row.
        for x in 0..10usize {
            b.pixels[x * 4] = 255;
        }
        let a = solid(10, 10, [0, 0, 0, 255]);
        let diff = compare(&a, &b);
        assert_eq!(diff.changed_pixels, 10);
        assert!((diff.ratio - 0.1).abs() < 1e-9, "{}", diff.ratio);
    }

    /// A merge that resizes something must never diff as clean.
    #[test]
    fn a_size_change_is_a_regression_not_a_resize() {
        let a = solid(10, 10, [0, 0, 0, 255]);
        let b = solid(10, 12, [0, 0, 0, 255]);
        let diff = compare(&a, &b);
        assert!(diff.size_changed);
        assert_eq!(diff.changed_pixels, 20, "the two extra rows count as changed");
        assert!(diff.ratio > 0.0);
    }

    /// The similarity signal: same shape at a different scale, same hash.
    #[test]
    fn phash_is_scale_invariant_for_the_same_shape() {
        let make = |scale: u32| {
            let (w, h) = (16 * scale, 16 * scale);
            let mut px = vec![255u8; (w * h * 4) as usize];
            for y in 0..h {
                for x in 0..w {
                    // A dark block in the left half — the "shape".
                    if x < w / 2 {
                        let i = ((y * w + x) * 4) as usize;
                        px[i] = 20;
                        px[i + 1] = 20;
                        px[i + 2] = 20;
                    }
                }
            }
            Image { width: w, height: h, pixels: px }
        };
        let small = phash(&make(1));
        let big = phash(&make(4));
        assert_eq!(small, big, "the same shape at 4× must hash the same");
        assert_eq!(hash_similarity(small, big), 1.0);
    }

    #[test]
    fn phash_separates_different_shapes() {
        let left = {
            let mut px = vec![255u8; 32 * 32 * 4];
            for y in 0..32usize {
                for x in 0..16usize {
                    let i = (y * 32 + x) * 4;
                    px[i] = 0;
                    px[i + 1] = 0;
                    px[i + 2] = 0;
                }
            }
            Image { width: 32, height: 32, pixels: px }
        };
        let top = {
            let mut px = vec![255u8; 32 * 32 * 4];
            for y in 0..16usize {
                for x in 0..32usize {
                    let i = (y * 32 + x) * 4;
                    px[i] = 0;
                    px[i + 1] = 0;
                    px[i + 2] = 0;
                }
            }
            Image { width: 32, height: 32, pixels: px }
        };
        assert!(
            hash_similarity(phash(&left), phash(&top)) < 0.7,
            "a left block and a top block should not read as the same component"
        );
    }

    /// A transparent harness background must not change the hash.
    #[test]
    fn phash_composites_transparency_onto_white() {
        let opaque = solid(16, 16, [255, 255, 255, 255]);
        let transparent = solid(16, 16, [0, 0, 0, 0]);
        assert_eq!(phash(&opaque), phash(&transparent));
    }

    #[test]
    fn degenerate_images_do_not_panic() {
        assert_eq!(phash(&solid(0, 0, [0, 0, 0, 0])), 0);
        let diff = compare(&solid(0, 0, [0; 4]), &solid(0, 0, [0; 4]));
        assert_eq!(diff.ratio, 0.0);
    }
}
