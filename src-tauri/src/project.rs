//! Project detection (FR-1.2): given a folder, work out what it is and how to
//! start it — package manager, framework, Tailwind / TypeScript — and describe
//! it in plain words.
//!
//! There is no verdict here. Detection used to grade a project full / partial /
//! unsupported and the launch screen showed the grade before opening; a folder
//! dedup had no tagger for was turned away at the door. Now every folder opens:
//! dedup runs whatever server the project has and shows it on the canvas, and
//! what it cannot do for *this* project (element inspection needs a tagger) is
//! said inside the editor, next to the thing that is unavailable, by the
//! instrumentation event. The one question detection can still leave open is
//! "how do I start this?" — `runnable` — and that is a question, not a grade.

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
    /// What this project is, in the words its author would use ("Astro",
    /// "Django", "Create React App"). `framework` is how dedup *drives* it and
    /// has four values; this is what it is called and has many.
    pub stack: String,
    pub has_tailwind: bool,
    pub has_typescript: bool,
    pub has_git: bool,
    /// True when the folder holds nothing to open — the launch screen offers
    /// to scaffold a starter into it.
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
    /// The script's *name* (`dev`, `start`, …). Carried separately because
    /// they are not interchangeable: detection accepts several names, so a
    /// project with only `start` must be launched as `start`.
    pub dev_script_name: Option<String>,
    /// For a project with no package script to run — a Django, Rails, Laravel,
    /// Hugo… app — the shell command that starts its dev server. When set it
    /// is *the* way this project starts (`dev_script` is cleared), so the
    /// launch never has two answers to choose between.
    pub run_command: Option<String>,
    /// False when dedup found no way to start this project. The only thing
    /// left that makes the launch screen stop and ask — and what it asks is
    /// "what command starts it?", never "are you sure?".
    pub runnable: bool,
    /// One line describing the project ("Astro + Tailwind + TS + pnpm").
    pub summary: String,
    /// Things worth knowing about how dedup will handle this project. Shown
    /// in project details; none of them stops it opening.
    pub notes: Vec<String>,
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

/// How dedup drives a project — not what the project is called (`stack`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Framework {
    Vite,
    Next,
    /// A plain HTML site: no build step, no package manager. dedup serves it
    /// itself and stamps the served markup — the file *is* the source, so the
    /// element↔source mapping is 1:1 rather than compiled.
    Static,
    /// Everything else. dedup runs the project's own server exactly as
    /// written and shows it on the canvas; there is no tagger for it, so the
    /// editor reports element inspection as off and says why.
    Unknown,
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
        return false; // unreadable is a different problem
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

/// Script names that start a dev server, in the order we'd pick. `dev` first:
/// in a Next project `start` is the *production* server.
const DEV_SCRIPTS: [&str; 5] = ["dev", "start", "develop", "serve", "storybook"];

/// Dependencies that mean "this project has a dev server of its own", and
/// what to call it. With one of these and a script to run, the project's
/// server wins over dedup's static one even when there are `.html` files
/// lying around — Create React App's `public/index.html` is a template, and
/// serving it as a flat page shows an empty `<div id="root">`.
const SERVER_STACKS: [(&str, &str); 17] = [
    ("astro", "Astro"),
    ("@remix-run/dev", "Remix"),
    ("@react-router/dev", "React Router"),
    ("nuxt", "Nuxt"),
    ("@sveltejs/kit", "SvelteKit"),
    ("gatsby", "Gatsby"),
    ("react-scripts", "Create React App"),
    ("@angular/core", "Angular"),
    ("@vue/cli-service", "Vue CLI"),
    ("@docusaurus/core", "Docusaurus"),
    ("@11ty/eleventy", "Eleventy"),
    ("vitepress", "VitePress"),
    ("expo", "Expo"),
    ("parcel", "Parcel"),
    ("@rsbuild/core", "Rsbuild"),
    ("@rspack/core", "Rspack"),
    ("webpack-dev-server", "webpack"),
];

/// UI libraries — a name for the project, never a reason to run it one way
/// or another.
const UI_LIBS: [(&str, &str); 6] = [
    ("vue", "Vue"),
    ("svelte", "Svelte"),
    ("solid-js", "Solid"),
    ("preact", "Preact"),
    ("@builder.io/qwik", "Qwik"),
    ("react", "React"),
];

fn server_stack(pkg: Option<&PackageJson>) -> Option<&'static str> {
    SERVER_STACKS
        .iter()
        .find(|(dep, _)| dep_present(pkg, dep))
        .map(|(_, label)| *label)
}

