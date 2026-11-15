//! dedup — Tauri core. Phase 0 surface: project detection, dev-server child
//! process management, git-state probe, and the recent-projects list.

mod ai;
mod appmenu;
mod asset;
mod devserver;
mod export;
mod git;
mod instrument;
mod history;
mod parking;
mod project;
mod proxy;
mod publish;
mod recents;
mod scaffold;
mod session;
mod sidecar;
mod terminal;
mod thumbs;
mod toolpath;

use devserver::{DevServerState, ExecSpec};
use terminal::TerminalState;
use project::{Framework, PackageManager, ProjectInfo};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn detect_project(root: String) -> ProjectInfo {
    project::detect(&root)
}

/// Write a starter into an empty folder and make it a git repo (the "blank
/// folder" open path). `kind` is "react" or "html". Progress streams as
/// `scaffold://log`; the caller re-detects the folder afterwards.
#[tauri::command]
async fn scaffold_project(app: AppHandle, root: String, kind: String) -> Result<ProjectInfo, String> {
    let detect_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || scaffold::create(&app, &root, &kind))
        .await
        .map_err(|e| format!("scaffold task failed: {e}"))??;
    Ok(project::detect(&detect_root))
}

#[tauri::command]
fn git_status(root: String) -> git::GitStatus {
    git::status(&root)
}

/// Whether (and why not) element tagging is active for this session, so the
/// UI can say "inspection is off because X" instead of degrading silently.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstrumentationEvent {
    active: bool,
    /// "tagged" | "custom" | "framework" | "script" | "error"
    mode: &'static str,
    detail: Option<String>,
}

