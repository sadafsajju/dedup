//! Coding-agent CLI bridge — lets chat edits and session-seed drafts
//! run through an agent the user already
//! has installed and signed into, instead of a raw API key.
//!
//! One shape, two agents: spawn a headless single-shot invocation, feed the
//! prompt on stdin, read one text answer back. Everything that differs
//! between them — the binary's name, the flags that mean "no tools, no
//! session, don't touch anything", and how the answer is framed in the output
//! — lives in `Agent` and nowhere else, so adding a third is a match arm
//! rather than a second copy of the process plumbing.
//!
//! Both are asked for a *text completion*. dedup does the file editing itself,
//! through its own parse-gated write-back, so an agent is never given tools or
//! write access here — it would be a second, unaudited path to the user's
//! source.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A coding-agent CLI dedup can borrow for one prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Agent {
    ClaudeCode,
    Codex,
}

impl Agent {
    pub fn parse(name: &str) -> Option<Agent> {
        match name {
            "claude-code" | "claude" => Some(Agent::ClaudeCode),
            "codex" => Some(Agent::Codex),
            _ => None,
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude",
            Agent::Codex => "codex",
        }
    }

    /// Where the installer usually puts it. A GUI-launched app inherits a
    /// minimal PATH, so `which` alone finds nothing on a normal machine.
    fn fallbacks(self, home: &str) -> Vec<String> {
        match self {
            Agent::ClaudeCode => vec![
                format!("{home}/.claude/local/claude"),
                "/opt/homebrew/bin/claude".into(),
                "/usr/local/bin/claude".into(),
                format!("{home}/.local/bin/claude"),
            ],
            Agent::Codex => vec![
                format!("{home}/.codex/bin/codex"),
                "/opt/homebrew/bin/codex".into(),
                "/usr/local/bin/codex".into(),
                format!("{home}/.local/bin/codex"),
                format!("{home}/.bun/bin/codex"),
            ],
        }
    }

    /// The headless invocation. `answer_file` is where an agent that can write
    /// its final message to a file should put it (Codex); None means the
    /// answer is parsed out of stdout.
    fn args(self, model: Option<&str>, answer_file: Option<&Path>) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        match self {
            Agent::ClaudeCode => {
                // Deliberately stripped down: no settings/CLAUDE.md, no MCP
                // servers, no tools, no session files, no slash commands.
                // Everything else is startup cost and, worse, a hang surface —
                // an MCP server that blocks would stall the whole prompt.
                args.extend(
                    [
                        "-p",
                        "--output-format",
                        "json",
                        "--tools",
                        "",
                        "--strict-mcp-config",
                        "--mcp-config",
                        r#"{"mcpServers":{}}"#,
                        "--setting-sources",
                        "",
                        "--no-session-persistence",
                        "--disable-slash-commands",
                    ]
                    .map(String::from),
                );
                if let Some(model) = model {
                    args.push("--model".into());
                    args.push(model.into());
                }
            }
            Agent::Codex => {
                // `exec` is Codex's non-interactive mode. read-only sandbox
                // because dedup wants words, not edits; skip-git-repo-check
                // because we deliberately run from a neutral temp directory,
                // which is not a repo.
                args.extend(
                    ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]
                        .map(String::from),
                );
                if let Some(model) = model {
                    args.push("--model".into());
                    args.push(model.into());
                }
                if let Some(path) = answer_file {
                    args.push("--output-last-message".into());
                    args.push(path.display().to_string());
                }
                // Read the prompt from stdin rather than argv: these prompts
                // carry whole source files and would blow the arg limit.
                args.push("-".into());
            }
        }
        args
    }

    /// Where this agent writes files it generates, if it generates any.
    ///
    /// An image is the one output an agent cannot put in its reply — it can
    /// only say where it left it. That makes this directory the whole trust
    /// boundary for importing one: `asset.rs` will fetch from inside it and
    /// nowhere else, so what belongs here is the agent's own output directory
    /// and never a parent of it. `None` means the agent generates nothing,
    /// and dedup does not offer the import at all rather than offering one
    /// that could only fail.
    pub fn asset_dir(self) -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        match self {
            // Claude Code writes no files of its own for dedup to import.
            Agent::ClaudeCode => None,
            Agent::Codex => Some(PathBuf::from(format!("{home}/.codex/generated_images"))),
        }
    }

    /// Does this agent want a file to write its final message into?
    fn uses_answer_file(self) -> bool {
        matches!(self, Agent::Codex)
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "Claude Code",
            Agent::Codex => "Codex",
        }
    }
}

