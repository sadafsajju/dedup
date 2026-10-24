//! Project detection (FR-1.2): given a folder, work out package manager,
//! framework, and whether Tailwind / TypeScript are present, then produce a
//! human-readable compatibility summary the launch screen can show before load.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Every spelling of a Vite config file. Shared with `instrument::find_vite_config`
/// so detection and instrumentation can't disagree about what a Vite project
/// looks like: a project detected as Vite whose config this list misses is
/// classified `Static` instead and served as raw HTML, and one instrumented
/// against a config detection never saw is tagged for a project the card said
/// wasn't Vite. Same rule as jsxwalk — one list, never forked.
pub const VITE_CONFIG_NAMES: [&str; 6] = [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.mts",
    "vite.config.cjs",
    "vite.config.cts",
];

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
    /// True when the folder holds nothing to open — the launch screen offers
    /// to scaffold a starter into it instead of a compatibility verdict.
    pub is_empty: bool,
    /// For a static site whose pages don't sit at the root (`site/`, `www/`,
    /// `public/`), the folder the dev server serves — relative to `root`.
    /// Element ids stay relative to `root` regardless, so one project has one
    /// path vocabulary.
    pub static_dir: Option<String>,
    /// The *body* of the script we'll run to start the dev server, if we found
    /// one — what `instrument::setup` inspects to decide whether it can rewrite
    /// the launch.
    pub dev_script: Option<String>,
    /// The script's *name* (`dev` or `start`). Carried separately because the
    /// two are not interchangeable: detection accepts either name, so a project
    /// with only `start` must be launched as `start`. Running a hardcoded `dev`
    /// against it reports the project as supported and then fails on a script
    /// that isn't there.
    pub dev_script_name: Option<String>,
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
    /// A plain HTML site: no build step, no package manager. dedup serves it
    /// itself and stamps the served markup — the file *is* the source, so the
    /// element↔source mapping is 1:1 rather than compiled.
    Static,
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

/// Entries that don't count as content: a folder holding only these is one
/// the user just made, not a project they want opened read-only.
const IGNORABLE: [&str; 6] = [
    ".git",
    ".DS_Store",
    ".idea",
    ".vscode",
    "Thumbs.db",
    ".gitkeep",
];

/// True when there is nothing here to open. A fresh `git init` counts as
/// empty: the repo is dedup's safety model, not the user's work.
fn is_empty_folder(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false; // unreadable is a different problem, reported as unsupported
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !IGNORABLE.contains(&name.as_ref()) {
            return false;
        }
    }
    true
}

/// Folders a hand-built site's pages commonly live in, in the order we'd
/// guess. `""` (the project root) is tried first.
const STATIC_DIRS: [&str; 6] = ["", "public", "site", "www", "docs", "src"];

/// Where this project's static pages are, relative to the root — `Some("")`
/// for the root itself — or None when there is no HTML site here.
///
/// An `index.html` anywhere in `STATIC_DIRS` wins; failing that, the first of
/// them holding any `.html` page. A site need not have an index — a page
/// exported from a design tool is one `Main.dc.html` — and static route
/// discovery already makes every page its own route, so requiring the index
/// only turned such a folder away.
fn find_static_dir(root: &Path) -> Option<String> {
    let has_page = |dir: &Path| {
        std::fs::read_dir(dir).is_ok_and(|entries| {
            entries.flatten().any(|e| {
                e.path().extension().is_some_and(|x| x == "html")
                    && e.file_type().is_ok_and(|t| t.is_file())
            })
        })
    };
    STATIC_DIRS
        .iter()
        .find(|d| root.join(d).join("index.html").exists())
        .or_else(|| STATIC_DIRS.iter().find(|d| has_page(&root.join(d))))
        .map(|d| d.to_string())
}

/// Tailwind in a site with no package manager: the Play CDN, or a stylesheet
/// that was built from it. Read from the pages themselves, since there is no
/// dependency list to consult.
fn detect_static_tailwind(root: &Path, dir: &str) -> bool {
    let base = root.join(dir);
    let Ok(entries) = std::fs::read_dir(&base) else {
        return false;
    };
    for entry in entries.flatten().take(200) {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "html" | "htm" | "css") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        // Only look at the head of a stylesheet — a compiled Tailwind build is
        // megabytes, and its banner is in the first few lines.
        let head: String = text.chars().take(8192).collect();
        if head.contains("tailwindcss") || head.contains("@tailwind") {
            return true;
        }
    }
    false
}

