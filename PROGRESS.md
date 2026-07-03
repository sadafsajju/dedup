# dedup — build progress

Tracks phase completion against [dedup-mvp-prd.md](./dedup-mvp-prd.md).
Updated at the end of every phase (and for significant mid-phase decisions).
Format per phase: what shipped, FR coverage, deviations from the PRD, and
known limitations accepted knowingly.

**Current state: Phases 0–2 complete. Next: Phase 3 (duplicate scan).**

---

## Phase 0 — Spike ✅ (2026-07-03)

Tauri 2 shell + project open + dev-server child process + webview canvas.

| FR | Status | Notes |
|---|---|---|
| FR-1.1 open/drag/recents | ✅ | Native picker, drag-onto-window, persisted recents |
| FR-1.2 detection + compat card | ✅ | pm / Vite·Next / Tailwind / TS / git, full/partial/unsupported verdict |
| FR-1.3 managed dev server | ✅ | Own process group (killpg teardown), log streaming, ready-URL parse, custom command escape hatch |
| FR-1.4 canvas + viewports | ✅ | iframe; mobile/tablet/desktop widths, ⌘-scroll zoom |
| FR-1.5 git state check | ✅ | Dirty-tree acknowledgement gate on the compat card |
| FR-1.6 failure states | ✅ | Crash panel + restart, slow-start hint, console drawer; port conflicts delegated to Vite's auto-increment |