#[tauri::command]
fn start_dev_server(
    app: AppHandle,
    state: State<'_, DevServerState>,
    root: String,
    package_manager: PackageManager,
    framework: Framework,
    dev_script: Option<String>,
    dev_script_name: Option<String>,
    static_dir: Option<String>,
    run_command: Option<String>,
    stack: Option<String>,
    custom_command: Option<String>,
) -> Result<(), String> {
    // The script detection actually found, not an assumed `dev` — a project
    // with only a `start` script is reported supported on the strength of it.
    let script = dev_script_name.clone().unwrap_or_else(|| "dev".to_string());
    let (launch, instr_info): (devserver::Launch, InstrumentationEvent) =
        if let Some(cmd) = custom_command {
        // The user's explicit command wins; no rewriting on top of it.
        (
            ExecSpec::Shell(cmd).into(),
            InstrumentationEvent { active: false, mode: "custom", detail: None },
        )
    } else if framework == Framework::Vite {
        match instrument::setup(&root, dev_script.as_deref()) {
            Ok(Some(instr)) => (
                devserver::Launch {
                    exec: ExecSpec::Direct {
                        program: instr.program,
                        args: instr.args,
                    },
                    env: instr.env,
                },
                InstrumentationEvent { active: true, mode: "tagged", detail: None },
            ),
            Ok(None) => (
                ExecSpec::Script(package_manager, script.clone(), Vec::new()).into(),
                InstrumentationEvent { active: false, mode: "script", detail: None },
            ),
            Err(e) => {
                // Instrumentation is an enhancement, not a requirement — run
                // plain and tell the user why inspection is unavailable.
                let _ = app.emit(
                    "devserver://log",
                    serde_json::json!({
                        "stream": "stderr",
                        "line": format!("dedup: tagging setup failed ({e}) — inspection disabled"),
                    }),
                );
                (
                    ExecSpec::Script(package_manager, script.clone(), Vec::new()).into(),
                    InstrumentationEvent { active: false, mode: "error", detail: Some(e) },
                )
            }
        }
    } else if framework == Framework::Next {
        // Next has no --config flag, so tagging rides on a line the user adds
        // to their own next.config (see instrument::next_status). The wrapper
        // is inert without DEDUP_TAGGING, so setting it here is what turns
        // tagging on for dedup's dev server and nobody else's.
        match instrument::next_status(&root) {
            instrument::NextStatus::Wired { needs_webpack, .. } => {
                // Turbopack never runs the webpack hook dedup tags through, so
                // a Turbopack project is launched under webpack. The flag has
                // to *replace* the script's own bundler flag, not join it —
                // Next refuses to start with both — so dedup runs `next`
                // directly, carrying the env the script set up.
                let direct = needs_webpack
                    .then(|| instrument::next_webpack_launch(&root, dev_script.as_deref()))
                    .flatten();
                match direct {
                    Some(launch) => (
                        devserver::Launch {
                            exec: ExecSpec::Direct {
                                program: launch.program,
                                args: launch.args,
                            },
                            env: launch
                                .env
                                .into_iter()
                                .chain([("DEDUP_TAGGING".to_string(), "1".to_string())])
                                .collect(),
                        },
                        InstrumentationEvent {
                            active: true,
                            mode: "tagged",
                            detail: Some("webpack".to_string()),
                        },
                    ),
                    // Needs webpack but the dev script is too custom to
                    // rewrite: run it as written and say inspection is off,
                    // rather than start a server that tags nothing.
                    None if needs_webpack => (
                        ExecSpec::Script(package_manager, script.clone(), Vec::new()).into(),
                        InstrumentationEvent {
                            active: false,
                            mode: "framework",
                            detail: Some(
                                "Next.js on Turbopack — dedup couldn't rewrite this dev script to run webpack, so element tagging is off. Set a custom dev command with `--webpack`".into(),
                            ),
                        },
                    ),
                    None => (
                        devserver::Launch {
                            exec: ExecSpec::Script(package_manager, script.clone(), Vec::new()),
                            env: vec![("DEDUP_TAGGING".into(), "1".into())],
                        },
                        InstrumentationEvent { active: true, mode: "tagged", detail: None },
                    ),
                }
            }
            instrument::NextStatus::Offered { config, .. } => (
                ExecSpec::Script(package_manager, script.clone(), Vec::new()).into(),
                InstrumentationEvent {
                    active: false,
                    mode: "next-optin",
                    detail: Some(config),
                },
            ),
            instrument::NextStatus::Unavailable { reason } => (
                ExecSpec::Script(package_manager, script.clone(), Vec::new()).into(),
                InstrumentationEvent {
                    active: false,
                    mode: "framework",
                    detail: Some(format!("Next.js — {reason}")),
                },
            ),
        }
    } else if framework == Framework::Static {
        // There is no user dev server here — dedup *is* the dev server. So a
        // failure to prepare it is fatal rather than a downgrade to "runs but
        // uninstrumented": there would be nothing left running.
        let instr = instrument::static_setup(&root, static_dir.as_deref())?;
        (
            ExecSpec::Direct {
                program: instr.program,
                args: instr.args,
            }
            .into(),
            InstrumentationEvent {
                active: true,
                mode: "tagged",
                detail: Some("static".to_string()),
            },
        )
    } else {
        // Everything dedup has no tagger for: run the project's own server
        // exactly as its author does, and let the editor say that inspection
        // is off. A backend's command first — when detection found one it
        // cleared the package script, so there is one answer, not two.
        let exec = match (run_command, dev_script_name.is_some()) {
            (Some(cmd), _) => ExecSpec::Shell(cmd),
            (None, true) => ExecSpec::Script(package_manager, script.clone(), Vec::new()),
            (None, false) => {
                return Err(
                    "dedup couldn't tell how to start this project. Set the command you use \
                     in project details (the gear on its card on the launch screen)."
                        .into(),
                )
            }
        };
        (
            devserver::Launch {
                exec,
                // Create React App and its relatives open a browser tab on
                // start; the canvas is the browser here.
                env: vec![("BROWSER".into(), "none".into())],
            },
            InstrumentationEvent {
                active: false,
                mode: "framework",
                detail: Some(stack.unwrap_or_else(|| "This project".to_string())),
            },
        )
    };
    let result = devserver::start(&app, &state, &root, launch);
    if result.is_ok() {
        let _ = app.emit("devserver://instrumentation", instr_info);
    }
    result
}

#[tauri::command]
fn stop_dev_server(app: AppHandle, state: State<'_, DevServerState>) -> Result<(), String> {
    devserver::stop(&app, &state)
}

#[tauri::command]
fn dev_server_running(state: State<'_, DevServerState>) -> bool {
    devserver::is_running(&state)
}

/// A shell in the console drawer, started in the project root. Output
/// streams back on `output` as raw bytes; the end arrives as `terminal://exit`.
/// Async so a write that blocks on a full PTY never stalls the main thread.
#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,
    cols: u16,
    rows: u16,
    output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<terminal::Opened, String> {
    terminal::open(&app, &state, &cwd, cols, rows, output)
}

