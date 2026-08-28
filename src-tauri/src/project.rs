//! Project detection (FR-1.2): given a folder, work out package manager,
//! framework, and whether Tailwind / TypeScript are present, then produce a
//! human-readable compatibility summary the launch screen can show before load.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub package_manager: PackageManager,
    pub framework: Framework,
    pub has_tailwind: bool,
    pub has_typescript: bool,
    pub has_git: bool,
    /// The script we'll run to start the dev server, if we found one.
    pub dev_script: Option<String>,
    /// Overall verdict + the one-line summary rendered on the compat card.
    pub support: SupportLevel,
    pub summary: String,
    /// Specific reasons behind a `Partial`/`Unsupported` verdict.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageManager {
    Pnpm,
    Yarn,
    Bun,
    Npm,
    Unknown,
}

impl PackageManager {
    fn label(&self) -> &'static str {
        match self {
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Bun => "bun",
            PackageManager::Npm => "npm",
            PackageManager::Unknown => "npm",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Framework {
    Vite,
    Next,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportLevel {
    /// Everything we need is present.
    Full,
    /// Loadable, but something is missing or unverified (e.g. no Tailwind).
    Partial,
    /// We can't drive this project (no package.json / no dev script / no framework).
    Unsupported,
}

/// Inspect `root` and return a compatibility report. Never fails hard — an
/// unreadable or non-project folder comes back as `Unsupported` with reasons.
pub fn detect(root: &str) -> ProjectInfo {
    let root_path = PathBuf::from(root);
    let name = root_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let pkg_path = root_path.join("package.json");
    let pkg = read_package_json(&pkg_path);

    let package_manager = detect_package_manager(&root_path);
    let framework = detect_framework(&root_path, pkg.as_ref());
    let has_tailwind = detect_tailwind(&root_path, pkg.as_ref());
    let has_typescript = root_path.join("tsconfig.json").exists()
        || dep_present(pkg.as_ref(), "typescript");
    let has_git = root_path.join(".git").exists();
    let dev_script = pkg
        .as_ref()
        .and_then(|p| p.scripts.get("dev").cloned())
        .or_else(|| pkg.as_ref().and_then(|p| p.scripts.get("start").cloned()));

    let mut warnings = Vec::new();
    if pkg.is_none() {
        warnings.push("No package.json found — this doesn't look like a JS project.".into());
    }
    if framework == Framework::Unknown {
        warnings.push("Couldn't detect Vite or Next.js. Only these are supported in the MVP.".into());
    }
    // Next.js is supported, but element tagging depends on one line in the
    // project's own next.config — Next has no `--config` flag, so dedup can't
    // wrap it invisibly the way it does Vite. The card says which of the two
    // situations this project is in rather than a blanket "partial".
    let next_ready = if framework == Framework::Next {
        match crate::instrument::inspect_next_config(root) {
            crate::instrument::NextStatus::Wired { config, needs_webpack } => {
                let bundler = if needs_webpack {
                    " dedup runs the dev server under webpack, since Turbopack doesn't run the hook it tags through."
                } else {
                    ""
                };
                warnings.push(format!(
                    "Next.js: element inspection is enabled via {config}.{bundler} Isolated component previews stay Vite-only — Next can't serve the harness route."
                ));
                true
            }
            crate::instrument::NextStatus::Offered { config, needs_webpack, .. } => {
                let bundler = if needs_webpack {
                    " dedup will run the dev server under webpack while inspecting."
                } else {
                    ""
                };
                warnings.push(format!(
                    "Next.js: element inspection needs one line in {config}.{bundler} dedup shows you the exact change once the project is open — it's committed and undoable, and inert outside dedup."
                ));
                false
            }
            crate::instrument::NextStatus::Unavailable { reason } => {
                warnings.push(format!(
                    "Next.js: canvas, routes and the duplicate scan work, but element inspection is unavailable — {reason}."
                ));
                false
            }
        }
    } else {
        true
    };
    if !has_tailwind {
        warnings.push("Tailwind CSS not detected. The inspector edits Tailwind classes only.".into());
    }
    if !has_typescript {
        warnings.push("TypeScript not detected. The safety gate relies on `tsc` typechecking.".into());
    }
    if dev_script.is_none() && pkg.is_some() {
        warnings.push("No `dev` or `start` script found. You'll need to set a custom command.".into());
    }
    if !has_git {
        warnings.push("No git repository. dedup's safety model requires git for write operations.".into());
    }

    let support = if pkg.is_none() || framework == Framework::Unknown || dev_script.is_none() {
        SupportLevel::Unsupported
    } else if !has_tailwind || !has_typescript || !has_git || !next_ready {
        SupportLevel::Partial
    } else {
        SupportLevel::Full
    };

    let summary = build_summary(
        framework,
        has_tailwind,
        has_typescript,
        package_manager,
        support,
    );

    ProjectInfo {
        root: root.to_string(),
        name,
        package_manager,
        framework,
        has_tailwind,
        has_typescript,
        has_git,
        dev_script,
        support,
        summary,
        warnings,
    }
}

fn build_summary(
    framework: Framework,
    tailwind: bool,
    ts: bool,
    pm: PackageManager,
    support: SupportLevel,
) -> String {
    if support == SupportLevel::Unsupported {
        return "Unsupported project — see details below.".to_string();
    }
    let fw = match framework {
        Framework::Vite => "Vite",
        Framework::Next => "Next.js",
        Framework::Unknown => "Unknown",
    };
    let mut parts = vec![fw.to_string()];
    if tailwind {
        parts.push("Tailwind".into());
    }
    if ts {
        parts.push("TS".into());
    }
    parts.push(pm.label().to_string());
    let tail = if support == SupportLevel::Full {
        "fully supported"
    } else {
        "partially supported"
    };
    format!("{} — {}", parts.join(" + "), tail)
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    #[serde(default)]
    scripts: std::collections::HashMap<String, String>,
    #[serde(default)]
    dependencies: std::collections::HashMap<String, String>,
    #[serde(rename = "devDependencies", default)]
    dev_dependencies: std::collections::HashMap<String, String>,
}

fn read_package_json(path: &Path) -> Option<PackageJson> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn dep_present(pkg: Option<&PackageJson>, name: &str) -> bool {
    match pkg {
        Some(p) => p.dependencies.contains_key(name) || p.dev_dependencies.contains_key(name),
        None => false,
    }
}

fn detect_package_manager(root: &Path) -> PackageManager {
    if root.join("pnpm-lock.yaml").exists() {
        PackageManager::Pnpm
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        PackageManager::Bun
    } else if root.join("yarn.lock").exists() {
        PackageManager::Yarn
    } else if root.join("package-lock.json").exists() {
        PackageManager::Npm
    } else {
        PackageManager::Unknown
    }
}

fn detect_framework(root: &Path, pkg: Option<&PackageJson>) -> Framework {
    if dep_present(pkg, "next")
        || root.join("next.config.js").exists()
        || root.join("next.config.mjs").exists()
        || root.join("next.config.ts").exists()
    {
        return Framework::Next;
    }
    if dep_present(pkg, "vite")
        || root.join("vite.config.ts").exists()
        || root.join("vite.config.js").exists()
        || root.join("vite.config.mjs").exists()
    {
        return Framework::Vite;
    }
    Framework::Unknown
}

fn detect_tailwind(root: &Path, pkg: Option<&PackageJson>) -> bool {
    dep_present(pkg, "tailwindcss")
        || root.join("tailwind.config.js").exists()
        || root.join("tailwind.config.ts").exists()
        || root.join("tailwind.config.cjs").exists()
        || root.join("tailwind.config.mjs").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, contents: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let mut base = std::env::temp_dir();
        base.push(format!("dedup-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn detects_vite_react_tailwind_ts() {
        let dir = temp_dir("vite");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"vite"},"devDependencies":{"vite":"^5","tailwindcss":"^3","typescript":"^5"}}"#,
        );
        write(&dir, "pnpm-lock.yaml", "");
        write(&dir, "tsconfig.json", "{}");

        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Vite);
        assert!(info.has_tailwind);
        assert!(info.has_typescript);
        assert_eq!(info.package_manager, PackageManager::Pnpm);
        assert_eq!(info.dev_script.as_deref(), Some("vite"));
        // No git in the temp dir -> at most Partial.
        assert_eq!(info.support, SupportLevel::Partial);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A wired next.config is not a "partial" project — and an unwired one
    /// must say what to do rather than that the feature doesn't exist.
    #[test]
    fn next_verdict_follows_the_config() {
        let dir = std::env::temp_dir().join(format!("dedup-next-verdict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"dev":"next dev"},"dependencies":{"next":"14"},"devDependencies":{"tailwindcss":"^3","typescript":"^5"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        let root = dir.to_str().unwrap();

        // No config at all: supported, but inspection is unavailable and says why.
        let bare = detect(root);
        assert_eq!(bare.support, SupportLevel::Partial);
        assert!(
            bare.warnings.iter().any(|w| w.contains("no next.config")),
            "{:?}",
            bare.warnings
        );

        // A config dedup could wrap: the card offers the change.
        std::fs::write(dir.join("next.config.mjs"), "export default {};\n").unwrap();
        let offered = detect(root);
        assert_eq!(offered.support, SupportLevel::Partial);
        assert!(
            offered.warnings.iter().any(|w| w.contains("one line in next.config.mjs")),
            "{:?}",
            offered.warnings
        );

        // Already wired: nothing about Next holds it back any more.
        std::fs::write(
            dir.join("next.config.mjs"),
            "import { withDedup } from \"./node_modules/.dedup/next.mjs\";\nexport default withDedup({});\n",
        )
        .unwrap();
        let wired = detect(root);
        assert_eq!(wired.support, SupportLevel::Full, "{:?}", wired.warnings);
        assert!(
            wired.warnings.iter().any(|w| w.contains("enabled via next.config.mjs")),
            "{:?}",
            wired.warnings
        );

        // The read-only probe must not have created anything.
        assert!(
            !dir.join("node_modules").exists(),
            "the compatibility card must not write into the project"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_next_project() {
        let dir = temp_dir("next");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"next dev"},"dependencies":{"next":"14"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Next);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unsupported_without_package_json() {
        let dir = temp_dir("empty");
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.support, SupportLevel::Unsupported);
        assert_eq!(info.framework, Framework::Unknown);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unsupported_when_no_dev_script() {
        let dir = temp_dir("noscript");
        write(
            &dir,
            "package.json",
            r#"{"dependencies":{"vite":"^5"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        // Vite present but no runnable dev script -> we can't drive it.
        assert_eq!(info.support, SupportLevel::Unsupported);
        std::fs::remove_dir_all(&dir).ok();
    }
}
