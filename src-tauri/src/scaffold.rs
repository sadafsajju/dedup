//! Starting a project in an empty folder (the "blank folder" open path).
//!
//! dedup's standing rule is that it never writes the user's source or config
//! for its own convenience. This is not an exception to that rule — it is the
//! opposite situation. The folder is empty, the user asked for a starter by
//! name, and every file written here is theirs from the moment it lands: it is
//! the project, not tooling smuggled into one. It is committed as the repo's
//! initial commit so the very first thing that exists is a clean baseline to
//! diff every later dedup edit against.
//!
//! Two starters, because dedup can now open two kinds of thing:
//!   - `react`  Vite + React + TypeScript + Tailwind v4 (needs an install)
//!   - `html`   one page and a stylesheet (needs nothing, works offline)

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

use crate::toolpath;

pub const EVT_LOG: &str = "scaffold://log";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    line: String,
}

/// Where progress goes. A trait object rather than the AppHandle directly so
/// the scaffolding itself is testable off a running app — the thing worth
/// asserting is that the starter dedup writes is a project dedup can open,
/// and that has nothing to do with events.
pub type Log<'a> = &'a dyn Fn(String);

fn emitter(app: &AppHandle) -> impl Fn(String) + '_ {
    move |line: String| {
        let _ = app.emit(EVT_LOG, LogEvent { line });
    }
}

/// One starter: the files it lays down, in the order they read.
type Template = &'static [(&'static str, &'static str)];

const HTML_TEMPLATE: Template = &[
    (
        "index.html",
        r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>New site</title>
    <!-- Tailwind's browser build: it reads the classes on this page and
         generates their CSS live, so dedup's Style panel edits take effect
         with no build step. Swap it for a compiled stylesheet before you
         ship. -->
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body class="min-h-screen bg-white text-slate-900 antialiased">
    <header class="border-b border-slate-200">
      <nav class="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
        <span class="text-sm font-semibold tracking-tight">New site</span>
        <a href="#start" class="text-sm text-slate-500 hover:text-slate-900">Get started</a>
      </nav>
    </header>

    <main class="mx-auto max-w-3xl px-6 py-20">
      <h1 class="text-4xl font-semibold tracking-tight">Hello.</h1>
      <p class="mt-4 max-w-prose text-slate-600">
        This page is yours. Click anything on the canvas to select it, then use
        the Style panel to change it — every edit is written straight back into
        index.html.
      </p>
      <div id="start" class="mt-10 flex gap-3">
        <a href="#" class="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          Primary action
        </a>
        <a href="#" class="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium">
          Secondary
        </a>
      </div>
    </main>
  </body>
</html>
"##,
    ),
    (
        "style.css",
        r##"/* Your own CSS lives here — Tailwind handles the utility classes on the
   page, and this file is for everything that isn't a utility. */

:root {
  color-scheme: light;
}
"##,
    ),
    (".gitignore", ".DS_Store\nnode_modules/\n"),
];

const REACT_TEMPLATE: Template = &[
    (
        "package.json",
        r##"{
  "name": "app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^4.6.0",
    "tailwindcss": "^4.1.0",
    "typescript": "~5.8.3",
    "vite": "^7.0.4"
  }
}
"##,
    ),
    (
        "vite.config.ts",
        r##"import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
"##,
    ),
    (
        "tsconfig.json",
        r##"{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "vite.config.ts"]
}
"##,
    ),
    (
        "index.html",
        r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
"##,
    ),
    (
        "src/main.tsx",
        r##"import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
"##,
    ),
    (
        "src/App.tsx",
        r##"export function App() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-4xl font-semibold tracking-tight">Hello.</h1>
      <p className="mt-4 max-w-prose text-slate-600">
        This app is yours. Click anything on the canvas to select it, then use
        the Style panel to change it — every edit is written straight back into
        the component's source.
      </p>
      <div className="mt-10 flex gap-3">
        <button className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          Primary action
        </button>
        <button className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium">
          Secondary
        </button>
      </div>
    </main>
  );
}
"##,
    ),
    (
        "src/index.css",
        r##"@import "tailwindcss";

html,
body {
  background: #fff;
  color: #0f172a;
}
"##,
    ),
    (
        ".gitignore",
        "node_modules/\ndist/\n.DS_Store\n*.local\n",
    ),
];

/// The starters offered on the launch screen, in the order shown.
pub fn template_for(kind: &str) -> Option<Template> {
    match kind {
        "react" => Some(REACT_TEMPLATE),
        "html" => Some(HTML_TEMPLATE),
        _ => None,
    }
}

