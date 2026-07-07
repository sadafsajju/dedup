//! Claude Code CLI bridge — lets the AI features (categorization, mock
//! props, later the Phase-4 merge proposals) run through the user's local
//! Claude Code install and subscription instead of a raw API key. One-shot
//! headless invocation: prompt on stdin, JSON envelope on stdout.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Generous ceiling for one prompt (big files on a slow model are legitimate);
/// the point is that the UI can never hang forever.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

/// `claude` from PATH, with the usual install locations as fallbacks
/// (GUI-launched apps get a minimal PATH).
pub fn find_claude() -> Option<PathBuf> {
    if let Ok(out) = Command::new("claude").arg("--version").output() {
        if out.status.success() {
            return Some(PathBuf::from("claude"));
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    for candidate in [
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".into(),
        "/usr/local/bin/claude".into(),
        format!("{home}/.local/bin/claude"),
    ] {
        if Path::new(&candidate).exists() {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

pub fn available() -> bool {
    find_claude().is_some()
}

/// Run one headless prompt through Claude Code and return the result text.
/// `model` is a CLI alias or full id ("sonnet", "opus", …); None keeps the
/// user's CLI default.
///
/// The invocation is deliberately stripped down: no settings/CLAUDE.md, no
/// MCP servers, no tools, no session files, no skills. dedup only wants a
/// text completion — everything else is startup cost and, worse, a hang
/// surface (an MCP server that blocks stalls the whole prompt). A hard
/// timeout kills the child so the UI can never wait forever.
pub fn prompt(text: &str, model: Option<&str>) -> Result<String, String> {
    let claude = find_claude().ok_or("Claude Code CLI not found")?;

    let mut cmd = Command::new(claude);
    cmd.args([
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
    ]);
    if let Some(model) = model {
        cmd.args(["--model", model]);
    }
    let mut child = cmd
        // Neutral cwd — never load project context from wherever dedup runs.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

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
                    "claude took longer than {}s and was stopped — try again, or pick a faster model in the AI switch",
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
    if !status.success() {
        return Err(format!(
            "claude exited with {:?}: {}",
            status.code(),
            stderr.trim()
        ));
    }
    parse_result_envelope(&stdout)
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

    #[test]
    fn parses_the_result_envelope() {
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"components\":[]}"}"#;
        assert_eq!(parse_result_envelope(ok).unwrap(), "{\"components\":[]}");

        let err = r#"{"type":"result","is_error":true,"result":"rate limited"}"#;
        assert!(parse_result_envelope(err).unwrap_err().contains("rate limited"));

        assert!(parse_result_envelope("not json").is_err());
        assert!(parse_result_envelope(r#"{"type":"result"}"#).is_err());
    }
}