#[tauri::command]
async fn terminal_write(state: State<'_, TerminalState>, id: u32, data: String) -> Result<(), String> {
    terminal::write(&state, id, data.as_bytes())
}

#[tauri::command]
async fn terminal_resize(
    state: State<'_, TerminalState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal::resize(&state, id, cols, rows)
}

#[tauri::command]
async fn terminal_close(state: State<'_, TerminalState>, id: u32) -> Result<(), String> {
    terminal::close(&state, id);
    Ok(())
}

#[tauri::command]
async fn terminal_close_all(state: State<'_, TerminalState>) -> Result<(), String> {
    terminal::close_all(&state);
    Ok(())
}

/// Report the element at ordinal `index` in `file`: className editability,
/// live line/col, and which structural edits it admits (FR-4.2).
#[tauri::command]
fn inspect_element(
    root: String,
    file: String,
    index: u32,
) -> Result<serde_json::Value, String> {
    sidecar::inspect(&root, &file, index)
}

/// Copy a file the AI agent generated into the project — an image, which is
/// the one output it cannot put in its reply. Gated in `asset.rs`: the source
/// must be inside that agent's own output directory, must sniff as an image,
/// and the destination must be a new path inside the project.
#[tauri::command]
fn import_agent_asset(
    root: String,
    agent: String,
    source: String,
    dest: String,
    // For a destination named before the image existed (an IMAGE request):
    // correct an extension that disagrees with the bytes instead of refusing.
    adapt_extension: Option<bool>,
) -> Result<asset::ImportedAsset, String> {
    let agent = ai::Agent::parse(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    asset::import(&root, agent, &source, &dest, adapt_extension.unwrap_or(false))
}

/// The source of the element at ordinal `index` in `file`, as a snippet that
/// can be pasted somewhere else, plus the names it would need there.
#[tauri::command]
fn copy_element(
    root: String,
    file: String,
    index: u32,
) -> Result<serde_json::Value, String> {
    sidecar::copy(&root, &file, index)
}

/// Apply one file's staged edit program — class, text, insert, remove, move —
/// as a single AST-ranged write (FR-4.1).
#[tauri::command]
async fn apply_edits(
    root: String,
    file: String,
    ops: Vec<sidecar::EditOp>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::apply(&root, &file, &ops))
        .await
        .map_err(|e| format!("edit task failed: {e}"))?
}

/// Read one project source file (AI chat context). Path is resolved inside
/// the project root — anything escaping it is refused.
#[tauri::command]
fn read_source(root: String, file: String) -> Result<String, String> {
    let path = sidecar::resolve_in_root(&root, &file)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {file}: {e}"))
}

/// Replace one source file with AI-produced content. The sidecar re-parses
/// the content and refuses anything that doesn't parse — same trust gate as
/// class write-back. Returns `{ ok, changed }`.
#[tauri::command]
async fn write_source(
    root: String,
    file: String,
    content: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::write_file(&root, &file, &content))
        .await
        .map_err(|e| format!("write task failed: {e}"))?
}

/// Replace several source files as one all-or-nothing write (chat agent
/// edits). The sidecar validates every file's new content before writing any
/// of them, so a multi-file edit either lands whole or not at all.
#[tauri::command]
async fn write_sources(
    root: String,
    files: Vec<(String, String)>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::write_files(&root, &files))
        .await
        .map_err(|e| format!("write task failed: {e}"))?
}

/// Put files back as dedup found them — discarding a previewed chat edit.
/// A null content means the file didn't exist before and is removed.
#[tauri::command]
async fn revert_sources(
    root: String,
    files: Vec<(String, Option<String>)>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::revert_files(&root, &files))
        .await
        .map_err(|e| format!("revert task failed: {e}"))?
}

/// Project file inventory for the chat agent's `list` tool.
#[tauri::command]
async fn list_project_files(root: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::list_files(&root))
        .await
        .map_err(|e| format!("list task failed: {e}"))?
}

/// Line matches across the project for the chat agent's `grep` tool.
#[tauri::command]
async fn grep_project(root: String, pattern: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::grep(&root, &pattern))
        .await
        .map_err(|e| format!("grep task failed: {e}"))?
}

