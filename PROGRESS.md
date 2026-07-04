# dedup — build progress

Tracks phase completion against [dedup-mvp-prd.md](./dedup-mvp-prd.md).
Updated at the end of every phase (and for significant mid-phase decisions).
Format per phase: what shipped, FR coverage, deviations from the PRD, and
known limitations accepted knowingly.

**Current state: Phases 0–3 complete. Next: Phase 4 (guarded merge).**

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
- ~~Clicks are always swallowed in the canvas (no interact-mode toggle yet).~~
  Resolved: the Browse tool (floating toolbar, Phase 3 addendum) passes
  clicks through to the app.
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

## Phase 3 — Scan ✅ (2026-07-03 → 07-04)

Component inventory + structural similarity + cluster review UI, plus a large
run of addenda: rendered component artboards, Figma-style canvas navigation,
AI categorization/mock-props with a Claude Code **or** API backend, and
several FR-1.6 robustness fixes. Semantic signal stays opt-in; the visual
similarity *pass* (perceptual-hash scoring) remains Phase 5, though isolated
component rendering — its prerequisite — now exists.

| FR | Status | Notes |
|---|---|---|
| FR-5.1 component inventory | ✅ | Scan sidecar walks the project, extracts function components (incl. `memo`/`forwardRef` wrappers): name, file:line, props, export kind, simplified JSX tree. Skips node_modules/dist/hidden dirs, >512 KB and unparseable files |
| FR-5.2 similarity scoring | ◐ | **Structural signal only** (per milestone cut): Zhang–Shasha tree edit distance on simplified JSX trees (pre-order sequence fallback above 10k node-product) + class comparison where `p-4` vs `p-6` and `bg-red-500` vs `bg-blue-600` count as "same knob, different value" + prop-name overlap. Weights 0.6/0.3/0.1, cluster threshold 0.8, union-find. Visual → Phase 5, semantic → opt-in pending embeddings decision |
| FR-5.3 cluster review UI | ◐ | Duplicates tab: ranked cluster list (confidence × call sites), badge count. Review modal: side-by-side JSX skeletons with per-line agreement highlighting + class-token diff chips, remove-member, "Not duplicates" persisted per project (localStorage, keyed by member-set hash). Rendered previews shipped as canvas artboards (see addendum below); the modal keeps skeleton diffs |
| Scan button + progress | ✅ | TopBar Scan streams sidecar progress lines as `scan://progress` events (inventory / similarity stages) |

**Decisions / deviations**
- **Canvas-scoped scan:** the scan clusters only components on the current
  canvas page (the overlay reports the source files behind the rendered DOM;
  the sidecar filters clustering to them). The whole project is still parsed
  so call-site counts stay project-wide truth. No running canvas / untagged
  project → falls back to a whole-project scan; the Duplicates header always
  labels which scope ran ("Current page · N files" / "Whole project").
  Deviation from the PRD's codebase-wide scan — product call (2026-07-03).
- **@babel/parser, not SWC:** the PRD said SWC-based, but the tagger and
  write-back sidecars already ship a bundled @babel/parser — one parser, one
  sidecar pattern (JSON in / JSON lines out, bundle in `node_modules/.dedup/`).
  Perf is a non-issue at MVP scale: 40 components scan in ~130 ms; the 300-
  component / ≤90 s NFR has orders of magnitude of headroom.
- Detection is fully deterministic (no LLM anywhere in the scan path) — scores
  are reproducible and explainable by construction.
- Components with a single JSX element are excluded from clustering (they'd
  cluster the world); two-element components stay in — real duplicates are
  often that small.
- Cluster confidence = mean pairwise similarity across members.

**Also shipped (FR-5.2/5.3 pulled forward): rendered component artboards**
- Scan now renders every *qualifying* component (structural composites and
  interactive controls — pure text wrappers and svg-only icons filtered out)
  as Figma-style artboards beside the app frame. Cluster members sit together
  inside an accent group frame labeled with confidence + call sites; clicking
  a member opens the cluster review. Canvas auto-pans to the artboard field
  when a scan lands.