/// Generous ceiling for one prompt (big files on a slow model are legitimate);
/// the point is that the UI can never hang forever.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

/// The agent's binary: PATH first, then the usual install locations.
pub fn find(agent: Agent) -> Option<PathBuf> {
    if let Some(found) = crate::toolpath::which(agent.binary()) {
        return Some(found);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    agent
        .fallbacks(&home)
        .into_iter()
        .find(|c| Path::new(c).exists())
        .map(PathBuf::from)
}

pub fn available(agent: Agent) -> bool {
    find(agent).is_some()
}

/// One model an agent's CLI offers, as its own picker would list it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ModelChoice {
    /// What the CLI's `--model` takes.
    pub value: String,
    pub label: String,
}

impl Agent {
    /// The arguments that make this CLI print its model catalog, for one that
    /// can. Asked of the CLI rather than written into dedup, because the
    /// catalog belongs to the *installed binary*: two copies of an agent on
    /// one machine can know different models, and offering a name the copy
    /// dedup runs has never heard of is exactly how a run gets refused.
    fn catalog_args(self) -> Option<&'static [&'static str]> {
        match self {
            // Claude Code's names are stable aliases (haiku/sonnet/opus) that
            // CLI_AGENTS already lists.
            Agent::ClaudeCode => None,
            Agent::Codex => Some(&["debug", "models"]),
        }
    }
}

/// Printing a catalog is local work; anything slower than this is a CLI that
/// is wedged, and the picker should fall back rather than wait.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);

/// The models this agent's CLI offers, in the order it offers them. Empty for
/// an agent with no catalog to ask — the caller keeps its static list.
pub fn models(agent: Agent) -> Result<Vec<ModelChoice>, String> {
    let Some(args) = agent.catalog_args() else {
        return Ok(Vec::new());
    };
    let binary = find(agent).ok_or_else(|| format!("{} CLI not found", agent.label()))?;
    let mut cmd = Command::new(&binary);
    crate::toolpath::apply(&mut cmd);
    let mut child = cmd
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", agent.binary()))?;
    // The catalog is hundreds of KB — far past a pipe buffer — so it is
    // drained while the child runs, or the child blocks writing it.
    let mut out = child.stdout.take().ok_or("catalog stdout unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = out.read_to_string(&mut buf);
        buf
    });
    let deadline = Instant::now() + CATALOG_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                child.kill().ok();
                child.wait().ok();
                return Err(format!("{} took too long to list its models", agent.binary()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("{} wait: {e}", agent.binary())),
        }
    };
    let stdout = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("{} could not list its models", agent.binary()));
    }
    parse_codex_catalog(&stdout)
}

