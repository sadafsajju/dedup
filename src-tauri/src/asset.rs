//! Importing a file an AI agent generated into the user's project.
//!
//! This is the one place where something the model *said* names a path outside
//! the project, so it is the one place that has to assume the model is wrong.
//! An agent asked for a landing page can generate an image; it cannot type a
//! PNG out as text, so the reply carries a path instead of contents and dedup
//! goes and fetches it. A model that named `~/.ssh/id_rsa` would otherwise get
//! it copied into the project and committed — which is why none of the checks
//! below is about the *destination* alone.
//!
//! Four gates, in order, each one refusing rather than repairing:
//!
//!   1. the source must sit inside the directory that agent writes its own
//!      output to (`Agent::asset_dir`), resolved through symlinks so a link
//!      planted inside it cannot point out;
//!   2. it must be small enough to be an image someone meant to ship;
//!   3. its *bytes* must say what it is — never its extension, which is the
//!      part the model chose;
//!   4. the destination must land inside the project and must not exist.
//!
//! Only then is it a copy. Nothing here writes to the user's history: the
//! result is an ordinary uncommitted file, kept or discarded with the rest of
//! the chat proposal it arrived in.

use crate::ai::Agent;
use std::path::{Path, PathBuf};

/// Big enough for any image an agent generates, small enough that a mistake
/// cannot fill someone's repository.
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;

/// What an image's leading bytes say it is, and the extensions that may name
/// it. Sniffed rather than trusted: the extension is the model's choice, the
/// magic number is the file's own account of itself.
struct ImageKind {
    label: &'static str,
    magic: &'static [u8],
    /// Extra bytes to check further in, with their offset (WebP's "WEBP").
    at: Option<(usize, &'static [u8])>,
    extensions: &'static [&'static str],
}

const IMAGE_KINDS: &[ImageKind] = &[
    ImageKind {
        label: "PNG",
        magic: b"\x89PNG\r\n\x1a\n",
        at: None,
        extensions: &["png"],
    },
    ImageKind {
        label: "JPEG",
        magic: b"\xff\xd8\xff",
        at: None,
        extensions: &["jpg", "jpeg"],
    },
    ImageKind {
        label: "GIF",
        magic: b"GIF8",
        at: None,
        extensions: &["gif"],
    },
    ImageKind {
        label: "WebP",
        magic: b"RIFF",
        at: Some((8, b"WEBP")),
        extensions: &["webp"],
    },
];

fn sniff(head: &[u8]) -> Option<&'static ImageKind> {
    IMAGE_KINDS.iter().find(|k| {
        head.starts_with(k.magic)
            && k.at.is_none_or(|(offset, tail)| {
                head.len() >= offset + tail.len() && &head[offset..offset + tail.len()] == tail
            })
    })
}

/// One imported file, as the editor reports it back to the user.
#[derive(Debug, serde::Serialize)]
pub struct ImportedAsset {
    /// Project-relative path it landed at.
    pub file: String,
    pub bytes: u64,
    /// "PNG", "JPEG", … — what the bytes said, not what the name claimed.
    pub kind: String,
}

/// True when `path`, fully resolved, is inside `dir`, also fully resolved.
/// Both sides are canonicalized: comparing the strings dedup was handed would
/// be fooled by `..` and by a symlink planted inside the directory.
fn inside(dir: &Path, path: &Path) -> bool {
    match (dir.canonicalize(), path.canonicalize()) {
        (Ok(dir), Ok(path)) => path.starts_with(&dir),
        _ => false,
    }
}