- Mechanism: the tagger plugin serves `/__dedup/harness?file=&name=` — an
  HTML shell + Vite virtual module that dynamically imports the component,
  renders it with neutral props inside an error boundary (project global CSS
  auto-imported for Tailwind theme), and reports natural size or failure via
  postMessage. Components that can't render in isolation show "Can't render
  in isolation" + reason instead of a preview (PRD graceful-degradation rule).
- Off-screen artboards aren't mounted (position-math culling) so large
  galleries don't spawn dozens of live iframes at once.
- Harness renders bare first, and retries inside a `MemoryRouter` when the
  failure is router-shaped (covers `useNavigate` et al without double-wrapping
  components that own a Router); router package availability is decided
  server-side at module generation. App shells (`App`, `*Routes`, `*Router`,
  `*Provider`, `*Layout`) are excluded from the gallery; file-local
  (unexported) components show a "Not exported" placeholder instead of a
  doomed import. Served through `transformIndexHtml` so plugin-react's
  refresh preamble applies (raw middleware HTML broke every module load).
- Vite-only, like all instrumentation (Next.js in Phase 5). Browser-level
  render verified down to the served, transformed harness module; in-app
  visual confirmation pending next dogfood session.
- **Scan results persist per project** (`node_modules/.dedup/scan-result.json`,
  written on every successful scan): reopening the project restores the last
  gallery/clusters/artboards immediately — no rescan ritual. The Duplicates
  header shows the scan's age; only a *fresh* scan auto-pans the canvas to
  the artboard field. Wiped by a node_modules reinstall (then just rescan).

**Also shipped: AI component categorization (organization, not detection)**
- **One-button flow:** Scan runs the whole pipeline — deterministic
  inventory/clustering, then (when an AI backend is connected) AI
  categorization automatically: cached assignments apply first, only
  new/changed components hit the model. TopBar shows Scanning… →
  Organizing…; the Duplicates tab shows a status strip, never extra buttons.
- Auto-organize categorizes scanned components with
  Claude (`claude-opus-4-8`, structured outputs) into a fixed vocabulary —
  Buttons / Cards / Forms & Inputs / Navigation / … — and the artboard field
  reflows into Framer-style labeled category sections; cluster groups stay
  intact inside their anchor member's section. **The trust boundary holds:**
  the LLM only names what components are; duplicate detection remains fully
  deterministic.
- **TopBar AI switch:** backend choice is explicit — an `AI: Claude Code /
  API / off` chip opens a popover: Claude Code connects via a consent step
  (one live test prompt verifies the CLI login before dedup ever uses the
  subscription; disconnectable), the API side holds the key entry (moved out
  of the Duplicates tab, masked, removable). No silent backend use; choice
  and consent persist in localStorage. Duplicates strip is status-only.
- **Claude Code as an AI backend:** when the `claude` CLI is
  installed and the user connects it (TopBar switch → Connect), AI calls run
  headlessly through it (`claude -p --output-format json`, prompt on stdin —
  the same one-shot sidecar pattern as the tagger/scan bundles) on the user's
  existing subscription, no API key. The API key (also in the TopBar switch,
  stored locally) is the alternative backend; the API path keeps
  schema-enforced structured outputs, the CLI path uses prompt-requested JSON
  with lenient extraction. Live-verified against the real CLI envelope.
- Privacy either way: prompts carry only component names, file paths, prop
  names, and capped tag/class skeletons — never source.
- **AI mock props:** the same Scan-time call also invents realistic demo
  props per component (from prop names + skeleton; JSON-string field since
  structured-output objects must be closed schemas; validated client-side).
  The harness renders with them — prop-dependent components (ReceiptCard's
  `order.orderNumber`) preview with plausible data instead of erroring; bad
  guesses degrade to the neutral-props behavior. Cached alongside categories.
- **File-local components render now:** the tagger appends a virtual
  `export { Name }` when the harness imports with `?dedup-export=Name` — the
  query makes it a separate module, so the app's own imports are untouched.
  Replaces the "Not exported" placeholder with a real preview.
- Assignments cached in `node_modules/.dedup/categories.json` keyed by
  skeleton hash — unchanged components are never re-sent; re-categorize only
  processes new/changed ones. Cached categories apply instantly on scan
  restore with zero API calls.