/// Entries that don't count as content — must match `project::IGNORABLE`'s
/// intent: a folder holding only these is one we may write a starter into.
fn is_writable_empty(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().all(|e| {
        let name = e.file_name();
        let name = name.to_string_lossy();
        matches!(
            name.as_ref(),
            ".git" | ".DS_Store" | ".idea" | ".vscode" | "Thumbs.db" | ".gitkeep"
        )
    })
}

/// The package manager to install a fresh project with: whichever the machine
/// actually has, preferring the fast one. Never a manager that isn't there —
/// a starter that can't install is worse than no starter.
fn installer() -> Option<(&'static str, Vec<&'static str>)> {
    for (bin, args) in [
        ("pnpm", vec!["install"]),
        ("bun", vec!["install"]),
        ("npm", vec!["install"]),
        ("yarn", vec!["install"]),
    ] {
        if toolpath::which(bin).is_some() {
            return Some((bin, args));
        }
    }
    None
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let git = toolpath::which("git").unwrap_or_else(|| "git".into());
    let out = Command::new(git)
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Write `template` into `root`, make it a git repo with the starter as its
/// initial commit, and install dependencies when the starter has any.
///
/// Refuses a folder that isn't empty — this writes files, and the one thing it
/// must never do is write them over something.
pub fn create(app: &AppHandle, root: &str, kind: &str) -> Result<(), String> {
    create_with(root, kind, &emitter(app), true)
}

/// The scaffolding itself. `install` is false only in tests, which have no
/// business reaching the network — everything they assert (the files, the
/// repo, and what `project::detect` then makes of the folder) is settled
/// before an install would run.
pub fn create_with(root: &str, kind: &str, log: Log<'_>, install_deps: bool) -> Result<(), String> {
    let root_path = Path::new(root);
    let template = template_for(kind).ok_or_else(|| format!("unknown starter: {kind}"))?;

    if !root_path.is_dir() {
        return Err(format!("{root} is not a folder"));
    }
    if !is_writable_empty(root_path) {
        return Err(
            "this folder isn't empty — dedup only scaffolds into an empty folder".into(),
        );
    }

    log(format!("Creating a {kind} starter in {root}"));
    for (rel, contents) in template {
        let path = root_path.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {rel}: {e}"))?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("write {rel}: {e}"))?;
        log(format!("  + {rel}"));
    }

    // git before install: the initial commit is the starter, not the starter
    // plus whatever a lockfile resolved to. Every dedup edit after this has a
    // clean baseline behind it.
    if !root_path.join(".git").exists() {
        run_git(root_path, &["init"])?;
        log("  initialised a git repository".into());
    }
    run_git(root_path, &["add", "-A"])?;
    // An empty index (someone committed the .gitignore already) is not a failure.
    if !run_git(root_path, &["diff", "--cached", "--name-only"])?
        .trim()
        .is_empty()
    {
        run_git(root_path, &["commit", "-m", "Initial commit"])?;
        log("  committed the starter".into());
    }

    if !root_path.join("package.json").exists() || !install_deps {
        log("Ready.".into());
        return Ok(());
    }

    let (bin, args) = installer().ok_or(
        "no package manager found (pnpm, bun, npm or yarn). \
         The files are written and committed — install dependencies yourself and reopen.",
    )?;
    log(format!("Installing dependencies with {bin}…"));
    install(log, root_path, bin, &args)?;
    log("Ready.".into());
    Ok(())
}

/// Run the install, streaming its output so a two-minute wait shows progress
/// instead of a frozen dialog.
fn install(log: Log<'_>, root: &Path, bin: &str, args: &[&str]) -> Result<(), String> {
    let program = toolpath::which(bin).unwrap_or_else(|| bin.into());
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        // Some installers prompt on a TTY; dedup has no way to answer.
        .env("CI", "1");
    toolpath::apply(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start {bin} install: {e}"))?;

    // The reader threads outlive this frame, so they cannot borrow `log`.
    // Lines come back over a channel and are emitted here instead.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut readers = Vec::new();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stream).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = tx.send(format!("  {}", line.trim_end()));
                }
            }
        }));
    }
    drop(tx); // the last sender, so `rx` ends when both readers do

    for line in rx {
        log(line);
    }
    let status = child.wait().map_err(|e| format!("{bin} install: {e}"))?;
    for reader in readers {
        let _ = reader.join();
    }
    if !status.success() {
        return Err(format!(
            "{bin} install failed ({}). The starter files are written and committed — \
             run `{bin} install` yourself and reopen the folder.",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_starter_carries_the_files_its_detection_needs() {
        // The starter has to come out the other side of `project::detect` as
        // the thing it claims to be — a template that scaffolds a project
        // dedup then can't open is the one failure mode that matters here.
        for (kind, expect) in [("react", "package.json"), ("html", "index.html")] {
            let files: Vec<&str> = template_for(kind).unwrap().iter().map(|(f, _)| *f).collect();
            assert!(files.contains(&expect), "{kind} starter must write {expect}");
            assert!(
                files.contains(&".gitignore"),
                "{kind} starter must ignore what it shouldn't commit"
            );
        }
    }

    /// The whole point of a starter: `detect` has to recognise what was just
    /// written as the thing the user chose. A template that scaffolds a
    /// project dedup then cannot open is the only failure mode that matters.
    #[test]
    fn each_starter_scaffolds_a_project_dedup_can_open() {
        for (kind, expect) in [
            ("html", crate::project::Framework::Static),
            ("react", crate::project::Framework::Vite),
        ] {
            let dir = std::env::temp_dir()
                .join(format!("dedup-starter-{kind}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let root = dir.to_str().unwrap();

            assert!(crate::project::detect(root).is_empty);
            let lines = std::cell::RefCell::new(Vec::new());
            create_with(root, kind, &|l| lines.borrow_mut().push(l), false).unwrap();

            let info = crate::project::detect(root);
            assert_eq!(info.framework, expect, "{kind} starter");
            assert!(!info.is_empty, "{kind} starter left the folder empty");
            assert!(info.has_git, "{kind} starter must leave a repo behind");
            assert!(
                info.has_tailwind,
                "{kind}: the Style panel writes Tailwind classes — a starter without \
                 Tailwind would let it write classes that render nothing"
            );
            assert!(!lines.borrow().is_empty(), "progress is reported");

            // The starter is the repo's first commit, so every dedup edit
            // afterwards has a clean baseline to diff against.
            let log = run_git(&dir, &["log", "--oneline"]).unwrap();
            assert_eq!(log.lines().count(), 1, "{kind}: {log}");

            // Scaffolding twice would overwrite the user's work.
            assert!(create_with(root, kind, &|_| {}, false).is_err());
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// The whole feature, end to end and with nothing stubbed: an empty folder
    /// becomes a starter, the starter is detected as a static site, dedup's own
    /// server serves it, and the page that comes back is stamped with ids the
    /// write-back can resolve.
    ///
    /// Each half is covered on its own (here, and in `pnpm test:html`); this is
    /// the seam between them, which is where a launch-argument or path mistake
    /// would hide.
    #[test]
    fn an_empty_folder_becomes_a_site_dedup_serves_and_stamps() {
        use std::io::BufRead;

        let dir = std::env::temp_dir().join(format!("dedup-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();

        create_with(root, "html", &|_| {}, false).unwrap();
        let info = crate::project::detect(root);
        assert_eq!(info.framework, crate::project::Framework::Static);

        let launch = crate::instrument::static_setup(root, info.static_dir.as_deref()).unwrap();
        let mut child = Command::new(&launch.program)
            .args(&launch.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("static server should start");

        // Read the announced URL the same way devserver.rs does.
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("http://localhost:") {
                    let _ = tx.send(line);
                    return;
                }
            }
        });
        let line = rx
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("the server must announce its URL in the format devserver.rs parses");
        let url = line
            .split_whitespace()
            .find(|t| t.starts_with("http://"))
            .unwrap()
            .to_string();

        let page = Command::new("curl")
            .args(["-fsS", &url])
            .output()
            .expect("curl");
        let _ = child.kill();
        let html = String::from_utf8_lossy(&page.stdout).to_string();

        assert!(page.status.success(), "GET {url} failed");
        assert!(
            html.contains("data-dedup-id=\"index.html@"),
            "the served page must carry ids relative to the project root:\n{}",
            &html[..html.len().min(600)]
        );
        assert!(
            html.contains("/__dedup/overlay.js"),
            "the canvas overlay must be injected"
        );
        assert!(
            html.contains("cdn.tailwindcss.com"),
            "the starter's own markup must survive stamping"
        );
        // Stamps live only in what the browser receives.
        let source = std::fs::read_to_string(dir.join("index.html")).unwrap();
        assert!(
            !source.contains("data-dedup-id"),
            "the user's file must never be written to"
        );

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(crate::sidecar::support_dir(root)).ok();
    }

    #[test]
    fn refuses_a_folder_that_already_has_something_in_it() {
        let dir = std::env::temp_dir().join(format!("dedup-scaffold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(is_writable_empty(&dir), "a new folder is empty");

        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".DS_Store"), "").unwrap();
        assert!(is_writable_empty(&dir), "a fresh repo still counts as empty");

        std::fs::write(dir.join("notes.md"), "mine").unwrap();
        assert!(!is_writable_empty(&dir), "one real file makes it not empty");
        std::fs::remove_dir_all(&dir).ok();
    }
}