fn ui_lib(pkg: Option<&PackageJson>) -> Option<&'static str> {
    UI_LIBS
        .iter()
        .find(|(dep, _)| dep_present(pkg, dep))
        .map(|(_, label)| *label)
}

/// A project whose dev server is not a package script: the app is Python,
/// Ruby, PHP, Go templates… and the browser talks to *that*.
struct Backend {
    stack: &'static str,
    /// None when the project is recognised but has nothing a browser can
    /// load — a native app, or React Native with no web target.
    command: Option<String>,
    /// Something specific to say about this kind of project.
    note: Option<String>,
}

/// True when the first 64KB of `path` contain `needle`. Enough to recognise
/// an entry point by what it constructs without reading a whole module.
fn file_mentions(path: &Path, needle: &str) -> bool {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = String::new();
    let _ = file.take(64 * 1024).read_to_string(&mut head);
    head.contains(needle)
}

/// How this project runs Python. A project's own environment first — the
/// system `python3` does not have its dependencies, so guessing it for a
/// project with a virtualenv starts a server that dies on the first import.
fn python_runner(root: &Path) -> String {
    for venv in [".venv", "venv", "env"] {
        if root.join(venv).join("bin/python").exists() {
            return format!("{venv}/bin/python");
        }
    }
    if root.join("uv.lock").exists() {
        "uv run python".into()
    } else if root.join("poetry.lock").exists() {
        "poetry run python".into()
    } else if root.join("Pipfile").exists() {
        "pipenv run python".into()
    } else {
        "python3".into()
    }
}

/// Recognise a backend-rendered project by the file its own tooling requires,
/// and name the command its own docs give for a dev server. Checked before
/// any JS heuristic: a Laravel app has a `vite` dependency and a Rails app a
/// `public/404.html`, and neither is a Vite project or a static site — the
/// page the user wants on the canvas comes from the app server.
fn detect_backend(root: &Path, pkg: Option<&PackageJson>) -> Option<Backend> {
    let has = |p: &str| root.join(p).exists();
    let backend = |stack, command: String| {
        Some(Backend { stack, command: Some(command), note: None })
    };

    if has("manage.py") {
        return backend("Django", format!("{} manage.py runserver", python_runner(root)));
    }
    if has("artisan") {
        return backend("Laravel", "php artisan serve".into());
    }
    if has("bin/rails") || (has("Gemfile") && has("config/application.rb")) {
        // `bin/dev` runs the app *and* its asset watchers. Not when the assets
        // are Vite's, though: its dev server prints a URL too, and whichever
        // line arrives first is the one the canvas would load.
        let command = if has("bin/dev") && !dep_present(pkg, "vite") {
            "bin/dev"
        } else {
            "bin/rails server"
        };
        return backend("Rails", command.into());
    }
    if file_mentions(&root.join("mix.exs"), ":phoenix") {
        return backend("Phoenix", "mix phx.server".into());
    }
    let hugo_named = ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json"]
        .iter()
        .any(|c| has(c));
    let hugo_legacy = (has("config.toml") || has("config.yaml"))
        && has("content")
        && (has("themes") || has("layouts") || has("archetypes"));
    if hugo_named || hugo_legacy {
        return backend("Hugo", "hugo server".into());
    }
    if has("_config.yml") || has("_config.yaml") {
        let command = if has("Gemfile") {
            "bundle exec jekyll serve"
        } else {
            "jekyll serve"
        };
        return backend("Jekyll", command.into());
    }
    if has("mkdocs.yml") || has("mkdocs.yaml") {
        return backend("MkDocs", "mkdocs serve".into());
    }
    if file_mentions(&root.join("main.py"), "FastAPI(") {
        return backend(
            "FastAPI",
            format!("{} -m uvicorn main:app --reload", python_runner(root)),
        );
    }
    if file_mentions(&root.join("app.py"), "Flask(") || file_mentions(&root.join("wsgi.py"), "Flask(") {
        return backend("Flask", format!("{} -m flask run", python_runner(root)));
    }
    detect_mobile(root, pkg)
}