**Also shipped (honesty rule, FR-1.6)**
- **Explicit "inspection off" state:** uninstrumented sessions (Next.js,
  custom dev command, non-`vite` script, tagging failure) now emit a
  `devserver://instrumentation` event; the Inspector explains *why* clicking
  won't select instead of showing the generic hint, and the compat card
  marks Next.js as partial with the Phase 5 note. Previously dedup degraded
  silently and inspection just "didn't work".

**Also shipped (FR-1.6 failure recovery)**
- **Stale dev-server auto-cleanup:** when Next refuses to start because an
  orphaned sibling still holds the project ("Another next dev server is
  already running"), dedup parses the PID/Dir from the refusal, verifies the
  PID is a live `next` process for the *same* project, kills it (TERM→KILL),
  and retries once — instead of showing a crash and telling the user to run
  `kill` by hand. The stale server's own `- Local:` line is also excluded
  from ready-URL detection (previously the canvas could silently attach to
  the dying orphan). Fixed alongside: a StrictMode listener leak that
  rendered every console line twice.

**Also shipped (FR-6.1 canvas UX)**
- **Frame label** (Figma artboard name): the page's own `document.title` +
  route (reported by the overlay) with the viewport preset, floating above
  the frame — pans with it, never scales. Falls back to the project name on
  uninstrumented sessions.
- **Floating canvas toolbar** (Figma-style, bottom-center): Select (V),
  Hand (H — Space still works as momentary), and **Browse (B)** — clicks pass
  through to the user's app so it can be navigated in place, resolving the
  Phase 1 "clicks are always swallowed" limitation. Overlay re-asserts the
  active tool after full-reload HMR. Zoom controls moved here from the TopBar.
- **Figma-style canvas navigation**, replacing the scroll-box: trackpad
  scroll pans freely, pinch / ⌘+scroll zooms toward the cursor, Space+drag is
  a hand tool, middle-drag pans, the dot grid moves and scales with the
  canvas, and TopBar ± zooms about the viewport center. The overlay forwards
  wheel events from inside the iframe (which otherwise swallows them) unless
  an inner scrollable panel can consume the scroll — nested app panels keep
  scrolling natively. Frame re-centers on viewport switch.

**Known limitations**
- Call-site counts are name-based (`<Name` occurrences project-wide), not
  import-resolved — same-named components in different files pool their counts.
- Similarity uses each component's **largest** JSX root; alternate conditional
  returns aren't compared.
- Structurally identical wrapper sets (e.g. an icon library: all `svg > path`)
  cluster legitimately and read as noise — dismissible, and the dismissal
  sticks per project.
- Dismissal keys on the member set — if a cluster gains/loses a member on a
  later scan it resurfaces (arguably correct: new evidence).

Then Phase 4 (guarded merge), Phase 5 (harden + Next.js).

---

## Verification inventory

- `cargo test` (src-tauri): 27 — URL/ANSI parsing, project detection,
  instrumentation, tunnel (real TLS upstream, IPv6-only), sidecar (real node
  spawn E2E), git branch/commit isolation, Next stale-lock parsing, scan
  persist/restore round-trip, Claude Code result-envelope parsing.
- `pnpm test:plugin`: 16 — tagger transform (fragments, generics, sourcemaps,
  virtual-export for file-local components + unsafe-name rejection) +
  write-back program E2E via child process (inspect/write/insert/batch/reject).
- `pnpm test:scan`: 10 — scan bundle E2E via child process: near-dup clustering
  + unrelated separation, canvas-scope filtering (project-wide call sites),
  knob-value equivalence, trivial-component exclusion, node_modules/garbage
  resilience, memo/forwardRef, progress stream, gallery filter (structural +
  interactive; text/icons/app-shells excluded), gallery cluster-id + schema.
- `pnpm test:tw`: 10 — class⇄knob mapping, spacing precedence + regeneration.
- Manual E2E: wrapper config against a real Vite app (tags + overlay + harness
  served); Claude Code CLI envelope round-trip; dogfooded on mintWash.
- Not yet auto-covered: in-app artboard render, AI categorization/mock-props
  end-to-end (needs a live backend), the canvas navigation gestures.