/// Inspect `root` and return a compatibility report. Never fails hard — an
/// unreadable or non-project folder comes back as `Unsupported` with reasons.
pub fn detect(root: &str) -> ProjectInfo {
    let root_path = PathBuf::from(root);
    let name = root_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());
    let has_git = root_path.join(".git").exists();

    // An empty folder isn't an unsupported project — it's a project that
    // doesn't exist yet, and the launch screen offers to start one. Answered
    // before anything else so no detection heuristic gets to call it a
    // failure.
    if is_empty_folder(&root_path) {
        return ProjectInfo {
            root: root.to_string(),
            name,
            package_manager: detect_package_manager(&root_path),
            framework: Framework::Unknown,
            has_tailwind: false,
            has_typescript: false,
            has_git,
            is_empty: true,
            static_dir: None,
            dev_script: None,
            dev_script_name: None,
            support: SupportLevel::Unsupported,
            summary: "Empty folder — pick something to start here.".to_string(),
            warnings: Vec::new(),
        };
    }

    let pkg_path = root_path.join("package.json");
    let pkg = read_package_json(&pkg_path);

    let package_manager = detect_package_manager(&root_path);
    let framework = detect_framework(&root_path, pkg.as_ref());

    // A plain HTML site takes a different route through everything: dedup
    // serves it, so there is no dev script to find, no package manager to
    // drive, and no typecheck to gate on. Reported on its own terms rather
    // than as a JS project missing most of its parts.
    if framework == Framework::Static {
        let dir = find_static_dir(&root_path).unwrap_or_default();
        let has_tailwind = detect_static_tailwind(&root_path, &dir);
        let mut warnings = Vec::new();
        if !dir.is_empty() {
            warnings.push(format!(
                "Pages found in `{dir}/` — dedup serves that folder as the site root."
            ));
        }
        if !has_tailwind {
            warnings.push(
                "No Tailwind in this site. Inspection, text and structure edits work as \
                 normal, but the Style panel writes Tailwind classes, which won't render \
                 until Tailwind is on the page."
                    .into(),
            );
        }
        warnings.push(
            "Duplicate detection reads React components, so the Scan tab is off for a \
             static site. Everything else on the canvas works."
                .into(),
        );
        warnings.push(
            "No typecheck or build script to run, so those safety gates report `skipped` \
             rather than passed."
                .into(),
        );
        if !has_git {
            warnings.push(
                "No git repository. dedup's safety model requires git to save — the editor can set one up (top bar → Set up git)."
                    .into(),
            );
        }
        let support = if has_git {
            SupportLevel::Full
        } else {
            SupportLevel::Partial
        };
        let summary = format!(
            "Static HTML{} — {}",
            if has_tailwind { " + Tailwind" } else { "" },
            if support == SupportLevel::Full {
                "dedup serves and edits it directly"
            } else {
                "partially supported"
            },
        );
        return ProjectInfo {
            root: root.to_string(),
            name,
            package_manager,
            framework,
            has_tailwind,
            has_typescript: false,
            has_git,
            is_empty: false,
            static_dir: (!dir.is_empty()).then_some(dir),
            dev_script: None,
            dev_script_name: None,
            support,
            summary,
            warnings,
        };
    }

    let has_tailwind = detect_tailwind(&root_path, pkg.as_ref());
    let has_typescript = root_path.join("tsconfig.json").exists()
        || dep_present(pkg.as_ref(), "typescript");
    // Name and body together: `start` is accepted as a dev script, so the name
    // has to travel with it or the launch runs a `dev` that doesn't exist.
    let (dev_script_name, dev_script) = pkg
        .as_ref()
        .and_then(|p| {
            ["dev", "start"]
                .iter()
                .find_map(|n| p.scripts.get(*n).map(|s| (n.to_string(), s.clone())))
        })
        .map(|(n, s)| (Some(n), Some(s)))
        .unwrap_or((None, None));

    // A Vite project with no script at all is still drivable when its own vite
    // binary is present: `instrument::setup` defaults the script to a bare
    // `vite` and spawns that binary directly, with no package manager in the
    // loop. Calling it unsupported forces the user into a custom command, and
    // a custom command is the one launch path that skips instrumentation — so
    // the verdict would cost them the tagging it was wrong about.
    let vite_direct = framework == Framework::Vite
        && dev_script.is_none()
        && root_path.join("node_modules/.bin/vite").exists();

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
        warnings.push(if vite_direct {
            "No `dev` or `start` script found. dedup runs this project's own \
             `node_modules/.bin/vite` directly, so inspection still works."
                .into()
        } else {
            "No `dev` or `start` script found. You'll need to set a custom command.".to_string()
        });
    }
    if !has_git {
        warnings.push("No git repository. dedup's safety model requires git to save — the editor can set one up (top bar → Set up git).".into());
    }

    let support = if pkg.is_none()
        || framework == Framework::Unknown
        || (dev_script.is_none() && !vite_direct)
    {
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
        is_empty: false,
        static_dir: None,
        dev_script,
        dev_script_name,
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
        Framework::Static => "Static HTML",
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
        || VITE_CONFIG_NAMES.iter().any(|c| root.join(c).exists())
    {
        return Framework::Vite;
    }
    // Last, and only last: a folder with pages but no bundler is a site dedup
    // can serve itself. Checked after Vite and Next so their own index.html
    // never gets mistaken for one.
    if find_static_dir(root).is_some() {
        return Framework::Static;
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

    /// An empty folder is not a failed project — it is a project that does
    /// not exist yet, and the launch screen offers to start one.
    #[test]
    fn an_empty_folder_reports_itself_as_empty_not_as_a_failure() {
        let dir = temp_dir("blank");
        let info = detect(dir.to_str().unwrap());
        assert!(info.is_empty);
        assert!(info.warnings.is_empty(), "nothing is wrong with an empty folder");

        // A fresh `git init` is still empty: the repo is dedup's safety model,
        // not the user's work.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".DS_Store"), "").unwrap();
        assert!(detect(dir.to_str().unwrap()).is_empty);

        // One real file and it is a project to be judged on its merits.
        write(&dir, "notes.md", "mine");
        assert!(!detect(dir.to_str().unwrap()).is_empty);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_a_plain_html_site() {
        let dir = temp_dir("site");
        write(&dir, "index.html", "<h1>hi</h1>");
        write(&dir, "style.css", "body{}");
        std::fs::create_dir_all(dir.join(".git")).unwrap();

        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Static);
        assert!(!info.is_empty);
        assert_eq!(info.static_dir, None, "pages at the root need no subfolder");
        assert_eq!(info.support, SupportLevel::Full);
        assert!(info.summary.starts_with("Static HTML"), "{}", info.summary);
        // TypeScript's absence is not a complaint to make about a static site.
        assert!(
            !info.warnings.iter().any(|w| w.contains("TypeScript")),
            "{:?}",
            info.warnings
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_pages_in_a_subfolder_and_says_so() {
        let dir = temp_dir("subsite");
        std::fs::create_dir_all(dir.join("www")).unwrap();
        std::fs::write(dir.join("www/index.html"), "<h1>hi</h1>").unwrap();

        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Static);
        assert_eq!(info.static_dir.as_deref(), Some("www"));
        assert!(
            info.warnings.iter().any(|w| w.contains("`www/`")),
            "{:?}",
            info.warnings
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A page exported from a design tool has no index.html — one named page
    /// plus its runtime. It is still a site; turning it away as "no
    /// package.json" was the verdict for a JS project it never claimed to be.
    #[test]
    fn a_site_without_an_index_is_still_a_site() {
        let dir = temp_dir("noindex");
        write(&dir, "Main.dc.html", "<x-dc><h1>hi</h1></x-dc>");
        write(&dir, "support.js", "");
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join("vendor/react.js"), "").unwrap();

        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Static);
        assert_ne!(info.support, SupportLevel::Unsupported);
        assert_eq!(info.static_dir, None, "the page is at the root");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The fallback never outranks an index: a stray page at the root does not
    /// move the site root away from the folder that has one.
    #[test]
    fn an_index_still_decides_where_the_site_is() {
        let dir = temp_dir("strayroot");
        write(&dir, "draft.html", "<h1>old</h1>");
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(dir.join("site/index.html"), "<h1>hi</h1>").unwrap();

        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.static_dir.as_deref(), Some("site"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The Play CDN is how a hand-written page gets Tailwind, and it is the
    /// difference between the Style panel doing something and doing nothing.
    #[test]
    fn reads_tailwind_off_the_page_when_there_is_no_dependency_list() {
        let dir = temp_dir("cdnsite");
        write(
            &dir,
            "index.html",
            "<script src=\"https://cdn.tailwindcss.com\"></script><h1 class=\"p-4\">hi</h1>",
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Static);
        assert!(info.has_tailwind);
        assert!(
            !info.warnings.iter().any(|w| w.contains("No Tailwind")),
            "{:?}",
            info.warnings
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A Vite project has an index.html too. Static detection must never win
    /// that race, or every React app would be served as flat files.
    #[test]
    fn a_vite_projects_index_html_is_not_a_static_site() {
        let dir = temp_dir("viteindex");
        write(&dir, "index.html", "<div id=\"root\"></div>");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"vite"},"devDependencies":{"vite":"^5"}}"#,
        );
        assert_eq!(detect(dir.to_str().unwrap()).framework, Framework::Vite);
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
        // Vite in the dependency list but nothing to run it with: no script,
        // and no installed binary to spawn directly either.
        assert_eq!(info.support, SupportLevel::Unsupported);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `.mts` is how a Vite config is spelled in an ESM-strict monorepo
    /// (excalidraw, among others). Detection used to miss it, and since a Vite
    /// project also has an index.html, the folder fell through to the static
    /// branch and would have been served as flat files — with the raw template
    /// tags of an unbuilt index.html rendered as text.
    #[test]
    fn a_vite_config_dot_mts_is_a_vite_project_not_a_static_site() {
        let dir = temp_dir("mtsconfig");
        write(&dir, "index.html", "<div id=\"root\"></div>");
        write(&dir, "package.json", r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir, "vite.config.mts", "export default {}");
        assert_eq!(detect(dir.to_str().unwrap()).framework, Framework::Vite);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Detection accepts `start` when there is no `dev`, so the name has to
    /// travel with the body — launching a hardcoded `dev` against a project
    /// that only has `start` fails *after* the card called it supported.
    #[test]
    fn a_start_only_project_reports_the_script_it_is_launched_by() {
        let dir = temp_dir("startonly");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"start":"vite --port 3001"},"devDependencies":{"vite":"^5"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.dev_script_name.as_deref(), Some("start"));
        assert_eq!(info.dev_script.as_deref(), Some("vite --port 3001"));
        assert_ne!(info.support, SupportLevel::Unsupported);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_dev_script_wins_over_start() {
        let dir = temp_dir("bothscripts");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"start":"serve build","dev":"vite"},"devDependencies":{"vite":"^5"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.dev_script_name.as_deref(), Some("dev"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The trap this pairs with: calling a script-less Vite project
    /// unsupported forces the user into a custom dev command, and a custom
    /// command is the one launch path that skips instrumentation. The verdict
    /// would have cost them the tagging it was wrong about.
    #[test]
    fn no_script_is_still_openable_when_the_vite_binary_is_installed() {
        let dir = temp_dir("vitedirect");
        write(&dir, "package.json", r#"{"devDependencies":{"vite":"^5"}}"#);
        std::fs::create_dir_all(dir.join("node_modules/.bin")).unwrap();
        write(&dir, "node_modules/.bin/vite", "#!/bin/sh\n");

        let info = detect(dir.to_str().unwrap());
        assert!(info.dev_script.is_none());
        assert_ne!(
            info.support,
            SupportLevel::Unsupported,
            "{:?}",
            info.warnings
        );
        assert!(
            info.warnings.iter().any(|w| w.contains("node_modules/.bin/vite")),
            "the card must say what it will run instead: {:?}",
            info.warnings
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