/// Copy an agent-generated file into the project. See the module comment for
/// what each refusal is protecting against.
///
/// `adapt_extension` is for a destination the requester named *before the
/// image existed* — a model asking another agent for one (an IMAGE block)
/// cannot know what format it will get back. With it, a name that disagrees
/// with the bytes is corrected (`hero.jpg` → `hero.png`) instead of refused,
/// and the result says where the file actually landed. The rule is unchanged
/// either way: the name always ends up agreeing with the bytes, and it is the
/// bytes that decide.
pub fn import(
    root: &str,
    agent: Agent,
    source: &str,
    dest_rel: &str,
    adapt_extension: bool,
) -> Result<ImportedAsset, String> {
    let Some(dir) = agent.asset_dir() else {
        return Err(format!(
            "{} does not generate files dedup can import",
            agent.label()
        ));
    };

    let source = PathBuf::from(source);
    if !inside(&dir, &source) {
        // Deliberately says where the boundary is rather than what was asked
        // for: the path came from a model, and echoing it back into the UI is
        // how a prompt injection gets a sentence in front of the user.
        return Err(format!(
            "that file is not one {} generated — dedup only imports from {}",
            agent.label(),
            dir.display()
        ));
    }
    let meta = source
        .metadata()
        .map_err(|e| format!("could not read the generated file: {e}"))?;
    if !meta.is_file() {
        return Err("the generated path is not a file".into());
    }
    if meta.len() == 0 {
        return Err("the generated file is empty".into());
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "that file is {:.1} MB — dedup imports images up to {} MB",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_ASSET_BYTES / (1024 * 1024)
        ));
    }

    let bytes = std::fs::read(&source).map_err(|e| format!("could not read it: {e}"))?;
    let Some(kind) = sniff(&bytes) else {
        return Err("that file is not an image dedup recognises (PNG, JPEG, GIF or WebP)".into());
    };

    // The name has to agree with the bytes. Not pedantry: the destination
    // extension is what decides how the browser — and dedup's own write-back —
    // will treat the file later.
    let ext = Path::new(dest_rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let adapted;
    let dest_rel = if !kind.extensions.contains(&ext.as_str()) && adapt_extension {
        adapted = Path::new(dest_rel)
            .with_extension(kind.extensions[0])
            .to_string_lossy()
            .replace('\\', "/");
        adapted.as_str()
    } else {
        dest_rel
    };
    let ext = Path::new(dest_rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !kind.extensions.contains(&ext.as_str()) {
        // Names the destination it was actually handed. The first version of
        // this message reported the extension alone, which for a path wearing
        // a stray bracket read "cannot be saved as .png> — name it .png" —
        // two nearly identical strings and no way to see the difference. The
        // parser strips that decoration now; this stays legible if anything
        // else ever gets here.
        return Err(format!(
            "that image is a {}, but the AI asked to save it as `{dest_rel}` — it needs a .{} name",
            kind.label,
            kind.extensions[0]
        ));
    }

    // Containment for the destination is the project's own rule, unchanged.
    let dest = crate::sidecar::resolve_new_in_root(root, dest_rel)?;
    if dest.exists() {
        return Err(format!("{dest_rel} already exists — dedup will not overwrite it"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&dest, &bytes).map_err(|e| format!("could not write {dest_rel}: {e}"))?;

    Ok(ImportedAsset {
        file: dest_rel.to_string(),
        bytes: meta.len(),
        kind: kind.label.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR rest of a png";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dedup-asset-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The gate that matters: a path the model names is only ever fetched
    /// from the directory that agent writes its own output to.
    #[test]
    fn only_imports_from_the_agents_own_output_directory() {
        let root = temp("root");
        let elsewhere = temp("elsewhere");
        let secret = elsewhere.join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();

        let err = import(
            root.to_str().unwrap(),
            Agent::Codex,
            secret.to_str().unwrap(),
            "public/key.png",
            false,
        )
        .unwrap_err();
        assert!(err.contains("only imports from"), "got: {err}");
        assert!(!root.join("public/key.png").exists());

        // A symlink planted inside the asset directory is the same attack
        // wearing an allowed path, and canonicalizing both sides is what
        // catches it.
        if let Some(dir) = Agent::Codex.asset_dir() {
            std::fs::create_dir_all(&dir).ok();
            let link = dir.join(format!("dedup-test-link-{}.png", std::process::id()));
            std::fs::remove_file(&link).ok();
            #[cfg(unix)]
            if std::os::unix::fs::symlink(&secret, &link).is_ok() {
                let err = import(
                    root.to_str().unwrap(),
                    Agent::Codex,
                    link.to_str().unwrap(),
                    "public/key.png",
                    false,
                )
                .unwrap_err();
                assert!(err.contains("only imports from"), "symlink escaped: {err}");
                std::fs::remove_file(&link).ok();
            }
        }
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&elsewhere).ok();
    }

    /// Inside the directory, the bytes still have to be an image, and the name
    /// still has to agree with them.
    /// An IMAGE request names its destination before the image exists, so a
    /// disagreeing extension is corrected rather than refused — and the gates
    /// that are not about the name still hold exactly as before.
    #[test]
    fn a_delegated_image_is_renamed_to_what_its_bytes_are() {
        let Some(base) = Agent::Codex.asset_dir() else {
            return;
        };
        let tag = std::process::id();
        let dir = base.join(format!("dedup-adapt-{tag}"));
        std::fs::create_dir_all(&dir).ok();
        let root = temp("adapt");

        let png = dir.join(format!("dedup-adapt-{tag}.png"));
        std::fs::write(&png, PNG).unwrap();
        let ok = import(
            root.to_str().unwrap(),
            Agent::Codex,
            png.to_str().unwrap(),
            "images/hero-container-lift.jpg",
            true,
        )
        .unwrap();
        assert_eq!(ok.file, "images/hero-container-lift.png", "the result says where it landed");
        assert_eq!(ok.kind, "PNG");
        assert_eq!(std::fs::read(root.join("images/hero-container-lift.png")).unwrap(), PNG);
        assert!(!root.join("images/hero-container-lift.jpg").exists());

        // Adapting the name is not adapting anything else: a non-image is
        // still refused, and so is a name already taken.
        let text = dir.join(format!("dedup-adapt-{tag}-text.png"));
        std::fs::write(&text, "not an image").unwrap();
        let err = import(root.to_str().unwrap(), Agent::Codex, text.to_str().unwrap(), "a.jpg", true)
            .unwrap_err();
        assert!(err.contains("not an image"), "got: {err}");
        let err = import(
            root.to_str().unwrap(),
            Agent::Codex,
            png.to_str().unwrap(),
            "images/hero-container-lift.webp",
            true,
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "the corrected name is the one checked: {err}");

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sniffs_the_bytes_and_makes_the_name_agree() {
        let Some(base) = Agent::Codex.asset_dir() else {
            return;
        };
        // The real layout: one subdirectory per generation, so containment has
        // to hold for a nested path and not just a direct child.
        let tag = std::process::id();
        let dir = base.join(format!("dedup-test-{tag}"));
        std::fs::create_dir_all(&dir).ok();
        let root = temp("root");

        let text = dir.join(format!("dedup-test-{tag}.png"));
        std::fs::write(&text, "#!/bin/sh\nrm -rf /\n").unwrap();
        let err = import(
            root.to_str().unwrap(),
            Agent::Codex,
            text.to_str().unwrap(),
            "public/a.png",
            false,
        )
        .unwrap_err();
        assert!(err.contains("not an image"), "got: {err}");

        let png = dir.join(format!("dedup-test-{tag}-real.png"));
        std::fs::write(&png, PNG).unwrap();
        let err = import(
            root.to_str().unwrap(),
            Agent::Codex,
            png.to_str().unwrap(),
            "public/a.jpg",
            false,
        )
        .unwrap_err();
        assert!(err.contains("needs a .png name"), "got: {err}");
        assert!(err.contains("public/a.jpg"), "the message names the path: {err}");

        // Named honestly, it lands — and the bytes arrive intact.
        let ok = import(
            root.to_str().unwrap(),
            Agent::Codex,
            png.to_str().unwrap(),
            "public/a.png",
            false,
        )
        .unwrap();
        assert_eq!(ok.kind, "PNG");
        assert_eq!(std::fs::read(root.join("public/a.png")).unwrap(), PNG);

        // Never over something already there.
        let err = import(
            root.to_str().unwrap(),
            Agent::Codex,
            png.to_str().unwrap(),
            "public/a.png",
            false,
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");

        // And never outside the project, whatever the destination says.
        let err = import(
            root.to_str().unwrap(),
            Agent::Codex,
            png.to_str().unwrap(),
            "../escaped.png",
            false,
        )
        .unwrap_err();
        assert!(err.contains("outside the project"), "got: {err}");

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_agent_that_generates_nothing_says_so() {
        let root = temp("root");
        let err = import(
            root.to_str().unwrap(),
            Agent::ClaudeCode,
            "/tmp/whatever.png",
            "public/a.png",
            false,
        )
        .unwrap_err();
        assert!(err.contains("does not generate"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
