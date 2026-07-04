//! Claude Code CLI bridge — lets the AI features (categorization, mock
//! props, later the Phase-4 merge proposals) run through the user's local
//! Claude Code install and subscription instead of a raw API key. One-shot
//! headless invocation: prompt on stdin, JSON envelope on stdout.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
pub fn prompt(text: &str) -> Result<String, String> {
    let claude = find_claude().ok_or("Claude Code CLI not found")?;

    let mut child = Command::new(claude)
        .args(["-p", "--output-format", "json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("claude stdin unavailable")?
        .write_all(text.as_bytes())
        .map_err(|e| format!("claude stdin write: {e}"))?;

    let out = child
        .wait_with_output()
        .map_err(|e| format!("claude wait: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude exited with {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    parse_result_envelope(&String::from_utf8_lossy(&out.stdout))
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