/// `codex debug models`: `{"models":[{slug, display_name, visibility,
/// priority, …}]}`. Only `visibility: "list"` entries — the ones Codex's own
/// picker shows; hidden ones are internal (review bots, reserved models) —
/// ordered by `priority` the way Codex orders them.
fn parse_codex_catalog(json: &str) -> Result<Vec<ModelChoice>, String> {
    let value: serde_json::Value =
        serde_json::from_str(json.trim()).map_err(|e| format!("unexpected model catalog: {e}"))?;
    let models = value
        .get("models")
        .and_then(|m| m.as_array())
        .ok_or("unexpected model catalog: no models list")?;
    let mut listed: Vec<(i64, ModelChoice)> = models
        .iter()
        .filter(|m| m.get("visibility").and_then(|v| v.as_str()) == Some("list"))
        .filter_map(|m| {
            let slug = m.get("slug")?.as_str()?.trim();
            if slug.is_empty() {
                return None;
            }
            let label = m
                .get("display_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(slug);
            let priority = m.get("priority").and_then(|p| p.as_i64()).unwrap_or(i64::MAX);
            Some((
                priority,
                ModelChoice {
                    value: slug.to_string(),
                    label: label.to_string(),
                },
            ))
        })
        .collect();
    listed.sort_by_key(|(p, _)| *p);
    let mut seen = std::collections::HashSet::new();
    Ok(listed
        .into_iter()
        .map(|(_, m)| m)
        .filter(|m| seen.insert(m.value.clone()))
        .collect())
}

/// Run one headless prompt through `agent` and return the answer text.
/// `model` is whatever that CLI calls a model ("sonnet", "gpt-5.6-sol", …);
/// None keeps the user's own default. A hard timeout kills the child, so the
/// UI can never wait forever on a wedged agent.
pub fn prompt(agent: Agent, text: &str, model: Option<&str>) -> Result<String, String> {
    let binary = find(agent).ok_or_else(|| format!("{} CLI not found", agent.label()))?;

    // Codex writes its final message to a file when asked, which is far more
    // robust than scraping a transcript off stdout.
    let answer_file = agent.uses_answer_file().then(|| {
        std::env::temp_dir().join(format!(
            "dedup-agent-{}-{}.txt",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ))
    });

    let mut cmd = Command::new(&binary);
    crate::toolpath::apply(&mut cmd);
    cmd.args(agent.args(model, answer_file.as_deref()));
    let mut child = cmd
        // Neutral cwd — never load project context from wherever dedup runs.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start {}: {e}", agent.binary()))?;

    // Feed stdin and drain stdout/stderr on their own threads: a prompt
    // larger than the pipe buffer would otherwise deadlock against a child
    // that's already producing output.
    let mut stdin = child.stdin.take().ok_or("claude stdin unavailable")?;
    let prompt_text = text.to_string();
    let stdin_thread = std::thread::spawn(move || {
        let _ = stdin.write_all(prompt_text.as_bytes());
    });
    let mut stdout_pipe = child.stdout.take().ok_or("claude stdout unavailable")?;
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout_pipe.read_to_string(&mut buf);
        buf
    });
    let mut stderr_pipe = child.stderr.take().ok_or("claude stderr unavailable")?;
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr_pipe.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + PROMPT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                child.kill().ok();
                child.wait().ok();
                return Err(format!(
                    "{} took longer than {}s and was stopped — try again, or pick a faster model in the AI switch",
                    agent.binary(),
                    PROMPT_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(format!("claude wait: {e}")),
        }
    };

    stdin_thread.join().ok();
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();

    // Operational failures — an expired login, a rate limit — come back as a
    // result envelope on STDOUT, with a non-zero exit and an *empty* stderr.
    // So checking the status first and reporting stderr produced
    // "claude exited with Some(1): ": an error message containing no error,
    // while the CLI's own explanation sat unread in the envelope. Whenever
    // there is an envelope, it is the better source.
    let file_answer = answer_file.as_ref().and_then(|path| {
        let text = std::fs::read_to_string(path).ok();
        let _ = std::fs::remove_file(path);
        text
    });

    if !status.success() {
        let name = agent.binary();
        // Codex prints its whole session banner and the echoed prompt to
        // stderr before failing, so the raw stream is a page of noise with the
        // reason at the bottom. It marks the reason itself — `ERROR: {json}` —
        // and that line is the message.
        if agent == Agent::Codex {
            if let Some(reason) = codex_error(&stderr) {
                return Err(with_hint(agent, &binary, format!("{name}: {reason}")));
            }
        }
        return Err(match parse_answer(agent, &stdout, file_answer.as_deref()) {
            Err(reason) if !stdout.trim().is_empty() => with_hint(agent, &binary, reason),
            _ if !stderr.trim().is_empty() => {
                with_hint(agent, &binary, format!("{name}: {}", stderr.trim()))
            }
            _ => format!(
                "{name} exited with {:?} and reported nothing — run `{name}` in a terminal to check it starts and is signed in",
                status.code()
            ),
        });
    }
    parse_answer(agent, &stdout, file_answer.as_deref())
}

/// Pull the answer out of whatever the agent produced.
fn parse_answer(
    agent: Agent,
    stdout: &str,
    file_answer: Option<&str>,
) -> Result<String, String> {
    match agent {
        Agent::ClaudeCode => parse_result_envelope(stdout),
        Agent::Codex => {
            // Preferred: the last-message file, which is exactly the answer
            // and nothing else. Falling back to stdout means scraping a
            // transcript, so it is only worth doing when the file is missing
            // — an older CLI without --output-last-message.
            if let Some(text) = file_answer.map(str::trim).filter(|t| !t.is_empty()) {
                return Ok(text.to_string());
            }
            let text = stdout.trim();
            if text.is_empty() {
                return Err(
                    "codex produced no output — run `codex exec` in a terminal to check it is signed in"
                        .into(),
                );
            }
            Ok(text.to_string())
        }
    }
}

