//! Parked pieces: elements dragged off every artboard onto the empty canvas.
//!
//! In Figma a layer outside a frame still exists in the file. A codebase has
//! no "outside" — every element lives in a file, and the only places that
//! render are pages — so a piece dropped on the canvas leaves its page (a
//! staged removal, saved like any other) and dedup keeps it: the source
//! snippet that a paste would write, the rendered markup a paste previews
//! with, and a picture for the card. It stays parked until it is dropped into
//! an artboard or deleted.
//!
//! "dedup keeps it" has to mean it survives anything short of the user
//! deleting it, because after a save the page no longer has it — this file
//! may be the only copy. So it lives in the app's *data* directory (not a
//! cache, which the OS may purge, and not `node_modules/.dedup`, which a
//! reinstall wipes), keyed by project path, written atomically.
//!
//! The format belongs to the editor (`lib/parking.ts`); this side only checks
//! that it is a JSON array of a sane size, so a corrupt write cannot happen
//! and a corrupt file cannot load.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DIR_NAME: &str = "parked";
/// Pictures are small PNGs, but a few dozen pieces with large snapshots is
/// still well under this. Past it, something is wrong with the data.
const MAX_BYTES: usize = 64 * 1024 * 1024;

fn file(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data dir: {e}"))?
        .join(DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    Ok(dir.join(format!("{}.json", crate::thumbs::key(root))))
}

/// The project's parked pieces, or an empty list. A missing or unreadable file
/// is an empty canvas, never an error that blocks opening the project.
pub fn load(app: &AppHandle, root: &str) -> serde_json::Value {
    file(app, root)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| parse(&text).ok())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()))
}

pub fn save(app: &AppHandle, root: &str, items: &serde_json::Value) -> Result<(), String> {
    let text = encode(items)?;
    let path = file(app, root)?;
    write_atomically(&path, &text)
}

fn parse(text: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if !value.is_array() {
        return Err("parked pieces must be a list".into());
    }
    Ok(value)
}

fn encode(items: &serde_json::Value) -> Result<String, String> {
    if !items.is_array() {
        return Err("parked pieces must be a list".into());
    }
    let text = serde_json::to_string(items).map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err(format!(
            "the parked pieces are {} MB — too large to keep; delete some from the canvas",
            text.len() / (1024 * 1024)
        ));
    }
    Ok(text)
}

/// Write beside the target and rename over it: a crash mid-write leaves the
/// previous file whole rather than a truncated one that loads as nothing.
fn write_atomically(path: &std::path::Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("couldn't save parked pieces: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("couldn't save parked pieces: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_list_goes_in_or_comes_out() {
        assert!(encode(&serde_json::json!([{ "id": "a" }])).is_ok());
        assert!(encode(&serde_json::json!({ "id": "a" })).is_err());
        assert!(parse("[]").unwrap().as_array().unwrap().is_empty());
        assert!(parse("{\"x\":1}").is_err());
        assert!(parse("[{\"id\":").is_err(), "a truncated file never loads");
    }

    #[test]
    fn an_atomic_write_replaces_the_file_whole() {
        let dir = std::env::temp_dir().join(format!("dedup-parked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.json");
        write_atomically(&path, "[1]").unwrap();
        write_atomically(&path, "[1,2]").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1,2]");
        assert!(!path.with_extension("json.tmp").exists(), "no temp file left behind");
        std::fs::remove_dir_all(&dir).ok();
    }
}
