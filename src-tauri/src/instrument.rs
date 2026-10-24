//! Tagging-plugin injection (FR-2.1). Writes the prebuilt tagger bundle,
//! overlay script, and a generated wrapper config into the user's project at
//! node_modules/.dedup/ (git-ignored territory — the user's source and config
//! are never touched), then rewrites the dev command to
//! `node_modules/.bin/vite <their args> --config node_modules/.dedup/vite.config.mjs`.
//!
//! Returns None (no instrumentation, plain spawn) for anything we can't
//! confidently rewrite — non-Vite projects, dev scripts that aren't a plain
//! `vite …` invocation, or a missing vite binary.
//!
//! Two more launch paths live further down, one per kind of project dedup can
//! open that isn't Vite: `next_webpack_launch` (Next has no `--config` flag,
//! so tagging rides on one line in the user's own next.config) and
//! `static_setup` (a plain HTML site has no build to hook, so dedup serves it
//! and stamps the response instead).

use std::path::{Path, PathBuf};

const TAGGER_BUNDLE: &str = include_str!("../assets/dedup-tagger.mjs");
const OVERLAY_SRC: &str = include_str!("../assets/dedup-overlay.js");
const NEXT_WRAPPER: &str = include_str!("../assets/dedup-next.mjs");
const NEXT_LOADER: &str = include_str!("../assets/dedup-next-loader.cjs");
const NEXT_TYPES: &str = include_str!("../assets/dedup-next.d.mts");
const SERVE_BUNDLE: &str = include_str!("../assets/dedup-serve.mjs");

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
    crate::project::VITE_CONFIG_NAMES
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


// --- Static sites -------------------------------------------------------------
//
// A plain HTML site has no build step to hook, so there is nothing to
// instrument — but it also needs no instrumentation. dedup serves the folder
// itself and runs every HTML response through the shared stamper on the way
// out, which is the same tagging guarantee the Vite path gives (ids exist only
// in what the browser receives, never in the user's file) reached by a
// shorter road.
//
// The server runs as the project's dev server child process, so process-group
// teardown, log streaming and ready-URL parsing all apply unchanged.

/// Prepare the static server for `root` and return how to launch it.
///
/// `static_dir` is the folder the pages live in when they aren't at the root
/// (`site/`, `www/`); ids stay relative to `root` either way.
pub fn static_setup(root: &str, static_dir: Option<&str>) -> Result<Instrumentation, String> {
    let node = crate::sidecar::find_node()?;
    let dir = crate::sidecar::support_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create support dir: {e}"))?;

    let server = dir.join("dedup-serve.mjs");
    std::fs::write(&server, SERVE_BUNDLE).map_err(|e| format!("write static server: {e}"))?;
    let overlay = dir.join("dedup-overlay.js");
    std::fs::write(&overlay, OVERLAY_SRC).map_err(|e| format!("write overlay: {e}"))?;

    let serve_root = match static_dir {
        Some(d) if !d.is_empty() => Path::new(root).join(d),
        _ => PathBuf::from(root),
    };

    Ok(Instrumentation {
        program: node,
        args: vec![
            server.to_string_lossy().to_string(),
            "--root".into(),
            serve_root.to_string_lossy().to_string(),
            "--base".into(),
            root.to_string(),
            "--overlay".into(),
            overlay.to_string_lossy().to_string(),
            "--session".into(),
            dir.join("session.json").to_string_lossy().to_string(),
        ],
    })
}

#[cfg(test)]
mod static_tests {
    use super::*;