**Decisions / deviations**
- Canvas is an **iframe**, not a native child webview — the postMessage bridge
  works cross-origin and is massively simpler. Holds unless a target app sends
  frame-blocking headers (Vite/Next don't by default).
- **HTTPS auto-tunnel:** WKWebView can't trust self-signed certs
  (@vitejs/plugin-basic-ssl projects rendered blank), so the Rust core fronts
  https dev servers with a local plain-HTTP TCP↔TLS splice tunnel. Dials IPv6
  loopback first (Vite on macOS binds `[::1]` only), IPv4 fallback.
- Dev server exits are killed by process group on stop, window close, *and*
  app exit (⌘Q leaked children before).

**Known limitations**
- `tauri dev` hot-restarts kill the app hard → a running project dev server
  can be orphaned during *dedup development only* (`lsof -ti:5173 | xargs kill`).
- Dev scripts that prompt interactively will hang (stdin is null); the PTY
  escape hatch is noted for Phase 5.

## Phase 1 — Mapping ✅ (2026-07-03)

Element↔source tagging + hover/select overlay + selection UI.

| FR | Status | Notes |
|---|---|---|
| FR-2.1 build-time tagging | ✅ | Vite plugin (bundled @babel/parser + magic-string) stamps `data-dedup-id="file:line:col"` + enclosing component name. Served-JS only — **user source and config never touched** (explicit anti-Onlook decision) |
| FR-2.2 hover/select overlay | ✅ | Injected script: hover highlight + badge, click-to-select (inspect-don't-activate), postMessage bridge both directions |
| FR-2.3 AST node resolution | ✅* | Resolution happens in the write-back sidecar at inspect/save time (Phase 2), keyed by the stamped file:line:col |
| FR-2.4 ancestry breadcrumb | ✅ | DOM-derived component chain, clickable re-selection |
| `.map()` limitation | ✅ | ×N instances badge from live DOM count |

**Mechanism:** assets are written to `node_modules/.dedup/` (git-invisible);
dev launch is rewritten to `node_modules/.bin/vite --config <wrapper>` where
the wrapper imports the user's real config and prepends the tagger. Anything
not confidently rewritable (non-`vite` scripts, pinned `--config`, custom
command) runs uninstrumented with a console note.

**Known limitations**
- Only project source is tagged — third-party components don't highlight.
- Clicks are always swallowed in the canvas (no interact-mode toggle yet).
- Fragments can't carry tags (React limitation) — children are tagged instead.

## Phase 2 — Inspector ✅ (2026-07-03)

Figma-style panel + live editing + AST write-back + git safety model.

| FR | Status | Notes |
|---|---|---|
| FR-3.1 selection header | ✅ | Component, tag, file:line:col, ×N badge (reveal-in-editor pending) |
| FR-3.2 layout section | ✅ | Display, flex direction/justify/align, gap, 4-way padding + margin (minimal-form regeneration: `p-6` / `py-1 px-2` / per-side / negatives) |
| FR-3.3 size section | ✅ | w/h/min/max, scale steppers on gap, arbitrary values |
| FR-3.4 typography | ✅ | Size, weight, align, color |
| FR-3.5 fill & border | ◐ | bg / border width+color / radius / shadow. **Deferred:** theme-token color picker (colors typed as Tailwind names for now) |
| FR-3.6 raw classes field | ✅ | Textarea escape hatch |
| FR-3.7 live + staged | ✅ | Instant DOM patch to all instances, survives HMR; nothing on disk until ⌘S |
| FR-4.1 AST write-back | ✅ | Surgical magic-string range replacement — formatting untouched by construction; output re-parsed before write (never corrupt). **Deviation:** Prettier not run — unnecessary when only the class string range changes |
| FR-4.2 honesty rule | ✅ | `cn(...)`/vars/conditionals → read-only with human reason. **Deferred:** static-base template editing (fully static templates work) |
| FR-4.3 HMR verify | ◐ | Selection re-syncs from source ~1s post-save; no formal re-read assertion yet |
| FR-4.4 undo/redo | ✅ | Snapshot-based staged-edit stack (pre-save); post-save revert = session history panel, pending (flow C) |
| FR-4.5 commit per save | ✅ | `dedup: adjust classes on <Components>`; commits **only dedup's files** — user's own staged index preserved (tested) |
| FR-4.6 session branch | ✅ | `dedup/session-<stamp>` created on first write; never writes to the user's branch; git required to save |

**Beyond the PRD (earned by dogfooding)**
- **Staged-diff review panel** — TopBar "N edits" popover: token-level class
  diffs (red removed / green added), click-to-select, per-edit undoable revert.
- **Live preview interpreter** — Tailwind JIT has no CSS for classes not yet
  in source, so staged classes are mirrored as inline styles resolving through
  the project's own Tailwind v4 theme variables (`--spacing`, `--color-*`);
  cleaned up on revert/save.
- **Full-page canvas frames** — overlay reports natural page height
  (mutation-driven, feedback-loop-safe, 12000px cap); frame grows to fit,
  canvas pans. Caveat: `fixed`/`sticky`/`vh` semantics shift (Figma-model
  tradeoff); per-project "device viewport" toggle is the known follow-up.

**Known limitations**
- Elements *after* an edited element on the same source line keep stale ids
  until re-selected (class-length changes shift columns).
- Preview interpreter covers the panel's knob set; uncovered classes apply
  correctly on save but don't preview if unused in the project.
- Tailwind v3 projects: color preview needs `--color-*` vars (v4) — falls back
  to no preview.

## Phase 3 — Scan (next)

Component inventory (FR-5.1), structural similarity (FR-5.2 partial),
cluster review UI (FR-5.3). Semantic/visual signals stubbed per milestone
plan. Then Phase 4 (guarded merge), Phase 5 (harden + Next.js).

---

## Verification inventory

- `cargo test` (src-tauri): 22 — URL/ANSI parsing, project detection,
  instrumentation, tunnel (real TLS upstream, IPv6-only), sidecar (real node
  spawn E2E), git branch/commit isolation.
- `pnpm test:plugin`: 14 — tagger transform (fragments, generics, sourcemaps)
  + write-back program E2E via child process (inspect/write/insert/batch/reject).
- `pnpm test:tw`: 10 — class⇄knob mapping, spacing precedence + regeneration.
- Manual E2E: wrapper config against a real Vite app (tags + overlay served);
  dogfooded on mintWash.