/// Which coding-agent CLIs are installed. Preferred AI backends — they use a
/// subscription the user already has; an API key is the fallback.
#[tauri::command]
fn agent_available(agent: String) -> bool {
    ai::Agent::parse(&agent).is_some_and(ai::available)
}

/// One headless prompt through the named agent. `model` is whatever that CLI
/// calls a model; None uses its own default.
#[tauri::command]
async fn agent_prompt(
    agent: String,
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    let agent = ai::Agent::parse(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    tauri::async_runtime::spawn_blocking(move || ai::prompt(agent, &prompt, model.as_deref()))
        .await
        .map_err(|e| format!("agent task failed: {e}"))?
}

/// A region of the app window as a PNG `data:` URL at `width` points — the
/// picture on a parked element's card, taken while it is still on the page.
#[tauri::command]
async fn snapshot_region(app: AppHandle, rect: thumbs::Rect, width: f64) -> Result<String, String> {
    let png = tauri::async_runtime::spawn_blocking(move || {
        thumbs::snapshot_png_at(&app, Some(rect), width.clamp(16.0, 2400.0))
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))??;
    use base64::Engine as _;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// The project's parked canvas pieces (see `parking.rs`).
#[tauri::command]
fn load_parked(app: AppHandle, root: String) -> serde_json::Value {
    parking::load(&app, &root)
}

#[tauri::command]
fn save_parked(app: AppHandle, root: String, items: serde_json::Value) -> Result<(), String> {
    parking::save(&app, &root, &items)
}

/// Export one artboard as a PNG or a vector PDF, rendered at its real size in
/// a throwaway off-screen view (see `export.rs`), written where the user chose.
#[tauri::command]
async fn export_artboard(
    app: AppHandle,
    request: export::Request,
) -> Result<export::Exported, String> {
    tauri::async_runtime::spawn_blocking(move || export::export(&app, &request))
        .await
        .map_err(|e| format!("export task failed: {e}"))?
}

/// Make the project a git repository with its current files as the first
/// commit — what lets a folder with no git use dedup's save path at all.
#[tauri::command]
async fn git_init_baseline(root: String) -> Result<git::GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::init_baseline(&root)?;
        Ok(git::status(&root))
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

/// The models an agent's CLI offers, read from the CLI itself (empty for one
/// with no catalog — the editor keeps its own list for those).
#[tauri::command]
async fn agent_models(agent: String) -> Result<Vec<ai::ModelChoice>, String> {
    let agent = ai::Agent::parse(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    tauri::async_runtime::spawn_blocking(move || ai::models(agent))
        .await
        .map_err(|e| format!("agent task failed: {e}"))?
}

/// Mock-session seed for zero-login editing (None when never set up).
#[tauri::command]
fn load_session_seed(root: String) -> Option<session::SessionSeed> {
    session::load(&root)
}

/// Persist the reviewed seed script and whether it's active. Takes effect on
/// the next canvas frame reload — the tagger serves this file per request.
#[tauri::command]
fn save_session_seed(root: String, enabled: bool, script: String) -> Result<(), String> {
    session::save(&root, enabled, &script)
}

/// The app's auth SDK (when it uses one) plus any of its own session-storage
/// code — what the seed generator reasons from, and what tells the user when
/// a seed can't work at all.
#[tauri::command]
fn collect_auth_context(root: String) -> session::AuthContext {
    session::collect_auth_context(&root)
}

/// First-write branch guarantee + commit-per-save (FR-4.5, FR-4.6).
/// Returns (branch, short hash).
#[tauri::command]
fn commit_session(
    root: String,
    message: String,
    paths: Vec<String>,
) -> Result<(String, String), String> {
    let branch = git::ensure_session_branch(&root)?;
    let hash = git::commit_paths(&root, &message, &paths)?;
    Ok((branch, hash))
}

#[tauri::command]
fn get_recent_projects(app: AppHandle) -> Vec<recents::RecentProject> {
    recents::load(&app)
}

#[tauri::command]
fn add_recent_project(
    app: AppHandle,
    path: String,
    name: String,
    framework: Option<String>,
) -> Vec<recents::RecentProject> {
    recents::add(&app, &path, &name, framework)
}

#[tauri::command]
fn remove_recent_project(app: AppHandle, path: String) -> Vec<recents::RecentProject> {
    thumbs::forget(&app, &path);
    recents::remove(&app, &path)
}

/// Launch-grid card image, or null when the project was never captured.
#[tauri::command]
fn project_thumbnail(app: AppHandle, root: String) -> Option<String> {
    thumbs::load(&app, &root)
}

/// Snapshot the canvas region into the project's thumbnail. Blocking work
/// (it waits on WebKit's completion handler), so never on the main thread.
#[tauri::command]
async fn capture_project_thumbnail(
    app: AppHandle,
    root: String,
    rect: Option<thumbs::Rect>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || thumbs::capture(&app, &root, rect))
        .await
        .map_err(|e| format!("capture thumbnail: {e}"))?
}

/// Page routes discovered from the project's files (no dev server needed).
#[tauri::command]
async fn detect_routes(
    root: String,
    framework: Option<Framework>,
) -> Result<serde_json::Value, String> {
    // Which discovery to run is the framework the compatibility card already
    // settled on, not a second guess from inside the sidecar.
    // Next is named because `pages/` and `app/` are routes only there; in a
    // Vite app the same folder names are just where the views live.
    let kind = match framework {
        Some(Framework::Static) => "static",
        Some(Framework::Next) => "next",
        Some(Framework::Vite) => "vite",
        _ => "app",
    };
    tauri::async_runtime::spawn_blocking(move || sidecar::routes(&root, kind))
        .await
        .map_err(|e| format!("route scan failed: {e}"))?
}

/// What dedup can do for a Next.js project: already wired, an offer with the
/// exact config diff, or a reason it cannot be. Read-only.
#[tauri::command]
fn next_status(root: String) -> instrument::NextStatus {
    instrument::next_status(&root)
}

/// dedup's own commits on this session branch, newest first (FR-5.7).
#[tauri::command]
fn session_history(root: String, limit: Option<u32>) -> Result<Vec<history::HistoryEntry>, String> {
    history::history(&root, limit.unwrap_or(50))
}

/// Undo one dedup commit, restoring only the paths it touched.
#[tauri::command]
async fn revert_commit(root: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || history::revert(&root, &hash))
        .await
        .map_err(|e| format!("revert task failed: {e}"))?
}

/// Where the branches stand for the Commit tab — refs only, no fetch.
#[tauri::command]
async fn git_sync_status(root: String) -> Result<publish::SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || publish::sync_status(&root))
        .await
        .map_err(|e| format!("status task failed: {e}"))
}