/// A mobile app. dedup's canvas is a browser, so what it can show is the
/// app's *web build* — which Expo and Flutter have, bare React Native has
/// only if the project set one up, and a Swift or Kotlin app does not have at
/// all. Each is named for what it is and told the truth about which of those
/// it is, rather than run by a `start` script that boots Metro and never
/// prints an address a browser can open.
fn detect_mobile(root: &Path, pkg: Option<&PackageJson>) -> Option<Backend> {
    let has = |p: &str| root.join(p).exists();
    let pm = detect_package_manager(root).label();
    // A `web` script is the project's own answer to "how does this run in a
    // browser", so it outranks anything dedup would guess.
    let web_script = pkg.and_then(|p| p.scripts.get("web")).map(|_| format!("{pm} run web"));

    if dep_present(pkg, "expo") {
        let note = (!dep_present(pkg, "react-native-web")).then(|| {
            "This Expo app has no web target yet, so there is nothing for the canvas to load. \
             Add one with `npx expo install react-native-web react-dom @expo/metro-runtime`."
                .to_string()
        });
        return Some(Backend {
            stack: "Expo",
            command: Some(web_script.unwrap_or_else(|| "npx expo start --web".into())),
            note: Some(format!(
                "dedup shows this app's web build (react-native-web) — the same components, \
                 rendered by a browser rather than by iOS or Android, so native-only modules \
                 and platform styling won't match a device exactly.{}",
                note.map(|n| format!(" {n}")).unwrap_or_default()
            )),
        });
    }
    if dep_present(pkg, "react-native") {
        return Some(Backend {
            stack: "React Native",
            note: Some(if web_script.is_some() {
                "dedup shows this app's web build, through its `web` script — rendered by a \
                 browser rather than by iOS or Android."
                    .into()
            } else {
                "A React Native app with no web target: it renders only on a device or \
                 simulator, and dedup's canvas is a browser. Adding react-native-web (or \
                 Expo) gives it one; then put the command that serves it here."
                    .into()
            }),
            command: web_script,
        });
    }
    if file_mentions(&root.join("pubspec.yaml"), "flutter:") {
        return Some(Backend {
            stack: "Flutter",
            command: Some("flutter run -d web-server".into()),
            note: Some(if has("web") {
                "dedup shows this app's web build. Flutter paints the page itself rather \
                 than building it from HTML elements, so it is a live preview — there are \
                 no elements to select."
                    .into()
            } else {
                "This Flutter app has no web target yet, so there is nothing for the canvas \
                 to load. Add one with `flutter create --platforms web .`."
                    .into()
            }),
        });
    }

    // Swift / Kotlin with no web anything. Only at the root: React Native and
    // Flutter keep theirs in `ios/` and `android/`, and were answered above.
    let root_has_ext = |exts: [&str; 2]| {
        std::fs::read_dir(root).is_ok_and(|entries| {
            entries.flatten().any(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| exts.contains(&x))
            })
        })
    };
    let native = if root_has_ext(["xcodeproj", "xcworkspace"]) {
        Some("iOS app")
    } else if pkg.is_none()
        && (has("settings.gradle") || has("settings.gradle.kts"))
        && (has("app/src/main/AndroidManifest.xml") || has("gradlew"))
    {
        Some("Android app")
    } else {
        None
    };
    native.map(|stack| Backend {
        stack,
        command: None,
        note: Some(
            "A native app has no web build, and dedup's canvas is a browser — it can't \
             render Swift or Kotlin screens. If this project also serves a web version, \
             give dedup the command that starts it."
                .into(),
        ),
    })
}

/// Markers of a workspace root: the app lives in a subfolder, and that folder
/// is the one dedup can tag.
fn is_workspace_root(root: &Path, pkg: Option<&PackageJson>) -> bool {
    pkg.is_some_and(|p| p.workspaces.is_some())
        || ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"]
            .iter()
            .any(|f| root.join(f).exists())
}

const NO_GIT: &str = "No git repository. dedup's safety model requires git to save — the editor can set one up (top bar → Set up git).";

