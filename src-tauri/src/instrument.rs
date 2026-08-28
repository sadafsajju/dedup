//! Tagging-plugin injection (FR-2.1). Writes the prebuilt tagger bundle,
//! overlay script, and a generated wrapper config into the user's project at
//! node_modules/.dedup/ (git-ignored territory — the user's source and config
//! are never touched), then rewrites the dev command to
//! `node_modules/.bin/vite <their args> --config node_modules/.dedup/vite.config.mjs`.
//!
//! Returns None (no instrumentation, plain spawn) for anything we can't
//! confidently rewrite — non-Vite projects, dev scripts that aren't a plain
//! `vite …` invocation, or a missing vite binary.

use std::path::{Path, PathBuf};

const TAGGER_BUNDLE: &str = include_str!("../assets/dedup-tagger.mjs");
const OVERLAY_SRC: &str = include_str!("../assets/dedup-overlay.js");
const NEXT_WRAPPER: &str = include_str!("../assets/dedup-next.mjs");
const NEXT_LOADER: &str = include_str!("../assets/dedup-next-loader.cjs");

pub struct Instrumentation {
    /// Absolute path to the executable to spawn (node_modules/.bin/vite).
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub fn setup(root: &str, dev_script: Option<&str>) -> Result<Option<Instrumentation>, String> {
    let root_path = Path::new(root);

    let vite_bin = root_path.join("node_modules/.bin/vite");
    if !vite_bin.exists() {
        return Ok(None);
    }

    // Only rewrite dev scripts that are a bare vite invocation (`vite`,
    // `vite --port 3001`, `vite dev`). Anything fancier runs untouched.
    let script = dev_script.unwrap_or("vite");
    let mut parts = script.split_whitespace();
    if parts.next() != Some("vite") {
        return Ok(None);
    }
    let mut args: Vec<String> = parts.map(str::to_string).collect();
    if args.iter().any(|a| a == "--config" || a == "-c") {
        // The project already pins a config on the CLI; ours would conflict.
        return Ok(None);
    }

    let dedup_dir = root_path.join("node_modules/.dedup");
    std::fs::create_dir_all(&dedup_dir).map_err(|e| format!("create .dedup dir: {e}"))?;
    std::fs::write(dedup_dir.join("dedup-tagger.mjs"), TAGGER_BUNDLE)
        .map_err(|e| format!("write tagger: {e}"))?;
    std::fs::write(dedup_dir.join("dedup-overlay.js"), OVERLAY_SRC)
        .map_err(|e| format!("write overlay: {e}"))?;

    let wrapper = wrapper_source(root_path, find_vite_config(root_path).as_deref());
    std::fs::write(dedup_dir.join("vite.config.mjs"), wrapper)
        .map_err(|e| format!("write wrapper config: {e}"))?;

    args.push("--config".into());
    args.push("node_modules/.dedup/vite.config.mjs".into());

    Ok(Some(Instrumentation {
        program: vite_bin,
        args,
    }))
}

fn find_vite_config(root: &Path) -> Option<PathBuf> {
    const CANDIDATES: [&str; 5] = [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "vite.config.mts",
        "vite.config.cjs",
    ];
    CANDIDATES
        .iter()
        .map(|c| root.join(c))
        .find(|p| p.exists())
}

/// Generate the wrapper config that imports the user's own config (if any)
/// and prepends the tagger plugin. Vite bundles this file with esbuild, so a
/// static import of their .ts config compiles fine.
fn wrapper_source(root: &Path, user_config: Option<&Path>) -> String {
    let root_str = root.display();
    let user_import = match user_config {
        Some(p) => format!("import userMod from '{}';", p.display()),
        None => "const userMod = {};".to_string(),
    };
    format!(
        r#"// dedup wrapper config — generated at session start; never committed.
import dedupTagger from './dedup-tagger.mjs';
{user_import}
export default async (env) => {{
  let user = userMod ?? {{}};
  if (typeof user === 'function') user = await user(env);
  user.plugins = [dedupTagger({{ root: '{root_str}' }}), ...(user.plugins || [])];
  return user;
}};
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str, with_config: bool, dev_script_bin: bool) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("dedup-instr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules/.bin")).unwrap();
        if dev_script_bin {
            std::fs::write(dir.join("node_modules/.bin/vite"), "#!/bin/sh\n").unwrap();
        }
        if with_config {
            std::fs::write(dir.join("vite.config.ts"), "export default {}").unwrap();
        }
        dir
    }

    #[test]
    fn rewrites_plain_vite_script_and_writes_assets() {
        let dir = temp_project("basic", true, true);
        let out = setup(dir.to_str().unwrap(), Some("vite --port 3001"))
            .unwrap()
            .expect("should instrument");
        assert!(out.program.ends_with("node_modules/.bin/vite"));
        assert_eq!(
            out.args,
            vec!["--port", "3001", "--config", "node_modules/.dedup/vite.config.mjs"]
        );
        let wrapper =
            std::fs::read_to_string(dir.join("node_modules/.dedup/vite.config.mjs")).unwrap();
        assert!(wrapper.contains("vite.config.ts';"));
        assert!(dir.join("node_modules/.dedup/dedup-tagger.mjs").exists());
        assert!(dir.join("node_modules/.dedup/dedup-overlay.js").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_non_vite_dev_scripts() {
        let dir = temp_project("next", true, true);
        assert!(setup(dir.to_str().unwrap(), Some("next dev")).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_when_script_pins_its_own_config() {
        let dir = temp_project("pinned", true, true);
        assert!(setup(dir.to_str().unwrap(), Some("vite --config custom.ts"))
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_without_vite_binary() {
        let dir = temp_project("nobin", true, false);
        assert!(setup(dir.to_str().unwrap(), Some("vite")).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrapper_without_user_config_still_valid() {
        let dir = temp_project("nocfg", false, true);
        setup(dir.to_str().unwrap(), Some("vite")).unwrap().unwrap();
        let wrapper =
            std::fs::read_to_string(dir.join("node_modules/.dedup/vite.config.mjs")).unwrap();
        assert!(wrapper.contains("const userMod = {};"));
        std::fs::remove_dir_all(&dir).ok();
    }
}


// --- Next.js (Phase 5) --------------------------------------------------------
//
// Vite takes `--config`, so dedup instruments it without the project noticing.
// Next reads `next.config.*` from the root and takes no such flag, so element
// tagging on Next needs one line in a file dedup does not own.
//
// The standing convention — "the user's source and config are never mutated
// for tooling" — is about *silent* mutation, and it is not weakened here: the
// line is added only when the user asks for it, they are shown the exact diff
// first, it is committed on the session branch like every other dedup write,
// and it is undoable from History. It is also inert: the wrapper does nothing
// unless `DEDUP_TAGGING=1`, which only dedup's own dev server sets, so their
// `next dev`, their CI and their production build behave identically with the
// line present.

/// What dedup can do for a Next project right now.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum NextStatus {
    /// The config already calls `withDedup` — tagging is on.
    Wired { config: String },
    /// A config exists and could be wrapped; here is the change.
    Offered {
        config: String,
        before: String,
        after: String,
    },
    /// Nothing dedup knows how to edit safely; inspection stays off.
    Unavailable { reason: String },
}

const NEXT_CONFIGS: [&str; 4] = [
    "next.config.mjs",
    "next.config.js",
    "next.config.ts",
    "next.config.cjs",
];

fn find_next_config(root: &Path) -> Option<PathBuf> {
    NEXT_CONFIGS
        .iter()
        .map(|c| root.join(c))
        .find(|p| p.exists())
}

/// Write the Next-side assets into `node_modules/.dedup/`: the config wrapper,
/// the webpack tagging loader, and the client entry (boot script + overlay)
/// that the wrapper prepends. Same sanctioned injection point as everything
/// else dedup writes.
fn write_next_assets(root: &Path) -> Result<(), String> {
    let dir = root.join("node_modules/.dedup");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .dedup dir: {e}"))?;
    std::fs::write(dir.join("next.mjs"), NEXT_WRAPPER)
        .map_err(|e| format!("write next wrapper: {e}"))?;
    std::fs::write(dir.join("next-loader.cjs"), NEXT_LOADER)
        .map_err(|e| format!("write next loader: {e}"))?;
    // The client entry is the overlay, gated to framed pages. The boot script
    // (mock session + hold) is served per request on Vite; on Next there is no
    // request to hook, so the overlay carries itself alone and the seed stays
    // a Vite-only feature — said out loud rather than half-working.
    std::fs::write(
        dir.join("next-client.js"),
        format!(
            "// dedup client entry — generated at session start; never committed.\n\
             if (typeof window !== \"undefined\" && window.top !== window.self) {{\n{OVERLAY_SRC}\n}}\n"
        ),
    )
    .map_err(|e| format!("write next client entry: {e}"))?;
    Ok(())
}

/// Add the `withDedup` wrapper to a next.config's source. Returns the new text,
/// or an error naming what it could not recognise — a config too clever to
/// pattern-match is left alone rather than rewritten on a guess.
fn wrap_next_config(source: &str, esm: bool) -> Result<String, String> {
    if source.contains("withDedup") {
        return Err("this config already calls withDedup".into());
    }
    let import_line = if esm {
        "import { withDedup } from \"./node_modules/.dedup/next.mjs\";"
    } else {
        "const { withDedup } = require(\"./node_modules/.dedup/next.mjs\");"
    };

    // The export is the only thing that has to be found: whatever the config
    // computes, dedup wraps the value it exports.
    let (marker, keep_len) = if let Some(i) = source.find("export default ") {
        (i, "export default ".len())
    } else if let Some(i) = source.find("module.exports = ") {
        (i, "module.exports = ".len())
    } else if let Some(i) = source.find("module.exports=") {
        (i, "module.exports=".len())
    } else {
        return Err(
            "couldn't find the config's export — add `withDedup(...)` around it by hand".into(),
        );
    };

    let value_start = marker + keep_len;
    let rest = source[value_start..].trim_end();
    let (value, trailer) = match rest.strip_suffix(';') {
        Some(v) => (v.trim_end(), ";"),
        None => (rest, ""),
    };
    if value.is_empty() {
        return Err("the config's export is empty".into());
    }

    Ok(format!(
        "{import_line}\n{}{}withDedup({value}){trailer}\n",
        &source[..marker],
        &source[marker..value_start],
    ))
}

/// Report what dedup can do for this Next project, writing the assets it will
/// need either way (they are inert until the config calls them).
pub fn next_status(root: &str) -> NextStatus {
    let root_path = Path::new(root);
    if let Err(e) = write_next_assets(root_path) {
        return NextStatus::Unavailable { reason: e };
    }
    let Some(config) = find_next_config(root_path) else {
        return NextStatus::Unavailable {
            reason: "this project has no next.config file for dedup to extend".into(),
        };
    };
    let name = config
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let Ok(source) = std::fs::read_to_string(&config) else {
        return NextStatus::Unavailable {
            reason: format!("could not read {name}"),
        };
    };
    if source.contains("withDedup") {
        return NextStatus::Wired { config: name };
    }
    let esm = name.ends_with(".mjs") || name.ends_with(".ts") || source.contains("export default");
    match wrap_next_config(&source, esm) {
        Ok(after) => NextStatus::Offered {
            config: name,
            before: source,
            after,
        },
        Err(reason) => NextStatus::Unavailable { reason },
    }
}

#[cfg(test)]
mod next_tests {
    use super::*;

    #[test]
    fn wraps_an_esm_config() {
        let out = wrap_next_config("const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n", true).unwrap();
        assert!(out.starts_with("import { withDedup }"), "{out}");
        assert!(out.contains("export default withDedup(nextConfig);"), "{out}");
        assert!(out.contains("reactStrictMode"), "the original config survives");
    }

    #[test]
    fn wraps_a_cjs_config() {
        let out =
            wrap_next_config("module.exports = { reactStrictMode: true }\n", false).unwrap();
        assert!(out.contains("const { withDedup } = require("), "{out}");
        assert!(out.contains("module.exports = withDedup({ reactStrictMode: true })"), "{out}");
    }

    #[test]
    fn wraps_an_inline_object_export() {
        let out = wrap_next_config("export default {\n  images: { unoptimized: true },\n};\n", true).unwrap();
        assert!(out.contains("export default withDedup({"), "{out}");
        assert!(out.contains("unoptimized"), "{out}");
    }

    /// Twice would nest the wrapper; the second call has to refuse.
    #[test]
    fn refuses_a_config_it_already_wrapped() {
        let once = wrap_next_config("export default nextConfig;\n", true).unwrap();
        assert!(wrap_next_config(&once, true).is_err());
    }

    #[test]
    fn refuses_a_config_with_no_recognisable_export() {
        let err = wrap_next_config("const x = 1;\n", true).unwrap_err();
        assert!(err.contains("export"), "{err}");
    }
}
