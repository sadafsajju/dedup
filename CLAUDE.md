# dedup — working notes for agents

macOS Tauri 2 app: opens a React+Tailwind codebase, Figma-style inspection and
Tailwind editing with AST write-back, and (the differentiator) duplicate
component detection + guarded merging. **Read `dedup-mvp-prd.md` before
non-trivial work; check `PROGRESS.md` for phase status, decisions already
made, and known limitations — don't re-litigate settled decisions.**

## Commands

```sh
pnpm tauri dev          # run the app (watches src-tauri, HMRs frontend)
pnpm build              # tsc + vite build (frontend typecheck)
pnpm build:plugin       # bundle plugin-src/ → src-tauri/assets/ (REQUIRED after editing plugin-src/)
pnpm test:plugin        # tagger + write-back smoke tests (tests the BUILT bundles)
pnpm test:tw            # tailwind class⇄knob mapping tests
cargo test              # from src-tauri/ — all Rust tests
```

## Architecture map

- `src-tauri/src/` — Rust core: `project.rs` (detection), `devserver.rs`
  (child process in own pgroup, log streaming, ready-URL parse), `proxy.rs`
  (HTTP→self-signed-HTTPS tunnel for the canvas), `instrument.rs` (writes
  plugin assets into the user's `node_modules/.dedup/`, rewrites vite launch),
  `sidecar.rs` (one-shot node runner for write-back), `git.rs` (session
  branch + scoped commits).
- `plugin-src/` — JS that runs *inside the user's project*: `tagger.mjs`
  (Vite plugin stamping `data-dedup-id="file:line:col"`), `overlay.js`
  (in-iframe hover/select/live-patch/preview + postMessage bridge),
  `writeback.mjs` (AST className inspect/rewrite). Bundled self-contained by
  `build.mjs` — never depends on the user's node_modules.
- `src/` — editor frontend (React 19 + Tailwind v4 + zustand):
  `lib/store.ts` (all state incl. staged edits), `lib/tailwind.ts`
  (class⇄knob mapping), `lib/bridge.ts` (iframe messaging),
  `components/` (LaunchScreen/Editor/Canvas/Inspector/StylePanel/ReviewPanel).

## Gotchas (hard-won)

- `src-tauri/assets/*` are embedded via `include_str!`. After
  `pnpm build:plugin`, the tauri-dev watcher does NOT notice the asset change
  — `touch src-tauri/src/instrument.rs` to force the rebuild/restart.
- Overlay/tagger/writeback reach the user's project at **dev-server start**
  (`instrument::setup`) — plugin changes require the user to reopen the
  project, not just an app restart.
- tauri-dev hot-restarts kill the app hard → the user-project dev server can
  be orphaned. Check `lsof -nP -iTCP:5173 -sTCP:LISTEN` after restarts; kill
  leftovers.
- Vite on macOS binds `[::1]` (IPv6) only; anything dialing the dev server
  must try IPv6 loopback first.
- Tailwind JIT: classes not present in source have NO generated CSS — that's
  why the overlay mirrors staged classes as inline styles (theme-var based).
- Write-back edit positions come from one parse (magic-string ranges), so
  batch edits per file need no ordering; but ids of *later elements on the
  same line* go stale after a save shifts columns.

## Conventions

- Safety model is non-negotiable (PRD §6): writes only on `dedup/session-*`
  branches, commit per save touching only dedup's files, output re-parsed
  before any file write. One corrupted user codebase kills the product.
- User's source/config are never mutated for tooling — everything injected
  lives in `node_modules/.dedup/` or served virtually.
- Honesty over magic: what can't be edited safely is read-only with a reason.
- Commit style: imperative subject, body explains the *why* and mechanism;
  update `PROGRESS.md` at phase completion and for significant decisions.
- Every phase lands with tests (Rust + plugin smoke); test the built
  artifacts, not just sources.