/// Push one named branch to one named remote. Only ever from the user's own
/// click on a button that names both; never forced (see `publish.rs`).
#[tauri::command]
async fn git_push(root: String, remote: String, branch: String) -> Result<publish::PushResult, String> {
    tauri::async_runtime::spawn_blocking(move || publish::push(&root, &remote, &branch))
        .await
        .map_err(|e| format!("push task failed: {e}"))?
}

/// Fast-forward one of the user's branches to a session branch, or refuse.
#[tauri::command]
async fn git_land(root: String, session: String, target: String) -> Result<publish::LandResult, String> {
    tauri::async_runtime::spawn_blocking(move || publish::land(&root, &session, &target))
        .await
        .map_err(|e| format!("land task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(appmenu::build)
        .on_menu_event(appmenu::on_event)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DevServerState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            detect_project,
            scaffold_project,
            git_status,
            start_dev_server,
            stop_dev_server,
            dev_server_running,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_close_all,
            inspect_element,
            copy_element,
            import_agent_asset,
            apply_edits,
            read_source,
            write_source,
            write_sources,
            revert_sources,
            list_project_files,
            grep_project,
            load_session_seed,
            save_session_seed,
            collect_auth_context,
            agent_available,
            agent_prompt,
            agent_models,
            git_init_baseline,
            export_artboard,
            snapshot_region,
            load_parked,
            save_parked,
            commit_session,
            get_recent_projects,
            add_recent_project,
            remove_recent_project,
            project_thumbnail,
            capture_project_thumbnail,
            detect_routes,
            next_status,
            session_history,
            revert_commit,
            git_sync_status,
            git_push,
            git_land,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ⌘Q and other app-level exits bypass the window close handler —
            // make sure the user's dev server never outlives us (FR-1.3).
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<DevServerState>() {
                    devserver::shutdown(&state);
                }
                if let Some(state) = app.try_state::<TerminalState>() {
                    terminal::close_all(&state);
                }
            }
        });
}