/// Inspect `root` and describe it. Never fails and never refuses: a folder
/// dedup cannot start on its own comes back with `runnable: false` and a note
/// saying what it looked for.
pub fn detect(root: &str) -> ProjectInfo {
    let root_path = PathBuf::from(root);
    let name = root_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());
    let has_git = root_path.join(".git").exists();

    // An empty folder is a project that doesn't exist yet, and the launch
    // screen offers to start one. Answered before anything else so no
    // detection heuristic gets a say.
    if is_empty_folder(&root_path) {
        return ProjectInfo {
            root: root.to_string(),
            name,
            package_manager: detect_package_manager(&root_path),
            framework: Framework::Unknown,
            stack: "Empty folder".to_string(),
            has_tailwind: false,
            has_typescript: false,
            has_git,
            is_empty: true,
            static_dir: None,
            dev_script: None,
            dev_script_name: None,
            run_command: None,
            runnable: false,
            summary: "Empty folder — pick something to start here.".to_string(),
            notes: Vec::new(),
        };
    }

    let pkg_path = root_path.join("package.json");
    let pkg = read_package_json(&pkg_path);
    let package_manager = detect_package_manager(&root_path);

    // Name and body together: several names are accepted, so the name has to
    // travel with the body or the launch runs a `dev` that doesn't exist.
    let script = pkg.as_ref().and_then(|p| {
        DEV_SCRIPTS
            .iter()
            .find_map(|n| p.scripts.get(*n).map(|s| (n.to_string(), s.clone())))
    });

    let backend = detect_backend(&root_path, pkg.as_ref());
    let framework = if backend.is_some() {
        Framework::Unknown
    } else {
        detect_framework(&root_path, pkg.as_ref(), script.is_some())
    };

    // A plain HTML site takes a different route through everything: dedup
    // serves it, so there is no dev script to find, no package manager to
    // drive, and no typecheck to gate on. Described on its own terms rather
    // than as a JS project missing most of its parts.
    if framework == Framework::Static {
        let dir = find_static_dir(&root_path).unwrap_or_default();
        let has_tailwind = detect_static_tailwind(&root_path, &dir);
        let mut notes = Vec::new();
        if !dir.is_empty() {
            notes.push(format!(
                "Pages found in `{dir}/` — dedup serves that folder as the site root."
            ));
        }
        if !has_tailwind {
            notes.push(
                "No Tailwind in this site. Inspection, text and structure edits work as \
                 normal, but the Style panel writes Tailwind classes, which won't render \
                 until Tailwind is on the page."
                    .into(),
            );
        }
        if !has_git {
            notes.push(NO_GIT.into());
        }
        let summary = format!(
            "Static HTML{} — dedup serves and edits it directly",
            if has_tailwind { " + Tailwind" } else { "" },
        );
        return ProjectInfo {
            root: root.to_string(),
            name,
            package_manager,
            framework,
            stack: "Static HTML".to_string(),
            has_tailwind,
            has_typescript: false,
            has_git,
            is_empty: false,
            static_dir: (!dir.is_empty()).then_some(dir),
            dev_script: None,
            dev_script_name: None,
            run_command: None,
            runnable: true,
            summary,
            notes,
        };
    }

    let has_tailwind = detect_tailwind(&root_path, pkg.as_ref());
    let has_typescript = root_path.join("tsconfig.json").exists()
        || dep_present(pkg.as_ref(), "typescript");

    // A backend's own command is *the* way it starts. Its package.json, if it
    // has one, holds asset scripts — a `dev` that watches CSS prints no URL,
    // and launching it would leave the canvas waiting forever.
    let run_command = backend.as_ref().and_then(|b| b.command.clone()).or_else(|| {
        // PHP with no framework: the interpreter's built-in server.
        (framework == Framework::Unknown
            && script.is_none()
            && root_path.join("index.php").exists())
        .then(|| "php -S localhost:8000".to_string())
    });
    // A recognised backend or mobile app never falls back to a package
    // script, even with no command of its own: React Native's `start` boots
    // Metro, which serves nothing a browser can open.
    let (dev_script_name, dev_script) = match (&run_command, script) {
        (None, Some((n, s))) if backend.is_none() => (Some(n), Some(s)),
        _ => (None, None),
    };

    // A Vite project with no script at all is still drivable when its own vite
    // binary is present: `instrument::setup` defaults the script to a bare
    // `vite` and spawns that binary directly, with no package manager in the
    // loop.
    let vite_direct = framework == Framework::Vite
        && dev_script.is_none()
        && root_path.join("node_modules/.bin/vite").exists();
    let runnable = dev_script.is_some() || run_command.is_some() || vite_direct;

    let stack = match framework {
        Framework::Next => "Next.js".to_string(),
        // SvelteKit, Remix and friends are Vite underneath; say both, since
        // one is what the user calls it and the other is how dedup runs it.
        Framework::Vite => match server_stack(pkg.as_ref()).or_else(|| ui_lib(pkg.as_ref())) {
            Some("React") | None => "Vite".to_string(),
            Some(label) => format!("{label} on Vite"),
        },
        _ => backend
            .as_ref()
            .map(|b| b.stack)
            .or_else(|| server_stack(pkg.as_ref()))
            .or_else(|| ui_lib(pkg.as_ref()))
            .or_else(|| run_command.as_ref().map(|_| "PHP"))
            .unwrap_or(if pkg.is_some() { "Node" } else { "Project" })
            .to_string(),
    };

    let mut notes = Vec::new();
    // Next.js is tagged through one line in the project's own next.config —
    // Next has no `--config` flag, so dedup can't wrap it invisibly the way it
    // does Vite. Say which of the situations this project is in.
    if framework == Framework::Next {
        match crate::instrument::inspect_next_config(root) {
            crate::instrument::NextStatus::Wired { config, needs_webpack } => {
                let bundler = if needs_webpack {
                    " dedup runs the dev server under webpack, since Turbopack doesn't run the hook it tags through."
                } else {
                    ""
                };
                notes.push(format!(
                    "Next.js: element inspection is enabled via {config}.{bundler}"
                ));
            }
            crate::instrument::NextStatus::Offered { config, needs_webpack, .. } => {
                let bundler = if needs_webpack {
                    " dedup will run the dev server under webpack while inspecting."
                } else {
                    ""
                };
                notes.push(format!(
                    "Next.js: element inspection needs one line in {config}.{bundler} dedup shows you the exact change once the project is open — it's committed and undoable, and inert outside dedup."
                ));
            }
            crate::instrument::NextStatus::Unavailable { reason } => {
                notes.push(format!(
                    "Next.js: canvas and routes work, but element inspection is unavailable — {reason}."
                ));
            }
        }
    }
    if framework == Framework::Unknown {
        if runnable {
            let how = match (&run_command, &dev_script_name) {
                (Some(cmd), _) => format!("`{cmd}`"),
                (None, Some(n)) => format!("its `{n}` script"),
                (None, None) => "its dev server".to_string(),
            };
            notes.push(format!(
                "dedup starts this project with {how} and shows it on the canvas. Clicking \
                 elements to inspect and restyle them needs dedup's tagger, which exists for \
                 Vite + React, Next.js and plain HTML. Here dedup's edits go through the AI chat \
                 and the code panel, which write JS/TS, CSS and HTML files; other source \
                 (.vue, .svelte, .astro, templates, server code) it shows but does not write."
            ));
        } else if backend.as_ref().is_some_and(|b| b.note.is_some()) {
            // Recognised, and the reason it can't start is its own (below).
        } else {
            notes.push(
                "dedup couldn't tell how to start this project — no `dev` or `start` script \
                 and no framework it recognises. Give it the command you use and it will run \
                 that and show the result on the canvas."
                    .into(),
            );
        }
        if let Some(note) = backend.as_ref().and_then(|b| b.note.clone()) {
            notes.push(note);
        }
        if is_workspace_root(&root_path, pkg.as_ref()) {
            notes.push(
                "This looks like a workspace root. Opening the app's own folder instead \
                 (e.g. `apps/web`) lets dedup recognise its framework."
                    .into(),
            );
        }
    } else if !runnable {
        // Vite or Next with nothing to launch: no script, no installed binary.
        notes.push(format!(
            "No `dev` or `start` script found, and the framework's own binary isn't installed. \
             Run `{} install`, or give dedup the command you use.",
            package_manager.label()
        ));
    } else if vite_direct {
        notes.push(
            "No `dev` or `start` script found. dedup runs this project's own \
             `node_modules/.bin/vite` directly, so inspection still works."
                .into(),
        );
    }
    if pkg.as_ref().is_some_and(|p| p.has_dependencies())
        && backend.is_none()
        && !root_path.join("node_modules").exists()
    {
        notes.push(format!(
            "Dependencies aren't installed yet — run `{} install` (the console drawer has a terminal in this folder).",
            package_manager.label()
        ));
    }
    // A desktop shell around a web frontend. The frontend is what dedup shows.
    if root_path.join("src-tauri").is_dir() || dep_present(pkg.as_ref(), "@tauri-apps/api") {
        notes.push(
            "A Tauri app: dedup shows its web frontend in the canvas, without the Rust side. \
             Screens render and can be edited; anything that calls a Tauri command gets no \
             answer here, so data loaded that way will be missing."
                .into(),
        );
    }
    if matches!(framework, Framework::Vite | Framework::Next) {
        if !has_tailwind {
            notes.push("Tailwind CSS not detected. The Style panel writes Tailwind classes, which won't render without it.".into());
        }
        if !has_typescript {
            notes.push("TypeScript not detected. The safety gate relies on `tsc` typechecking.".into());
        }
    }
    if !has_git {
        notes.push(NO_GIT.into());
    }

    let summary = build_summary(&stack, has_tailwind, has_typescript, pkg.is_some().then_some(package_manager));

    ProjectInfo {
        root: root.to_string(),
        name,
        package_manager,
        framework,
        stack,
        has_tailwind,
        has_typescript,
        has_git,
        is_empty: false,
        static_dir: None,
        dev_script,
        dev_script_name,
        run_command,
        runnable,
        summary,
        notes,
    }
}