    #[test]
    fn static_setup_serves_the_pages_and_keeps_ids_project_relative() {
        let dir = std::env::temp_dir().join(format!("dedup-static-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(dir.join("site/index.html"), "<h1>x</h1>").unwrap();
        let root = dir.to_str().unwrap();

        let launch = static_setup(root, Some("site")).unwrap();
        let args = launch.args.join(" ");
        assert!(args.contains("--root"), "{args}");
        assert!(args.contains(&format!("{root}/site")), "serves the pages folder: {args}");
        assert!(
            args.contains(&format!("--base {root}")),
            "but ids stay relative to the project root: {args}"
        );

        // Nothing may land in the user's folder: a static site has no
        // node_modules to hide in, so dedup's files live outside it.
        assert!(
            !dir.join("node_modules").exists(),
            "dedup must not create node_modules in a static site"
        );
        let support = crate::sidecar::support_dir(root);
        assert!(support.join("dedup-serve.mjs").exists());
        assert!(support.join("dedup-overlay.js").exists());
        assert!(
            !support.starts_with(&dir),
            "support files for a static site live outside the project"
        );

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&support).ok();
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
    Wired {
        config: String,
        /// The project's dev server would otherwise run Turbopack, so dedup
        /// launches it under webpack; the UI says so.
        needs_webpack: bool,
    },
    /// A config exists and could be wrapped; here is the change.
    Offered {
        config: String,
        before: String,
        after: String,
        needs_webpack: bool,
    },
    /// Nothing dedup knows how to edit safely; inspection stays off.
    Unavailable { reason: String },
}

/// How to start this Next project's dev server under webpack.
///
/// Forwarding `--webpack` through the package manager (`yarn dev --webpack`)
/// only works when the script sets no bundler flag of its own. A script that
/// already says `--turbopack` gets *both*, and Next refuses to start:
/// "Multiple bundler flags set". The flag has to replace theirs, and it can't
/// do that from the outside — so dedup runs `next` itself.
///
/// Only a script it can read confidently: optional `KEY=value` prefixes, then
/// `next dev`, then flags. That covers the real-world shape (a `NODE_OPTIONS`
/// heap bump in front of `next dev --turbopack`) and refuses anything with
/// shell operators rather than rewriting a command it does not understand —
/// the same conservatism the Vite path uses.
pub struct NextLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Env assignments lifted off the front of the script, so whatever it set
    /// up (a heap limit a big app needs to not OOM) still applies.
    pub env: Vec<(String, String)>,
}

const BUNDLER_FLAGS: [&str; 3] = ["--turbopack", "--turbo", "--webpack"];

pub fn next_webpack_launch(root: &str, dev_script: Option<&str>) -> Option<NextLaunch> {
    let script = dev_script?.trim();
    // Anything that chains, pipes or substitutes is a command we cannot claim
    // to understand well enough to rewrite.
    if ["&&", "||", ";", "|", "$(", "`", ">", "<"]
        .iter()
        .any(|op| script.contains(op))
    {
        return None;
    }

    let bin = Path::new(root).join("node_modules/.bin/next");
    if !bin.exists() {
        return None;
    }

    let mut env = Vec::new();
    let mut tokens = script.split_whitespace().peekable();
    while let Some(token) = tokens.peek() {
        // `KEY=value` before the command is an env assignment, not an argument.
        let Some((key, value)) = token.split_once('=') else { break };
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || key.chars().next().is_some_and(|c| c.is_ascii_digit())
        {
            break;
        }
        env.push((key.to_string(), value.trim_matches(['"', '\'']).to_string()));
        tokens.next();
    }

    // The command itself must be `next` (possibly `npx next`, which we skip).
    let mut command = tokens.next()?;
    if command == "npx" || command == "bunx" {
        command = tokens.next()?;
    }
    if !(command == "next" || command.ends_with("/next")) {
        return None;
    }

    let mut args: Vec<String> = vec!["dev".into()];
    for token in tokens {
        if token == "dev" || BUNDLER_FLAGS.contains(&token) {
            continue; // their bundler choice is the thing being replaced
        }
        args.push(token.to_string());
    }
    args.push("--webpack".into());

    Some(NextLaunch { program: bin, args, env })
}

/// Why this project's dev server won't run dedup's webpack hook, or None.
///
/// Two ways a project ends up on Turbopack: the flag on its dev script, and
/// Next 16, where Turbopack is the default and `--webpack` is the opt-out.
fn turbopack_reason(root: &Path) -> Option<String> {
    #[derive(serde::Deserialize, Default)]
    struct Pkg {
        #[serde(default)]
        scripts: std::collections::HashMap<String, String>,
        #[serde(default)]
        dependencies: std::collections::HashMap<String, String>,
        #[serde(default, rename = "devDependencies")]
        dev_dependencies: std::collections::HashMap<String, String>,
    }
    let pkg: Pkg = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();

    let dev = pkg.scripts.get("dev").cloned().unwrap_or_default();
    if dev.contains("--webpack") {
        return None; // explicitly opted back into webpack
    }
    if dev.contains("--turbopack") || dev.contains("--turbo") {
        return Some("the dev script asks for Turbopack".into());
    }
    let version = pkg
        .dependencies
        .get("next")
        .or_else(|| pkg.dev_dependencies.get("next"))
        .cloned()
        .unwrap_or_default();
    let major: u32 = version
        .trim_start_matches(['^', '~', '>', '=', 'v', ' '])
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    if major >= 16 {
        return Some(format!("Next {major} runs Turbopack by default"));
    }
    None
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
    // Sits beside next.mjs so TypeScript resolves `next.d.mts` for it — a
    // strict next.config.ts importing an untyped module is a TS7016 error,
    // and that would make dedup's own line break dedup's typecheck gate.
    std::fs::write(dir.join("next.d.mts"), NEXT_TYPES)
        .map_err(|e| format!("write next types: {e}"))?;
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
    if let Err(e) = write_next_assets(Path::new(root)) {
        return NextStatus::Unavailable { reason: e };
    }
    inspect_next_config(root)
}

/// The same verdict with **no side effects** — nothing written, nothing
/// created. The compatibility card runs before the user has decided to open
/// the project at all, and a read-only probe must not start putting files in
/// their `node_modules`.
pub fn inspect_next_config(root: &str) -> NextStatus {
    let root_path = Path::new(root);

    // Turbopack does not run `webpack()`, so the wrapper would be inert on a
    // Turbopack dev server. That is a launch detail rather than a dealbreaker:
    // dedup starts the dev server itself, so it can start it under webpack.
    // Verified against Next 16.2.4 — `--webpack` is still supported there.
    let needs_webpack = turbopack_reason(root_path).is_some();
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
        return NextStatus::Wired { config: name, needs_webpack };
    }
    let esm = name.ends_with(".mjs") || name.ends_with(".ts") || source.contains("export default");
    match wrap_next_config(&source, esm) {
        Ok(after) => NextStatus::Offered {
            config: name,
            before: source,
            after,
            needs_webpack,
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

    /// Turbopack ignores `webpack()`, so the wrapper alone would tag nothing.
    /// dedup starts the dev server, so the answer is to start it under
    /// webpack — verified against Next 16.2.4, where `--webpack` still works.
    /// What this pins is that the *need* is detected; refusing the wrapper
    /// outright would leave a Turbopack project with no way to ever enable
    /// inspection.
    #[test]
    fn turbopack_projects_are_offered_the_wrapper_and_flagged_for_webpack() {
        let dir = std::env::temp_dir().join(format!("dedup-turbo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("next.config.mjs"), "export default {};\n").unwrap();
        let root = dir.to_str().unwrap();

        let needs = |pkg: &str| {
            std::fs::write(dir.join("package.json"), pkg).unwrap();
            match inspect_next_config(root) {
                NextStatus::Offered { needs_webpack, .. } => needs_webpack,
                other => panic!("expected Offered, got {other:?}"),
            }
        };

        // The flag on the dev script.
        assert!(needs(
            r#"{"scripts":{"dev":"next dev --turbopack"},"dependencies":{"next":"15.1.0"}}"#
        ));
        // Next 16 runs Turbopack even with no flag.
        assert!(needs(
            r#"{"scripts":{"dev":"next dev"},"dependencies":{"next":"^16.2.4"}}"#
        ));
        // ...unless they opted back into webpack themselves.
        assert!(!needs(
            r#"{"scripts":{"dev":"next dev --webpack"},"dependencies":{"next":"^16.2.4"}}"#
        ));
        // Next 15 without the flag is webpack already.
        assert!(!needs(
            r#"{"scripts":{"dev":"next dev"},"dependencies":{"next":"15.1.0"}}"#
        ));

        // A wired config carries the same answer, so the launcher knows.
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"next dev --turbopack"},"dependencies":{"next":"16.2.4"}}"#).unwrap();
        std::fs::write(
            dir.join("next.config.mjs"),
            "import { withDedup } from \"./node_modules/.dedup/next.mjs\";\nexport default withDedup({});\n",
        )
        .unwrap();
        match inspect_next_config(root) {
            NextStatus::Wired { needs_webpack, .. } => assert!(needs_webpack),
            other => panic!("expected Wired, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression: appending `--webpack` to a script that already says
    /// `--turbopack` makes Next refuse to start ("Multiple bundler flags
    /// set"). The flag must replace theirs, which means running `next`
    /// ourselves — while keeping the env their script set up.
    #[test]
    fn webpack_launch_replaces_their_bundler_flag_and_keeps_env() {
        let dir = std::env::temp_dir().join(format!("dedup-nextlaunch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules/.bin")).unwrap();
        std::fs::write(dir.join("node_modules/.bin/next"), "#!/bin/sh\n").unwrap();
        let root = dir.to_str().unwrap();

        // The real script from the project this was found on.
        let launch = next_webpack_launch(
            root,
            Some("NODE_OPTIONS=--max-old-space-size=8192 next dev --turbopack"),
        )
        .expect("should rewrite");
        assert!(launch.program.ends_with("node_modules/.bin/next"));
        assert_eq!(
            launch.args,
            vec!["dev", "--webpack"],
            "their --turbopack must be dropped, not joined"
        );
        assert_eq!(
            launch.env,
            vec![("NODE_OPTIONS".to_string(), "--max-old-space-size=8192".to_string())],
            "dropping the heap bump would reintroduce the OOM it was added for"
        );

        // Other flags on the script survive.
        let ported = next_webpack_launch(root, Some("next dev --port 4000 --turbo")).unwrap();
        assert_eq!(ported.args, vec!["dev", "--port", "4000", "--webpack"]);

        // No flag of their own: still a clean single --webpack.
        let plain = next_webpack_launch(root, Some("next dev")).unwrap();
        assert_eq!(plain.args, vec!["dev", "--webpack"]);

        // Scripts dedup can't confidently read are refused, not mangled.
        for script in [
            "rm -rf .next && next dev",
            "next dev | tee log",
            "node server.js",
            "concurrently \"next dev\" \"tsc -w\"",
        ] {
            assert!(
                next_webpack_launch(root, Some(script)).is_none(),
                "should refuse: {script}"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_config_with_no_recognisable_export() {
        let err = wrap_next_config("const x = 1;\n", true).unwrap_err();
        assert!(err.contains("export"), "{err}");
    }
}