/// Point at the fix when the message is one dedup can recognise. An expired
/// login is by far the most common failure here and is not self-evidently
/// solvable from inside the app — dedup cannot re-authenticate the user's CLI.
/// The reason a failed Codex run gave, from its `ERROR: {json}` lines — the
/// API error's own `message` when the line is JSON, the line's text when it
/// isn't. The last one wins: Codex repeats the error, and a later line is
/// never less specific than an earlier one.
fn codex_error(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .filter_map(|line| line.trim().strip_prefix("ERROR:").map(str::trim))
        .filter(|rest| !rest.is_empty())
        .map(|rest| {
            serde_json::from_str::<serde_json::Value>(rest)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message")
                        .or_else(|| v.get("message"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| rest.to_string())
        })
        .last()
}

/// What to do about a failure, when the failure says. `binary` is the CLI that
/// actually ran — worth naming, because a machine can hold more than one copy
/// of an agent (a standalone install and one bundled in a desktop app) that
/// share one config file and disagree about what is in it.
fn with_hint(agent: Agent, binary: &Path, reason: String) -> String {
    let name = agent.binary();
    let lower = reason.to_lowercase();
    if lower.contains("authenticate")
        || lower.contains("oauth")
        || lower.contains("unauthorized")
        || lower.contains("log in")
        || lower.contains("login")
    {
        return format!("{reason} — run `{name}` in a terminal and sign in, then try again");
    }
    // A model the CLI's account or version can't use. dedup passes no model
    // unless one is picked in the AI switch, so this is the CLI's own default
    // — usually written into the shared config by a newer copy of the agent.
    if agent == Agent::Codex && lower.contains("model") && lower.contains("not supported") {
        return format!(
            "{reason} — dedup ran {}, which uses the `model` set in ~/.codex/config.toml. Update that CLI, or set a model it supports there.",
            binary.display()
        );
    }
    reason
}

/// `--output-format json` wraps the answer in an envelope; the text lives in
/// `result`. Errors surface as `is_error: true` or a missing field.
fn parse_result_envelope(stdout: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("unexpected claude output: {e}"))?;
    if value.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
        return Err(format!(
            "claude reported an error: {}",
            value.get("result").and_then(|v| v.as_str()).unwrap_or("unknown")
        ));
    }
    value
        .get("result")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "claude output had no result field".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape taken from a real `codex debug models`, trimmed.
    #[test]
    fn the_codex_catalog_is_what_its_own_picker_lists_in_its_order() {
        let json = r#"{"models":[
            {"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","visibility":"list","priority":8},
            {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","priority":4},
            {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":2},
            {"slug":"gpt-5.6-sol","display_name":"","visibility":"list","priority":6},
            {"slug":"gpt-6-astra","display_name":"dupe","visibility":"list","priority":9},
            {"slug":"codex-auto-review","visibility":"hide","priority":43}
        ]}"#;
        let got = parse_codex_catalog(json).unwrap();
        let pairs: Vec<(&str, &str)> =
            got.iter().map(|m| (m.value.as_str(), m.label.as_str())).collect();
        assert_eq!(
            pairs,
            vec![
                ("gpt-6-astra", "GPT-6-Astra"),
                // A blank display name falls back to the slug, not to "".
                ("gpt-5.6-sol", "gpt-5.6-sol"),
                ("gpt-5.6-terra", "GPT-5.6-Terra"),
            ],
            "hidden entries dropped, priority order, one row per slug"
        );
        assert!(parse_codex_catalog("not json").is_err());
        assert!(parse_codex_catalog(r#"{"other":[]}"#).is_err());
    }

    /// A real failure, trimmed: Codex echoes its banner and the whole prompt
    /// to stderr, then the reason as `ERROR: {json}` — twice.
    const CODEX_MODEL_REFUSED: &str = r#"OpenAI Codex v0.153.4
--------
model: gpt-6-sol
sandbox: read-only
--------
user
Generate one image for a web project and do nothing else.
<<<<<<< ASSET images/hero-port.webp
<absolute path of the generated image>
>>>>>>> END
warning: Model metadata for `gpt-6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}}
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}}
"#;

    #[test]
    fn a_codex_failure_is_its_error_line_not_its_transcript() {
        assert_eq!(
            codex_error(CODEX_MODEL_REFUSED).as_deref(),
            Some("The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."),
        );
        // A plain-text error line is still the reason.
        assert_eq!(codex_error("banner\nERROR: stream disconnected").as_deref(), Some("stream disconnected"));
        // No marked reason: nothing to extract, so the caller falls back.
        assert_eq!(codex_error("banner\nwarning: something"), None);
    }

    #[test]
    fn a_refused_model_names_the_binary_and_where_the_model_is_set() {
        let reason = format!("codex: {}", codex_error(CODEX_MODEL_REFUSED).unwrap());
        let msg = with_hint(Agent::Codex, Path::new("/usr/local/bin/codex"), reason);
        assert!(msg.contains("/usr/local/bin/codex"), "{msg}");
        assert!(msg.contains("~/.codex/config.toml"), "{msg}");
        assert!(!msg.contains("OpenAI Codex v"), "the transcript stays out: {msg}");
    }

    /// The sign-in hint used to say `claude` whatever had failed.
    #[test]
    fn the_sign_in_hint_names_the_agent_that_failed() {
        let msg = with_hint(Agent::Codex, Path::new("codex"), "codex: unauthorized".into());
        assert!(msg.contains("run `codex`"), "{msg}");
        let msg = with_hint(Agent::ClaudeCode, Path::new("claude"), "please log in".into());
        assert!(msg.contains("run `claude`"), "{msg}");
    }

    #[test]
    fn parses_the_result_envelope() {
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"components\":[]}"}"#;
        assert_eq!(parse_result_envelope(ok).unwrap(), "{\"components\":[]}");

        let err = r#"{"type":"result","is_error":true,"result":"rate limited"}"#;
        assert!(parse_result_envelope(err).unwrap_err().contains("rate limited"));

        assert!(parse_result_envelope("not json").is_err());
        assert!(parse_result_envelope(r#"{"type":"result"}"#).is_err());
    }

    /// Regression: an expired login exits 1 with an EMPTY stderr and puts the
    /// reason in the envelope on stdout. Reporting stderr gave the user
    /// "claude exited with Some(1): " — a failure message with the failure
    /// removed, and no way to guess that they simply needed to sign in.
    /// The two agents differ only in how they are invoked, so that is what
    /// gets pinned: a prompt must never become an argv entry (these carry
    /// whole source files), and neither may be handed tools or write access —
    /// dedup does its own editing through the parse-gated write-back, and a
    /// second path to the user's source would be an unaudited one.
    #[test]
    fn each_agent_is_invoked_headlessly_and_without_tools() {
        let claude = Agent::ClaudeCode.args(Some("sonnet"), None);
        assert!(claude.contains(&"-p".to_string()));
        assert!(claude.contains(&"--tools".to_string()));
        assert_eq!(
            claude.iter().filter(|a| *a == "sonnet").count(),
            1,
            "the model must be passed through"
        );

        let answer = Path::new("/tmp/answer.txt");
        let codex = Agent::Codex.args(Some("gpt-5.6-sol"), Some(answer));
        assert_eq!(codex.first().unwrap(), "exec", "non-interactive mode");
        assert!(
            codex.windows(2).any(|w| w == ["--sandbox", "read-only"]),
            "dedup wants words, not edits: {codex:?}"
        );
        assert!(
            codex.contains(&"--skip-git-repo-check".to_string()),
            "we run from a neutral temp dir, which is not a repo"
        );
        assert_eq!(
            codex.last().unwrap(),
            "-",
            "the prompt goes on stdin — these carry whole files and would blow the arg limit"
        );
        assert!(codex.contains(&"/tmp/answer.txt".to_string()));
    }

    /// Codex's final message comes from the file when it wrote one; stdout is
    /// only a fallback for a CLI too old to have the flag.
    #[test]
    fn codex_prefers_its_last_message_file_over_the_transcript() {
        let transcript = "thinking...\nrunning...\nsome trailing chatter";
        assert_eq!(
            parse_answer(Agent::Codex, transcript, Some("  the answer  ")).unwrap(),
            "the answer"
        );
        // No file (older CLI): fall back rather than fail.
        assert_eq!(
            parse_answer(Agent::Codex, "  the answer  ", None).unwrap(),
            "the answer"
        );
        // An empty file is not an answer.
        assert_eq!(
            parse_answer(Agent::Codex, "from stdout", Some("   ")).unwrap(),
            "from stdout"
        );
        assert!(parse_answer(Agent::Codex, "  ", None).is_err());
    }

    #[test]
    fn agent_names_round_trip_from_the_frontend() {
        assert_eq!(Agent::parse("claude-code"), Some(Agent::ClaudeCode));
        assert_eq!(Agent::parse("codex"), Some(Agent::Codex));
        assert_eq!(Agent::parse("gemini"), None);
    }

    #[test]
    fn an_expired_login_reports_its_real_reason() {
        let envelope = r#"{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}"#;
        let reason = with_hint(Agent::ClaudeCode, Path::new("claude"), parse_result_envelope(envelope).unwrap_err());
        assert!(reason.contains("OAuth session expired"), "{reason}");
        assert!(reason.contains("sign in"), "must point at the fix: {reason}");
    }

    #[test]
    fn hints_are_only_added_where_they_apply() {
        let rate = with_hint(Agent::ClaudeCode, Path::new("claude"), "claude reported an error: rate limited".to_string());
        assert_eq!(rate, "claude reported an error: rate limited");
        assert!(with_hint(Agent::ClaudeCode, Path::new("claude"), "Unauthorized".to_string()).contains("sign in"));
    }
}