fn build_summary(stack: &str, tailwind: bool, ts: bool, pm: Option<PackageManager>) -> String {
    let mut parts = vec![stack.to_string()];
    if tailwind {
        parts.push("Tailwind".into());
    }
    if ts {
        parts.push("TS".into());
    }
    if let Some(pm) = pm {
        parts.push(pm.label().to_string());
    }
    parts.join(" + ")
}

#[derive(Debug, Deserialize)]
struct PackageJson {
    #[serde(default)]
    scripts: std::collections::HashMap<String, String>,
    #[serde(default)]
    dependencies: std::collections::HashMap<String, String>,
    #[serde(rename = "devDependencies", default)]
    dev_dependencies: std::collections::HashMap<String, String>,
    #[serde(default)]
    workspaces: Option<serde_json::Value>,
}

impl PackageJson {
    fn has_dependencies(&self) -> bool {
        !self.dependencies.is_empty() || !self.dev_dependencies.is_empty()
    }
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

fn detect_framework(root: &Path, pkg: Option<&PackageJson>, has_script: bool) -> Framework {
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
    // A framework with a dev server of its own, and a script that starts it:
    // that server is the app. Its `.html` files are templates, not pages.
    if has_script && server_stack(pkg).is_some() {
        return Framework::Unknown;
    }
    // Same for PHP: `index.php` is the site, whatever `.html` sits beside it.
    if root.join("index.php").exists() {
        return Framework::Unknown;
    }
    // A folder with pages but no bundler is a site dedup can serve itself.
    // Checked after everything that has a server of its own, so their
    // index.html never gets mistaken for one.
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
        assert!(info.runnable);
        assert_eq!(info.summary, "Vite + Tailwind + TS + pnpm");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// An unwired next.config must say what to do rather than that the
    /// feature doesn't exist — and none of the three states stops it opening.
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
        assert!(bare.runnable);
        assert!(
            bare.notes.iter().any(|w| w.contains("no next.config")),
            "{:?}",
            bare.notes
        );

        // A config dedup could wrap: the card offers the change.
        std::fs::write(dir.join("next.config.mjs"), "export default {};\n").unwrap();
        let offered = detect(root);
        assert!(offered.runnable);
        assert!(
            offered.notes.iter().any(|w| w.contains("one line in next.config.mjs")),
            "{:?}",
            offered.notes
        );

        // Already wired: nothing about Next holds it back any more.
        std::fs::write(
            dir.join("next.config.mjs"),
            "import { withDedup } from \"./node_modules/.dedup/next.mjs\";\nexport default withDedup({});\n",
        )
        .unwrap();
        let wired = detect(root);
        assert!(wired.runnable, "{:?}", wired.notes);
        assert!(
            wired.notes.iter().any(|w| w.contains("enabled via next.config.mjs")),
            "{:?}",
            wired.notes
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
        assert!(info.notes.is_empty(), "nothing is wrong with an empty folder");

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
        assert!(info.runnable);
        assert!(info.summary.starts_with("Static HTML"), "{}", info.summary);
        // TypeScript's absence is not a complaint to make about a static site.
        assert!(
            !info.notes.iter().any(|w| w.contains("TypeScript")),
            "{:?}",
            info.notes
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
            info.notes.iter().any(|w| w.contains("`www/`")),
            "{:?}",
            info.notes
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
        assert!(info.runnable);
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
            !info.notes.iter().any(|w| w.contains("No Tailwind")),
            "{:?}",
            info.notes
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

    /// A folder dedup recognises nothing in still opens — the one thing it
    /// lacks is a command, and that is asked for, not held against it.
    #[test]
    fn an_unrecognised_folder_is_asked_for_a_command_not_refused() {
        let dir = temp_dir("mystery");
        write(&dir, "main.go", "package main");
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Unknown);
        assert!(!info.runnable);
        assert!(!info.is_empty);
        assert!(
            info.notes.iter().any(|w| w.contains("command you use")),
            "{:?}",
            info.notes
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vite_without_a_script_or_a_binary_needs_a_command() {
        let dir = temp_dir("noscript");
        write(&dir, "package.json", r#"{"dependencies":{"vite":"^5"}}"#);
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Vite);
        assert!(!info.runnable);
        assert!(
            info.notes.iter().any(|w| w.contains("npm install")),
            "{:?}",
            info.notes
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Any framework with a dev script runs, tagger or no tagger.
    #[test]
    fn a_framework_dedup_has_no_tagger_for_still_runs() {
        for (dep, stack, script) in [
            ("astro", "Astro", "astro dev"),
            ("gatsby", "Gatsby", "gatsby develop"),
            ("@angular/core", "Angular", "ng serve"),
            ("nuxt", "Nuxt", "nuxt dev"),
        ] {
            let dir = temp_dir("otherfw");
            write(
                &dir,
                "package.json",
                &format!(r#"{{"scripts":{{"dev":"{script}"}},"dependencies":{{"{dep}":"1"}}}}"#),
            );
            let info = detect(dir.to_str().unwrap());
            assert_eq!(info.framework, Framework::Unknown, "{stack}");
            assert_eq!(info.stack, stack);
            assert!(info.runnable, "{stack}");
            assert_eq!(info.dev_script.as_deref(), Some(script));
            assert!(
                info.notes.iter().any(|w| w.contains("its `dev` script")),
                "{:?}",
                info.notes
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// Create React App keeps a template at `public/index.html`. Static
    /// detection used to win that race and serve the template as a page —
    /// an empty `<div id="root">`.
    #[test]
    fn create_react_app_is_run_not_served_as_flat_files() {
        let dir = temp_dir("cra");
        std::fs::create_dir_all(dir.join("public")).unwrap();
        std::fs::write(dir.join("public/index.html"), "<div id=\"root\"></div>").unwrap();
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"start":"react-scripts start"},"dependencies":{"react":"18","react-scripts":"5"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Unknown);
        assert_eq!(info.stack, "Create React App");
        assert_eq!(info.dev_script_name.as_deref(), Some("start"));
        assert!(info.runnable);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The other side of that rule: a hand-written site that happens to have
    /// a package.json (prettier, a CSS watcher) is still dedup's to serve —
    /// its script starts no server, and dedup's is the one that stamps.
    #[test]
    fn a_site_with_a_tooling_package_json_is_still_static() {
        let dir = temp_dir("sitepkg");
        write(&dir, "index.html", "<h1>hi</h1>");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"tailwindcss -i in.css -o out.css --watch"},"devDependencies":{"tailwindcss":"^3"}}"#,
        );
        assert_eq!(detect(dir.to_str().unwrap()).framework, Framework::Static);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A backend app is started by its own command — and is recognised before
    /// the JS heuristics, which would each get it wrong: Laravel depends on
    /// `vite`, Rails ships `public/404.html`.
    #[test]
    fn backend_apps_start_with_their_own_command() {
        let dir = temp_dir("django");
        write(&dir, "manage.py", "");
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.stack, "Django");
        assert_eq!(info.run_command.as_deref(), Some("python3 manage.py runserver"));
        assert!(info.runnable);
        // The project's own virtualenv is the python that has its packages.
        std::fs::create_dir_all(dir.join(".venv/bin")).unwrap();
        write(&dir, ".venv/bin/python", "");
        assert_eq!(
            detect(dir.to_str().unwrap()).run_command.as_deref(),
            Some(".venv/bin/python manage.py runserver")
        );
        std::fs::remove_dir_all(&dir).ok();

        let dir = temp_dir("laravel");
        write(&dir, "artisan", "");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"vite"},"devDependencies":{"vite":"^5"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Unknown, "not a Vite project");
        assert_eq!(info.stack, "Laravel");
        assert_eq!(info.run_command.as_deref(), Some("php artisan serve"));
        assert_eq!(info.dev_script, None, "one way to start, not two");
        std::fs::remove_dir_all(&dir).ok();

        let dir = temp_dir("rails");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("public")).unwrap();
        write(&dir, "bin/rails", "");
        write(&dir, "public/404.html", "<h1>404</h1>");
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Unknown, "not a static site");
        assert_eq!(info.run_command.as_deref(), Some("bin/rails server"));
        std::fs::remove_dir_all(&dir).ok();

        let dir = temp_dir("php");
        write(&dir, "index.php", "<?php");
        write(&dir, "about.html", "<h1>about</h1>");
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Unknown);
        assert_eq!(info.stack, "PHP");
        assert_eq!(info.run_command.as_deref(), Some("php -S localhost:8000"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A mobile app opens through its web build when it has one — and is told
    /// plainly when it doesn't, instead of being run by a `start` script that
    /// boots Metro and never prints an address.
    #[test]
    fn mobile_apps_open_through_their_web_build() {
        let dir = temp_dir("expo");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"start":"expo start","web":"expo start --web"},"dependencies":{"expo":"52","react-native":"0.76","react-native-web":"0.19"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.stack, "Expo");
        assert_eq!(info.framework, Framework::Unknown);
        assert_eq!(info.run_command.as_deref(), Some("npm run web"));
        assert_eq!(info.dev_script, None, "never Metro's `start`");
        assert!(info.runnable);
        assert!(!info.notes.iter().any(|n| n.contains("no web target")), "{:?}", info.notes);
        std::fs::remove_dir_all(&dir).ok();

        // No web script and no react-native-web: still Expo's own command,
        // with the one line that adds the target.
        let dir = temp_dir("exponoweb");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"start":"expo start"},"dependencies":{"expo":"52","react-native":"0.76"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.run_command.as_deref(), Some("npx expo start --web"));
        assert!(info.notes.iter().any(|n| n.contains("expo install react-native-web")), "{:?}", info.notes);
        std::fs::remove_dir_all(&dir).ok();

        let dir = temp_dir("barern");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"start":"react-native start"},"dependencies":{"react-native":"0.76"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.stack, "React Native");
        assert!(!info.runnable, "Metro alone is nothing a browser can load");
        assert_eq!(info.dev_script, None);
        assert!(info.notes.iter().any(|n| n.contains("no web target")), "{:?}", info.notes);
        assert!(
            !info.notes.iter().any(|n| n.contains("couldn't tell")),
            "it knows exactly what this is: {:?}",
            info.notes
        );
        std::fs::remove_dir_all(&dir).ok();

        let dir = temp_dir("flutter");
        write(&dir, "pubspec.yaml", "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n");
        std::fs::create_dir_all(dir.join("web")).unwrap();
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.stack, "Flutter");
        assert_eq!(info.run_command.as_deref(), Some("flutter run -d web-server"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Swift and Kotlin have no web build. That is said, not guessed around.
    #[test]
    fn a_native_app_is_named_and_told_the_truth() {
        let dir = temp_dir("ios");
        std::fs::create_dir_all(dir.join("Notes.xcodeproj")).unwrap();
        std::fs::create_dir_all(dir.join("Notes")).unwrap();
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.stack, "iOS app");
        assert!(!info.runnable);
        assert!(info.notes.iter().any(|n| n.contains("no web build")), "{:?}", info.notes);
        std::fs::remove_dir_all(&dir).ok();

        let dir = temp_dir("android");
        write(&dir, "settings.gradle.kts", "");
        write(&dir, "gradlew", "");
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.stack, "Android app");
        assert!(!info.runnable);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_tauri_app_says_what_the_canvas_can_show() {
        let dir = temp_dir("tauri");
        std::fs::create_dir_all(dir.join("src-tauri")).unwrap();
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"vite"},"dependencies":{"@tauri-apps/api":"2"},"devDependencies":{"vite":"^7"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Vite, "tagged like any Vite app");
        assert!(info.runnable);
        assert!(info.notes.iter().any(|n| n.contains("without the Rust side")), "{:?}", info.notes);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A Vite project that isn't React is named for what it is.
    #[test]
    fn a_vite_metaframework_is_named() {
        let dir = temp_dir("sveltekit");
        write(
            &dir,
            "package.json",
            r#"{"scripts":{"dev":"vite dev"},"devDependencies":{"vite":"^5","@sveltejs/kit":"2","svelte":"4"}}"#,
        );
        let info = detect(dir.to_str().unwrap());
        assert_eq!(info.framework, Framework::Vite);
        assert_eq!(info.stack, "SvelteKit on Vite");
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
        assert!(info.runnable);
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
        assert!(info.runnable, "{:?}", info.notes);
        assert!(
            info.notes.iter().any(|w| w.contains("node_modules/.bin/vite")),
            "the card must say what it will run instead: {:?}",
            info.notes
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
