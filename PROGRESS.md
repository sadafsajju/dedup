# dedup — build progress

Tracks phase completion against [dedup-mvp-prd.md](./dedup-mvp-prd.md).
Updated at the end of every phase (and for significant mid-phase decisions).
Format per phase: what shipped, FR coverage, deviations from the PRD, and
known limitations accepted knowingly.

**Current state: Phases 0–5 complete.**
(Plus a 2026-08-22 inspector/chrome UI pass, a 2026-08-23 structural-editing
+ element-identity rework, and a 2026-08-28 floating-canvas redesign — see the
interludes below.)

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
  canvas pans. Two runtime-only assists make this hold for app-shell pages
  (mintWash-verified): a **vh-freeze** stylesheet pins Tailwind's
  `h-screen`/`*-dvh|svh|lvh` classes to the device viewport height (sent by
  the editor via `set-viewport`, incl. after HMR overlay reloads) so
  `min-h-screen` sections keep their designed proportions as the frame grows;
  and **page-scroller unpinning** sets `height:auto` on viewport-pinned
  full-width scrollers (`100dvh` + `overflow-y-auto` shells, e.g. Lenis
  wrappers) so the document, not an inner scrollbar, carries the true height.
  Width filter (≥60%) leaves sidebars/chat panels scrolling on their own.
  Caveat: `fixed`/`sticky` and non-class vh usages still shift (Figma-model
  tradeoff); per-project "device viewport" toggle is the known follow-up.
- **Pages as artboards, spawned by navigation** — the canvas starts with just
  the root frame; navigating (browse mode) pins the destination as a new
  full-height page artboard at the end of the row and snaps the originating
  frame back to its route (soft popstate replay, hard `location.replace`
  fallback), auto-panning to the new artboard. The overlay flags navigations
  within 1.5s of a pointer/key gesture; app-initiated redirects (auth guards)
  don't spawn — the frame stays put and its label shows the drift
  (`/orders → /welcome`, warn tint). Since all frames share one origin,
  logging in once in any frame makes gated artboards render for real. The
  bridge is multi-frame: frames register per route, commands broadcast
  (staged classes, tool mode, vh-freeze stay consistent), incoming
  page-size/wheel messages key by source window, `requestCanvasFiles` unions
  all frames, selection syncs via `select-id` broadcast (non-holders clear).
  Root frame always stays mounted; off-screen route frames unmount via the
  same culling math as component artboards.
  **Guest-origin frames:** signing in flips apps with reverse auth guards
  (`state.user ? <Navigate away>`) on every public-page artboard — all frames
  share the origin's localStorage. Fix: the editor probes for the same dev
  server under an alternate loopback spelling (`[::1]` vs `localhost` vs
  `127.0.0.1`, via the CORS-open `/__dedup/routes` endpoint; works through
  the https tunnel too, which binds 127.0.0.1). A different host string is a
  different origin — separate storage, logged out. When a pinned frame
  drift-redirects without a user gesture, it retries once on the guest origin
  (labeled "guest"); if that also redirects (page truly needs auth), it stays
  on the shared origin with the drift label and stops flipping. Net effect:
  public pages survive login, gated pages keep the session. Route discovery
  (`/__dedup/routes`: conservative regex scan, static react-router paths
  only, capped 40, CORS-open) is built and tested but currently unconsumed —
  reserved for a future "add page" picker.

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
- Harness renders bare first, then climbs a retry ladder one failure at a
  time: a `MemoryRouter` when the failure is router-shaped (covers
  `useNavigate` et al without double-wrapping components that own a Router;
  router package availability is decided server-side at module generation),
  then app context providers discovered from the error itself — the module a
  context hook throws from (`useTheme` → `theme-provider.tsx`) usually also
  exports the `*Provider` that fixes it, so the harness imports it and wraps.
  Wrappers accumulate, so a page needing router + theme gets both. App shells (`App`, `*Routes`, `*Router`,
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

**Addendum (2026-07-07): Inspector chat tab + Claude Code model picker**
- The AI switch's Claude Code card gained a model picker (CLI default / Haiku /
  Sonnet / Opus) — persisted, passed as `--model` on every headless invocation
  including the connect test.
- New Inspector **Chat** tab: select an element, type an instruction, the AI
  edits the code. The model gets the whole source file with the selection
  marked (line + tag/component + ×N instance note) and replies with
  SEARCH/REPLACE edit blocks (full-file fence accepted as fallback; prose =
  answer, no write). Blocks are applied locally with exact-unique matching —
  a misquoted or ambiguous SEARCH aborts with a reason, nothing half-applies.
  Works with both backends (Claude Code CLI honoring the model pick, or API
  key). First cut asked for the complete updated file back — Opus streaming a
  whole file took minutes and read as a hang; block edits land in ~8 s.
- Headless CLI hardening (the "stuck in Working…" fixes): the one-shot
  `claude -p` now runs stripped (`--tools "" --strict-mcp-config
  --setting-sources "" --no-session-persistence --disable-slash-commands`,
  neutral cwd) — a bare invocation loads the user's whole Claude Code
  environment and MCP servers, which stalled for minutes before any API call.
  Hard 300 s timeout kills the child (the UI can never spin forever), and
  stdin/stdout/stderr are pumped on separate threads (a >64 KB prompt could
  deadlock both processes on full pipes).
- Safety model unchanged and load-bearing: the reply is written via a new
  sidecar `writeFile` command that **strict-parses (no error recovery) before
  writing** — unparseable model output is refused with the file untouched;
  `resolve_in_root` gates the path; each applied edit is its own commit on the
  `dedup/session-*` branch (`dedup: <model summary>`). Chat edits are blocked
  for a file with unsaved staged class edits (a rewrite would strand their
  line/col positions) — save or discard first.
- This is the one AI feature that sends **source code** to the backend (scan
  categorization still sends outlines only); the composer states it inline.
- Chats are sessions, persisted per project (localStorage, most recent 20,
  same pattern as dismissed clusters) and restored on reopen. The panel has a
  session switcher + new/delete; a new chat materializes on its first message.
  Each turn carries conversation memory: the last 12 message texts go back to
  the model (real message turns on the API backend, inline transcript for the
  headless CLI) — never past file snapshots; the current file is always sent
  fresh.
- Stale selections are guarded, not guessed: commits shift line numbers, and
  a stale line made the model edit the *wrong* button in dogfooding. Before
  prompting, the selected line in the just-read source must still contain the
  selected tag (else: "re-select and try again"); the prompt also quotes the
  line's text so the model targets by content, not position. After an applied
  edit the canvas is told to `location.reload()` (new overlay `reload`
  command) — never trust HMR sockets to be alive — and the selection is
  cleared because every position in the file may have shifted.

### Addendum — launch screen as a project grid (2026-08-22)

The recents list became a Figma-dashboard-style grid: 16:10 cards with a real
preview image, name, framework + "3d ago" line, hover remove, and a dashed
"Open project" tile in the first cell. The old dropzone survives as the
empty state (no recents = nothing to show a grid of).

**Mechanism.** Thumbnails are WKWebView *self*-snapshots
(`takeSnapshotWithConfiguration:`, `src-tauri/src/thumbs.rs`): the webview
rasterises its own layer tree, so it captures the cross-origin canvas iframe
that a DOM rasteriser can't read, and — unlike `screencapture`/CGWindowList —
it needs no Screen Recording permission (verified: that permission is not
granted here and CGWindowList capture fails). `snapshotWidth` does the
downscaling, so no image resampling on our side; PNGs live in the app config
dir beside `recents.json`, keyed by FNV-1a of the project root, and are
deleted with their recents entry. The frontend reads them back as data URLs.
Capture points: closing a project (back button, before the dev server stops)
and ~1.2 s after a successful save — ⌘Q never reaches the back button, so
saves are the second chance at a fresh card.

**Deviations / limitations**
- macOS only by construction (`snapshot_png` errors elsewhere); the grid
  degrades to generated cards — a per-path hue gradient with the project's
  initials — which is also what a never-opened project shows.
- Recents entries gained `framework` + `lastOpened`; pre-existing entries have
  neither (serde defaults), so their cards show the parent folder instead of
  inventing a framework or a date.
- Quitting with ⌘Q without ever saving leaves the previous card (or the
  placeholder) in place; there is no capture-on-quit hook.

### Addendum — artboard-scoped scan + Components tab (2026-08-23)

Three connected UX changes to the scan flow:

- **Scan targets a selected artboard.** Page artboards are now selectable
  (click the frame's name label; accent ring + label tint show the selection,
  click again to deselect). On a live, tagged canvas, Scan requires a
  selection and scopes clustering to that one frame's source files (new
  `requestFrameFiles(route)` in the bridge — the old union-across-all-frames
  `requestCanvasFiles` is gone). The TopBar Scan button disables with a hint
  until an artboard is picked; untagged/offline sessions keep the honest
  whole-project fallback with no selection demanded.
- **Components moved to their own top-level tab.** The TopBar gained a
  centered Canvas / Components switch (gallery count as a badge). The
  rendered gallery no longer lives on the canvas beside the page frames —
  `Artboards.tsx` is deleted, replaced by `ComponentsView.tsx`, a scrollable
  view with the same category sections, cluster groups, and click-to-review.
  A fresh scan lands on the Components tab; restores stay put (replaces the
  old `scanSeq` auto-pan, now removed). Canvas and ComponentsView both stay
  mounted and hide via CSS — unmounting would reload the app frames and drop
  live state + staged class previews. Off-screen harness iframes unmount via
  IntersectionObserver (rootMargin 600px) instead of pan-math culling.
- **Cards take each component's on-site size.** Scan asks the selected
  artboard's overlay for every component's rendered DOM rect (new `list-sizes`
  command: first non-nested instance per `file#name`, measured via
  `getBoundingClientRect`), and cards take exactly those dimensions — the
  preview matches how the component actually renders on the page. The harness
  gets the width as `?w=` and locks `#root` to it (padding dropped) so text
  wraps and flex flows like the site; oversized components (full-width heroes)
  render at true size and scale down to fit an 800px card, Figma-style, with
  the real `w×h` shown in the card label. Live sizes persist per project in
  localStorage so restored scans keep them. Fallback when the page can't
  answer (component not on the scanned page, older overlay bundle, dev server
  down): the harness's own intrinsic measurement at a fixed 800px probe width.
  This one required a plugin rebuild — overlay `list-sizes` + harness `?w=`.

Then Phase 4 (guarded merge), Phase 5 (harden + Next.js).

---

## Interlude — Figma-grade inspector chrome (2026-08-22)

Not a PRD phase: a UI pass over the right rail and the app chrome, prompted by
the inspector still reading as "labelled text inputs" rather than a design tool.

**What shipped**
- `@radix-ui/react-icons` replaces the hand-rolled `src/components/icons.tsx`
  (now deleted). Radix's set is the only common one carrying the
  alignment/spacing/typography vocabulary this panel needs
  (`AlignCenterHorizontally`, `SpaceBetweenVertically`, `Padding`, `Corners`,
  `BorderWidth`, …). It is in maintenance mode, which is fine — we need a fixed
  vocabulary, not a growing one.
- New `src/components/ui.tsx`: 24px rows, icon-prefixed fields, segmented icon
  groups, colour swatches — the primitives the style sections are built from.
- `StylePanel` rewritten on those primitives: direction/justify/align/text-align
  became icon toggle groups; padding and margin became Figma's axis-pair control
  with a split-to-four-sides toggle; size fields carry `Width`/`Height` prefixes
  with min/max behind a disclosure; fill/border/text colour gained live swatches.
- Alignment icons flip between the horizontal and vertical sets with
  `flex-direction`, so `justify-start` reads as "top" on a column.
- Drag-to-scrub on a field's prefix icon steps the Tailwind spacing scale,
  replacing the `−`/`+` buttons.
- App chrome followed: sidebar tabs, toolbar, zoom buttons, viewport switcher
  (device glyphs instead of "Mobile/Tablet/Desktop"), console drawer, launch
  screen, duplicates, review panel, inspector tabs and breadcrumb.
- Both side panels resize by dragging their inner edge (`ResizeHandle` in
  `ui.tsx`), double-click resets, widths persist per machine in localStorage.
- Second pass against a screenshot of Figma's UI3 right panel: section titles
  are 13px normal-case ink (not micro-caps) with their actions hung on the
  right; grey captions sit *above* their controls instead of in a left label
  column; fields and toggle groups grew to 28px with 12px values. Fill, Stroke
  and Appearance became their own sections, matching how Figma splits them.

**Decisions**
- *Icons must not hide the vocabulary.* Every toggle, select and field carries
  the literal class it writes in its `title` (`justify-between`, `pt-*`,
  `rounded-*`), and the raw Classes textarea stays. Honesty over magic (PRD §6)
  applies to affordances, not just to write safety.
- *The mapping layer was not touched.* This is a view-layer change end to end;
  `pnpm test:tw` passing unchanged is the evidence.
- *Swatches resolve real colours.* Palette tokens paint via
  `var(--color-<token>)`, which forced `@import "tailwindcss" theme(static)` in
  `styles.css` — Tailwind v4 tree-shakes theme variables, and the swatch needs
  the whole palette present (CSS 7.4 → 11.2 kB gzipped). `cssColor` lives in
  `lib/tailwind.ts` and returns null for anything it can't resolve, so an
  unresolvable token renders as a checkerboard rather than a guess.
- *A scrub is one undo step.* `applyClassEdit` gained an optional `group` (a
  drag id); consecutive edits sharing it collapse into a single `EditOp` instead
  of pushing one entry per 5px of pointer travel.
- *Panel widths clamp on read, not just on write.* `PANEL_BOUNDS` caps both
  panels; a width restored from a wider window (or a corrupt entry) is clamped
  as it loads, so a stored value can never leave the canvas unusable.
- *Resizing needs pointer capture.* The canvas iframe swallows pointer events
  the moment the cursor crosses it, so the drag strip captures the pointer for
  the whole gesture and releases on both pointerup and pointercancel — a
  cancelled drag must not strand a `col-resize` cursor over the app.

**Deviations / limitations**
- `justify-around` has no dedicated Radix glyph; it borrows
  `ColumnSpacing`/`RowSpacing`. Distinguishable from `evenly`, but the tooltip
  is what disambiguates.
- `flex-row-reverse` / `flex-col-reverse` show the base axis's alignment icons —
  the glyphs don't mirror to match the reversed main axis.
- Swatches resolve Tailwind's *default* palette. A project's own theme colours
  (`bg-brand`) aren't in dedup's CSS, so they render as "unresolved" honestly
  rather than wrong.
- Rendered-UI verification is still manual; there are no component snapshot
  tests, so this pass is covered only by typecheck plus the mapping suite.

---

## Fix — PATH for GUI-launched bundles (2026-08-22)

The packaged `.app` crashed every project open with `env: node: No such file
or directory` / exit 127, while `pnpm tauri dev` worked. A bundle started from
Finder inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so
the `#!/usr/bin/env node` shebang in `node_modules/.bin/vite` — and `pnpm`,
and the sidecars — had no node to find.

`toolpath.rs` now builds the PATH the user's own terminal has: their login
shell is asked for it (`$SHELL -ilc`, 5s bounded so a slow rc can't stall the
first open, since nvm/fnm live in `.zshrc`, which non-interactive shells never
read), unioned with the inherited PATH and the usual install dirs (homebrew,
volta, bun, pnpm, asdf, every `~/.nvm/versions/node/*/bin` newest-first), with
dead entries dropped. Every child gets it: dev server, write-back sidecar,
scan sidecar, Claude Code CLI.

Binaries are resolved to absolute paths through `toolpath::which` rather than
named bare — on Unix `Command`'s own program lookup uses the *parent's* PATH,
so setting `PATH` on the child alone would not have fixed `pnpm`/`node`. An
unrequested exit 127 now also logs what it means instead of a bare code.

---

## Structural editing + identity rework (2026-08-23)

Prompted by a read of Onlook's open-source editor (Apache-2.0). Four of its
design decisions are better than what we had; they are reimplemented here, not
copied. The dedup engine remains ours alone — Onlook has no component
inventory, no similarity clustering, and no guarded merge anywhere in its tree.

**Element identity is now position-free.** `data-dedup-id` was
`file:line:col`, which went stale the moment a save shifted a column — the
"ids of later elements on the same line go stale" gotcha. It is now
`file@ordinal`, the element's index in a *shared* depth-first JSX walk
(`plugin-src/jsxwalk.mjs`) that the tagger and the write-back both import.
Sharing the walk is the point: an ordinal only means something if both sides
count identically, and two copies of "the same" traversal would not stay the
same. Source positions are still needed (open-in-editor, chat prompts) and are
derived on demand by `inspect`, which always reports the live line/col.
Onlook solves this by writing persistent nanoids into the user's source; our
convention forbids touching their files, and a deterministic ordinal buys the
same stability without it.

**Nodes now carry what may be done to them.** The walk classifies each element
as a `.map()` item (`data-dedup-dyn="array"`), a conditional branch
(`"conditional"`), a component root or `<body>` (`data-dedup-core`). The
write-back's `inspect` returns capability flags (`canRemove`, `canMove`,
`canAcceptChildren`, `canEditText`) with the reason when false, and refuses
ops that contradict them. The overlay reads the same attributes, so a drag
never starts on an element the save would reject — the affordance is honest
before the user pulls on it, not after.

**One edit-action model replaces staged class diffs.** `EditAction` (class,
text, remove, insert, move) is the single description of an edit whether it is
being previewed, undone, reviewed, or written. The staged program is one
ordered list; undo pops, redo pushes, review reverts by position. The overlay
receives the whole program as *state* (`stage`), resets what it applied and
replays — so undo, redo, mid-list revert, and recovery after a React re-render
are all the same code path rather than an incremental protocol that can drift.

**Insert / move / re-parent / delete land as source edits.** Dragging an
element on the canvas re-parents it; the toolbar's palette places a frame,
text, button or image; ⌫ deletes. All of it is one `apply` program per file,
resolved from one parse, applied as magic-string ranges, re-parsed before the
write — all ops land or none do. A move is capture → delete → re-insert rather
than a chunk move, so the block is re-indented for its new depth *and* class
or text edits made inside the moved subtree travel with it (drag, then tweak
padding, is one save). Dropping into a self-closing element expands it to a
pair. Cross-file moves are refused with a reason: lifting markup out of one
component into another is a refactor, not a drag.

**Also from the same read**
- Staged classes preview through an injected stylesheet keyed by dedup id
  rather than the inline `style` attribute — the element's own inline styles
  survive, variants become expressible, and undoing a preview is dropping a
  rule instead of remembering which properties we touched.
- `tailwind-merge` (+ a background-group fix: it treats `bg-cover` and
  `bg-red-500` as one group; they are different properties) backs a new
  `mergeClasses`, offered as "Tidy" on the raw Classes field.
- Dev-server output is parsed into structured build errors (`lib/errors`) —
  a fixed pattern list, not "anything on stderr", grouped with their detail
  lines and cleared by the next successful compile. The console shows them
  above the raw stream with "Ask AI" to hand one to the inspector chat.

**Deliberately not taken from Onlook:** their sandbox/CodeSandbox execution
model, hosted backend, deploy and collaboration (all contradict "the codebase
never leaves the machine"), and their fast-apply code-rewriting services
(Morph/Relace) — a third-party service rewriting user source is exactly what
our AST-gated write-back exists to avoid. `penpal` for typed iframe RPC was
considered and skipped: the bridge's message union is now typed on both sides,
which was the actual benefit.

**Deviations / limitations**
- A structural save renumbers every ordinal after the edit in that file, so it
  ends with a canvas reload rather than trusting HMR. Class-only saves are
  unchanged.
- Moves are refused across files, into `.map()` items, conditional branches,
  component roots, `<body>`, and void tags — each with the reason shown.
- Inserted elements are neutral markup to be styled in the inspector, not a
  guess at a design; the image placeholder has an empty `src` the user fills in.
- A staged insert carries a provisional `pending:<uuid>` id so it can be
  selected, styled and typed into before it exists on disk. Class and text
  edits addressed to one are folded into that insert's snippet at save time —
  it is written once in its final form, rather than as an insert followed by
  edits to something that did not exist when the insert ran. A fold that fails
  validation refuses the save rather than dropping the edit.
- A staged insert still can't be *moved*: that would mean rewriting the insert
  action's own target, and the inspector says so instead of offering it.
- Indentation of moved blocks is corrected relative to the drop target, but
  dedup still doesn't run the project's Prettier (FR-4.1's optional half).
- The canvas gestures that need real hit-testing and layout (drag, drop
  indicator, click-to-insert) have no automated coverage — there is no browser
  in the test path. The write-back half of every gesture is covered end-to-end
  through the built bundle, and `test:overlay` covers the overlay's load,
  select and staged-program paths against a stub DOM.
- `test:tw` / `test:chat` used `node --experimental-strip-types` (Node ≥22.6);
  they now bundle through esbuild (`plugin-src/run-ts.mjs`) and run anywhere.

---

## Layers tree (FR-6.2) ✅ (2026-08-23)

The sidebar's Layers tab (an Onlook-style layers panel, placeholder since
Phase 1) now shows the rendered element tree of every page artboard, synced
with canvas selection both directions.

**The DOM is the source of the tree, not the source files.** Each frame's
overlay walks its rendered DOM and reports nested `data-dedup-id` elements
(`layers` message, per route). That choice buys three things for free: staged
inserts/removes appear in the tree live (they exist only in the DOM), a
`.map()`-rendered element shows once per instance exactly as on the page, and
untagged wrappers (portals, third-party markup) are transparent — their tagged
descendants attach to the tagged ancestor above. Reports ride the same
debounced MutationObserver tick as the height report, gated by a JSON
signature so quiet ticks send nothing; the editor can force one with
`list-layers` (the tab does, on mount).

**Selection sync both ways.** A row click goes through the existing
`selectById` → overlay `select-id` → `selected` round-trip, so the inspector,
canvas box, and tree all agree by construction. A canvas click highlights the
row, auto-expands its collapsed ancestors (only those — the user's other
collapse state survives), and scrolls it into view. Hovering a row sends a new
`hover-id` command that draws the same hover box + badge a pointer over the
canvas would.

- Rows are keyed by tree position, not dedup id — one source element rendered
  N times is N rows sharing an id, and all N highlight when it is selected
  (matching what the class-patch preview does on the canvas).
- Component roots (`data-dedup-core="root"`) wear the component's name with
  the tag demoted; leaf rows show a short text snippet ("Sign out" tells three
  `li`s apart). Staged inserts carry an "unsaved" chip.
- `test:overlay` +3: the nested/labeled tree incl. the untagged-wrapper case,
  a staged insert appearing in the tree marked `staged`, and `hover-id`
  drawing/clearing chrome without a pointer.

---

## Pages tab (FR-6.3) ✅ (2026-08-23)

The last sidebar placeholder. The tagger already served statically discovered
routes at `/__dedup/routes` (conservative react-router path-literal scan,
covered in `test:plugin`) — but the editor only ever probed that endpoint for
alt-origin detection and threw the payload away. The Pages tab now consumes it.

- The list is the detected routes merged with the artboards already open:
  browsing spawns artboards at dynamic paths (`/orders/42`) the static scan
  can't know, and they belong in the list too. When the scan finds nothing
  (or tagging is off), the tab says so and why instead of presenting an
  empty pane as if the app had one page.
- Clicking a row opens the route as a page artboard (if it isn't one) and
  pans the canvas to it. That focus behavior was inlined in the canvas's
  navigation handler; it is now one store action (`focusRoute`) shared by
  both paths, and `PAGE_GAP` moved from Canvas into the store with it.
- Rows carry the same honesty markers as the canvas frame labels: a frame
  its app redirected away shows `→ where-it-landed`, and the artboard the
  scan targets is marked.
- Detected routes are fetched once per dev-server session (reset on restart)
  with a manual re-scan button; the endpoint answers fixed `{routes}` JSON
  with CORS open, so the editor webview fetches it cross-origin directly.

---

## Zero-login editing — mock-session seed (2026-08-23)

Protected routes were unreachable on the canvas: the app's client guard sees
no session and redirects the frame to `/login`, so the page the user wanted to
edit never renders. (The existing guest-origin retry only helped the opposite
case — public pages guarded *against* signed-in users.)

**What was rejected, and why.** Scripting a real login means storing the
user's credentials and re-breaking on every auth provider (OAuth popups,
magic links, hosted widgets). Mocking the *render* — AI-generated fake page
state — was rejected outright: it contradicts "honesty over magic" at the
worst possible place, since the user would be editing a page state that does
not exist in their app, and a save could look right on the canvas and wrong in
production.

**What landed instead: a seed, not a lie.** The user installs a small
*session seed* — browser-storage writes that make their app's **own** client
guard consider itself authenticated. The real page then renders and its real
markup is what gets edited. Every guarantee is structural rather than
promised:

- **Storage only.** The seed writes `localStorage`/`sessionStorage`/cookies.
  It never mutates source, never intercepts the network, never mocks a
  component. What renders is the app's genuine authenticated shell.
- **Framed-only.** The tagger wraps the seed in a `window.top === window.self`
  gate before serving, so it runs in dedup's canvas frames and *never* when
  the user opens their own dev server in a browser. The gate is in the
  wrapper, not the seed, so no seed can opt out of it.
- **Crash-proof.** The wrapper try/catches: a bad seed warns to the console
  and the page boots logged-out exactly as before, rather than dying in
  `<head>`.
- **Reviewed, opt-in, and visible.** AI only *drafts* the seed (from the
  project's own auth-related source, scanned by `session.rs` — storage API
  plus an auth-ish word, so a theme toggle doesn't flood the prompt); the user
  reads and edits it before it can be enabled, and while it is on, the canvas
  frame label and the Pages tab both say "mock session".
- **Never committed.** It lives in `node_modules/.dedup/session.json`, the
  same sanctioned injection point as the tagger and overlay assets. The
  user's source and config stay untouched, per the standing convention.

**Reaching a bounced frame.** A frame parked on `/login` can't be fixed by a
plain refresh — that just reloads the login page. `reload` now takes an
optional `path` and does `location.replace(path)` when the frame sits
somewhere else, so enabling a seed brings every frame back to its *pinned*
route in one fresh document load (which is what the seed needs — it runs
before the app boots). Enabling also resets `frameOrigins`: the guest-origin
fallback existed because the page was unreachable, which is the thing the seed
just fixed.

**Discovery.** A frame whose drift lands on an auth-looking path
(`/login`, `/signin`, `/auth/…`) shows a lock in the Pages tab that opens the
setup modal; the tab also carries a permanent "Zero-login editing" row with
its on/off state, since locks only appear after a page has bounced once.

**Correction after first real use (same day): sign-in leads, the seed is the
fallback.** Dogfooding on a Firebase app returned `INSUFFICIENT` — and the
model was right. The seed generator's premise was that *the app* writes its
session storage, which is false for every managed auth SDK: Firebase persists
to IndexedDB from inside the SDK, NextAuth to an httpOnly cookie, Clerk to its
own short-lived tokens. The scanner looks at the user's source, so for those
apps it correctly finds nothing, and no seed could have reached the session
anyway.

The path that *does* work needed no new mechanism: every canvas frame on one
origin shares a single WebKit session, so signing in for real once unlocks
every protected artboard — with real tokens, so data loads too, not just the
shell. Two things were blocking it:

- it was undiscoverable — nothing in the UI said "just sign in";
- the guest-origin fallback actively fought it. That retry exists for pages
  guarded *against* signed-in users; for a page guarded *for* them it is
  precisely backwards, since the guest origin has separate storage and a real
  login there never applies.

So the modal now leads with **Sign in on the canvas** (switches to browse mode
on the frame the guard bounced, so the app's own login form works — any
provider, no credentials stored by dedup) plus **I'm signed in — reload
pages**. Both run `reloadPinnedFrames`, which resets `frameOrigins` to the
shared origin and reloads each frame at its pinned route — the same step a
seed save takes, now shared. The seed collapses behind a "Can't sign in?"
disclosure (an *enabled* seed always stays visible — it is changing what the
user sees).

`session.rs` also detects the auth SDK from `package.json` and says whether a
seed can reach it at all. That answer reaches the user two ways: the modal
shows "Firebase Auth keeps the session in IndexedDB — a seed can't reach that"
and disables **Draft with AI**, and the generation prompt now *names the SDK*,
so an app using a seedable one (Supabase, Amplify — both localStorage) gets a
correct seed instead of the model concluding "no auth here" from an app that
is full of it.

**Second correction: browse mode was still being steered.** A phone-OTP login
reset to step one before the code could be entered. Both reactions to
`page-meta` were firing during browse mode, and either one is fatal to a
multi-step flow:

- the overlay marks a navigation as a user gesture only within **1.5s of a
  click** — far shorter than an SMS round-trip — so the step change read as an
  app-initiated redirect and flipped the frame to the guest origin. That
  swaps the iframe's `src`, i.e. a full reload, and Firebase's
  `ConfirmationResult` lives in memory, so the flow restarted;
- had it landed inside the window instead, the snap-back would have yanked
  the frame to its pinned route with the same result.

Browse mode now returns from that handler after recording the path: it exists
to hand the page to the user, so dedup stops steering. Labels stay honest
(the path is tracked either way); pinning is the Pages tab's job.
`startCanvasSignIn` also resets any guest-origin frames first — signing in on
`[::1]`/`127.0.0.1` writes a different storage bucket than the other frames
read, and providers that check authorized domains (Firebase's reCAPTCHA) only
whitelist `localhost`.

**Page console forwarding.** The above was undiagnosable from the editor: the
console drawer shows the dev server, while an auth SDK's complaint happens
inside the iframe. The overlay now wraps `console.error`/`.warn` and listens
for `error`/`unhandledrejection`, forwarding to the drawer as
`[page /route] …`. It observes rather than replaces (the page's own console
still fires), serializes defensively (Errors keep stacks, cyclic objects don't
throw), and is budgeted at 200 lines with slow refill so a render loop can't
flood. These lines bypass the build-error parser deliberately — a runtime
`TypeError` is not a broken build, and lighting that indicator would be a lie
no recompile could clear.

**Third correction: the session becomes a property of the artboard.** With a
real login in place the *opposite* guard bites — a welcome/marketing page
protected *against* signed-in users redirects to the dashboard, and the
artboard the user wanted to edit won't hold still. The guest-origin fallback
was built for exactly this but couldn't fire: it sits after the browse-mode
early return (so never during sign-in), it excluded `route !== "/"` (the
common case for a landing page), and it only reacts to a *changed* page
report, so it never re-evaluates once a redirect has settled.

Rather than keep patching the inference, the choice is now explicit and
per-artboard: **auto / signed in / signed out**, on each Pages-tab row. The
user is designing a logged-out welcome page and a logged-in dashboard at the
same time, so which session a frame renders under is a property of the
artboard, not something to be guessed from one redirect. An explicit choice
always beats the fallback. "Signed out" is the same mechanism as before — a
second loopback spelling of the same dev server, hence a separate storage
bucket, hence genuinely no session — so nothing is mocked; it is a browser
that never logged in. Canvas frame labels say which session a frame is on
whenever it isn't the live one, so two frames of the same app can never
silently disagree.

`resolveOrigin` (new `lib/origins.ts`) is the one place the explicit choice
and the fallback are reconciled — pure, so React calls it with subscribed
values while the store calls it with `get()`, with no second implementation
to drift. `pnpm test:origins` pins the precedence, including the degrade path
when no alternate origin exists (the control disables and says why rather
than silently doing nothing).

"I'm signed in — reload pages" now also returns to Select, since browse mode
deliberately suppresses the redirect fallback that a fresh login makes
relevant.

**Hold: freezing a transient screen.** Splash screens, interstitials and
"redirecting…" states are gone before anyone can look at them, so they could
never be inspected or edited at all. **Hold** (per artboard, in the Pages tab)
freezes a frame on its first screen.

It works by queueing the mechanism those screens advance on: timers of
**≥400ms** are held rather than scheduled, and `history.pushState`/
`replaceState` are frozen so timer-driven navigation is covered twice over.
Short timers deliberately still run — React's scheduler falls back to
`setTimeout`, and stalling that hangs the page instead of pausing it. 400ms
separates the two cleanly: no framework schedules rendering that far out, and
no splash is that brief. **Release** restores every patched function and
flushes what was queued, so the transition finally plays and the app carries
on rather than having lost the work; a timer the app itself cleared while held
stays cleared.

Holding has to be armed *before* the app boots, so it rides in on the frame's
URL (`?__dedup_hold=1`) and is read by the same head-injected boot script that
carries the mock-session seed — which is why toggling it reloads the frame.
That flag is written by the editor and read by the separately bundled tagger,
so `test:origins` asserts the two constants agree; if they drifted, holding
would silently stop working with nothing to see. Held artboards are badged
"held" on the canvas, since a held frame is deliberately not showing what the
app would do on its own.

**Deviations / limitations**
- Hold catches screens that advance on a timer or a client-side navigation,
  which is the common case. A screen waiting on a network response is not
  held — dedup does not intercept the app's requests, and a faked response is
  exactly the kind of invented state the seed design already rejected.
- Browsing no longer auto-pins visited routes as artboards; add them from the
  Pages tab. Losing a login halfway is a worse failure than an extra click.
- A "signed out" artboard needs a second reachable loopback origin. Vite on
  macOS usually binds both, but where only one is available the control is
  disabled with the reason shown.
- Seeds only make sense for apps that keep their session in JS-reachable
  storage. For an SDK-managed session (Firebase, Clerk, NextAuth, Auth0's
  default) signing in is the only path, and the UI says so up front rather
  than spending an AI call to find out.
- The seed satisfies *client-side* guards. Data fetched from a real server
  can still return 401, so a protected page may render its authenticated
  shell with empty or error content. That is the honest result and still the
  editable thing — the layout is what dedup edits — but it is not a login.
- Server-rendered guards (a Next middleware redirect) are unaffected; this is
  a client-storage seed by design.
- Generation quality depends on the app keeping its session in storage the
  scanner can see. When the model can't tell, it returns an `INSUFFICIENT`
  marker that surfaces as an error telling the user to write the seed by hand
  — rather than inventing keys that will silently not work.
- The seed is *not* automatically applied to a project that has one saved:
  `enabled` is persisted and honored, but nothing turns it on by itself.

---

## Phase 4 — Guarded merge ✅ (2026-08-28)

The differentiator, and the one feature where a bug is a corrupted codebase
rather than an annoyance. The whole phase is organised around PRD §6's metric:
*zero* merges that land and break the build.

| FR | Status | Notes |
|---|---|---|
| FR-5.4 merge proposal | ✅ | Read-only `plan` (member sources, prop signatures, behaviour, traced call sites) → model writes the canonical component → dry-run codemod produces every file's before/after → full diff review with the source editable in place |
| FR-5.5 call-site rewrite | ✅ | Retag + prop-merge + import fix-up, per call site; retired files staged in `.dedup-trash/` with a manifest, restorable, deleted only on explicit confirmation |
| FR-5.6 safety gates | ✅ | Typecheck, build (project script *and* the dev server's live compile), visual regression at 1% tolerance; any failure rolls the merge back automatically |
| FR-5.7 per-merge commit + history | ✅ | `dedup: merge A, B → A` on the session branch; History panel lists every dedup commit with a one-click undo |
| FR-5.8 behaviour differences | ✅ | Hooks/handlers/calls compared across members; differences shown in the prompt *and* on the review screen before approval |
| FR-5.9 batch mode | ✗ | Deliberately not built — see below |

**The division of labour, and why.** The model does exactly one thing: decide
what the merged component's API should be, and write it. It never touches call
sites (the codemod rewrites those mechanically from a validated prop map), it
never decides what may be deleted, and its output crosses a narrow boundary —
a component source that must parse and must export the promised name, plus a
prop map whose values must be strings, numbers or booleans. Everything else it
emits is discarded. That boundary is `lib/mergeProposal.ts`, and it is tested
against malformed replies, forgotten members, escape-attempt prop values and
paths outside the project.

**A name match is not a call site.** The scan counts `<Card` occurrences by
name, which is fine for ranking clusters and catastrophic for a codemod: a
`<Card>` imported from a UI library would be renamed along with yours. Every
call site the merge touches is traced back to the member's file through a real
import — relative specifiers, tsconfig `paths` aliases and `baseUrl`
(`plugin-src/resolve.mjs`). Anything unresolvable is reported, never guessed.

**All-or-nothing, across files.** The class write-back's guarantee (one parse,
one write, output re-parsed first) is applied to the whole project: every
output file is computed in memory and re-parsed strictly, and only then is
anything written. A merge that would leave the project half-rewritten does not
happen at all — which for a multi-file rewrite is the only safe version of it.

**Refusals, each because the alternative is a broken build**
- The proposed canonical source doesn't parse, or doesn't export the name it
  promised.
- Merging into an existing file would drop exports that file already had —
  every importer of those would break, and it is checkable, so it is checked.
- A member is re-exported by a barrel (`export { Card } from "./Card"`): those
  bindings are not imports, so the call-site pass cannot see them, and the
  module they point at is about to be retired. Refused with the file named.
- A member is no longer declared where the scan found it (stale scan).
- A prop value that would break out of the JSX attribute it is written into.
- A file that declares more than the member is never gutted surgically; it is
  left in place, its call sites moved, and the leftover declaration reported.

**Gates: "couldn't run" is not "passed."** A JS project has no `tsc`; a project
may have no build script; an artboard scrolled off screen cannot be
screenshotted. Each of those produces a `skipped` verdict carrying its reason,
the merge is allowed to stay, and the review says plainly that it landed on
weaker evidence. Rounding a skip up to a pass is how a tool corrupts a codebase
while showing green, so the summary line names every skip.

The build question is asked twice on purpose: the dev server's live compile is
fast and catches the page the user is looking at, but it only compiles what a
loaded route pulled in — the project's own build script is what proves the
project. Both run; both are reported separately.

**Rollback is not `git revert`.** Revert demands a clean tree and would refuse
(or worse, involve) the user's in-flight work. A failed gate instead restores
exactly the paths the merge commit touched — including files it deleted — and
commits that. dedup's blast radius stays dedup's own files, which is the same
promise every save on this branch already makes. The staged `.dedup-trash/`
copies are dropped in the same step, so a restored file never has two spellings
on disk.

**Deviations / limitations**
- **FR-5.9 batch mode is not built.** Queueing merges means running gates on a
  codebase that several unreviewed rewrites have already changed, so a failure
  no longer identifies which merge caused it — and the rollback story stops
  being "undo one commit". One at a time is not a shortcut here; it is what
  makes the gates mean anything.
- The visual gate can only compare artboards that are mounted on the canvas at
  both capture points. Off-screen frames unmount, so they are reported as not
  checked rather than assumed unchanged.
- A merge whose canonical file is new leaves both members retired; merging in
  place keeps one file and retires the rest.
- Import fix-up handles value imports. A member referenced in a type position
  keeps its import, with a warning, rather than being rewritten on a guess.

## Phase 5 — Harden ✅ (2026-08-28)

| FR | Status | Notes |
|---|---|---|
| FR-5.2 visual signal | ✅ | Perceptual hash of each cluster member rendered in isolation; folded into cluster confidence and ranking, and allowed to contradict the structural score out loud |
| harness rendering | ✅ | Shipped in Phase 3 (Components tab) — the visual pass consumes it |
| Next.js support | ◐ | Route discovery, dev server, canvas; element tagging via a user-approved one-line `next.config` wrapper. Isolated previews stay Vite-only — see below |
| failure states | ✅ | Carried from Phase 0–3 plus the merge's own rollback reporting |

**The visual signal, and why it is median-aHash rather than dHash.** The
textbook perceptual hash compares each cell to its right-hand neighbour, which
only sees horizontal gradients — so a component with a dark left column and one
with a dark top row hash identically. UI components are almost entirely flat,
axis-aligned blocks, which is exactly that failure mode. The hash instead
thresholds every cell of an 8×8 grid against the image's *median* cell: the
whole 2-D layout survives, and using the median rather than the mean keeps the
invariance that matters, since a uniformly lighter render of the same component
crosses the threshold in the same places. Both properties are pinned by tests.

The pass is opt-in per scan (it renders and screenshots every cluster member,
which takes seconds and needs the Components tab on screen), it refines
confidence rather than replacing it, and it never adds or removes a cluster
member — a decision the user made about a cluster is not something a screenshot
gets to rewrite. A member that cannot render in isolation has no hash, and its
cluster is reported as *scored on structure alone* rather than quietly averaged.

**Next.js: what it can and cannot do, and why.** Vite takes `--config`, so
dedup instruments it invisibly. Next reads `next.config.*` from the project root
and takes no config flag, so element tagging needs a line in a file dedup does
not own. The standing convention forbids *silent* mutation, and this does not
bend it: the change is offered with its exact diff, written through the same
parse gate as any generated write, committed on the session branch, and
undoable from History. It is also inert — the wrapper does nothing unless
`DEDUP_TAGGING=1`, which only dedup's own dev server sets — so the user's
`next dev`, their CI and their production build behave identically with the line
present.

Once wired, the same `tagCode` runs as a webpack loader. That sharing is not
tidiness: an element's id is its ordinal in the shared `jsxwalk` traversal, so a
second tagger would be a second, silently incompatible identity scheme for one
write-back. `tagCode` was extracted to `plugin-src/tagcode.mjs` for exactly this
reason, and both pipelines are thin shells around it.

Route discovery now reads Next's file system directly (`app/**/page.*`,
`pages/**`), skipping dynamic segments — an artboard needs a URL that resolves —
and collapsing route groups.

**Not shipped for Next: the component harness.** Rendering one component in
isolation needs an arbitrary module URL from the dev server, which Vite serves
and Next does not. The Components tab says so rather than showing empty cards,
which also means the visual similarity signal is Vite-only.

## Next.js, verified against a real app (2026-08-28)

The Phase 5 write-up claimed Next support on the strength of unit tests. Run
against a real Next 16.2.4 project (yarn, TypeScript config, 31 routes), three
things were wrong — two of them silent.

**Route discovery was unreachable.** `discoverNextRoutes` was served only from
the Vite plugin's `/__dedup/routes` middleware, and Next has no middleware
dedup can add — so the feature written for Next projects worked on every
project except Next. Discovery now lives in `plugin-src/routes.mjs`, the
write-back sidecar answers a `routes` command, and the frontend falls back to
it whenever the HTTP endpoint is absent or empty. One implementation, two
callers, same rule as `tagCode` and `jsxwalk`.

**A TypeScript config broke dedup's own gate.** `next.config.ts` under `strict`
importing an untyped `.mjs` is TS7016, and `skipLibCheck` does not help — it
skips checking declaration files, not their absence. dedup's config line would
have failed dedup's typecheck gate. A `next.d.mts` now ships beside the
wrapper; deleting it reproduces the error on the real project, restoring it
passes clean.

**Turbopack never runs `webpack()`.** The project's dev script is
`next dev --turbopack`, and Next 16 uses Turbopack by default anyway — so the
wrapper would have been a config line that looks wired and tags nothing. The
first fix refused to offer the wrapper at all, which was worse: a Turbopack
project could then never reach a wired state. Since dedup starts the dev
server, it starts it under `--webpack` instead, and the flag goes *through* the
project's own script rather than replacing it — that project's script carries
`NODE_OPTIONS=--max-old-space-size=8192` for a documented OOM, and a direct
`next dev` would have dropped it.

**What the run proved.** With the wrapper in place: dev server ready in 930ms,
**346 tagged elements** in the SSR HTML with correct `file@ordinal` ids,
component names, and the capability markers the overlay gates gestures on (17
`core="root"`, 2 `core="body"`, 15 `dyn="array"`, 13 `dyn="conditional"`); the
overlay entry present in `main-app.js`; `tsc --noEmit` clean. The project was
restored to a clean tree afterwards.

**Still not supported on Next:** isolated component previews, and therefore the
visual similarity signal — they need the dev server to serve arbitrary module
URLs, which Vite does and Next does not. Turbopack itself remains unsupported
as a *bundler*; dedup works around it by launching webpack rather than by
tagging under it.


## Interlude — the canvas becomes the app (2026-08-28)

The chrome was docked columns with hairline dividers, squeezing the canvas into
what was left. It now floats: the canvas is full-bleed and the sidebar,
inspector, top bar, toolbar and console are rounded, blurred, elevated panels
over it. The app being designed is the thing at the centre of the screen.

Three things follow from that, and each is a real change rather than styling:

- **`.panel` is one class, not a recipe repeated per component.** Every floating
  surface has to sit at exactly the same elevation or the illusion that they
  share a plane above the canvas collapses.
- **"Centre the artboard" now means centre it in the space the user can see.**
  Centring on the raw container parks the artboard's label under the top bar and
  its left edge under the sidebar. The fit maths insets by the live panel widths.
- **Separation is elevation, not dividers.** `--color-line` became a low-alpha
  white so one token reads correctly both inside a panel and against the canvas
  behind it, and the panels' inner tab strips became segmented controls — a
  second horizontal rule inside a panel that already has an edge reads as a seam.

---

## Verification inventory

- `cargo test` (src-tauri): 63 — URL/ANSI parsing, project detection,
  instrumentation, tunnel (real TLS upstream, IPv6-only), sidecar (real node
  spawn E2E incl. the full-file parse gate and an edit program that is
  all-or-nothing), git branch/commit isolation, Next stale-lock parsing, scan
  persist/restore round-trip, Claude Code result-envelope parsing, thumbnail
  key stability, toolchain PATH resolution (enriched PATH is dead-entry-free,
  `which` resolves node; the node-spawning suites also pass under a simulated
  launchd env), mock-session seed persistence, the auth-context scanner
  (storage+auth-word files only — a theme toggle and a bare fetch are both
  ignored), and auth-SDK detection incl. whether a seed can reach that SDK's
  session (Firebase not seedable, Supabase seedable, NextAuth not read as
  plain Next, no SDK → falls back to the file scan).
- `pnpm test:plugin`: 38 — tagger transform (ordinal ids stable across
  reformatting, dynamic/core marking, fragments, generics, sourcemaps,
  virtual-export + unsafe-name rejection); write-back program E2E via child
  process (inspect incl. capabilities, class/text/insert/remove/move, moves
  that carry nested edits and expand self-closing targets, every refusal path
  writing nothing, full-file replace); and the cross-bundle invariant that the
  tagger and the write-back resolve every ordinal to the same element; and
  the injected boot script, exercised by *running* it against a stand-in page:
  no/disabled/empty seed serves valid no-op JS, an active seed is gated to
  framed pages (asserted both ways), a throwing seed warns instead of breaking
  the page's boot, and the hold arms only when flagged, queues long timers
  while letting short ones through, freezes navigation, keeps a cleared timer
  cleared, and hands timers and history back intact on release.
- `pnpm test:actions`: 6 — staged program → write-back ops: palette snippets
  round-trip through the rewriters, values that would break out of the markup
  refused, text/classes typed into a staged insert folded into its snippet
  (newest wins), edits on real elements kept as their own ops in order, and an
  unfoldable or orphaned edit reported rather than silently dropped.
- `pnpm test:overlay`: 14 — the built overlay evaluated in a stub DOM: it loads
  and announces itself (the guard against a throw killing every listener after
  it), click → selection payload with markers and ancestry, click on an
  untagged child resolving to its tagged ancestor, browse mode passing clicks
  through, a staged class patch applied then rolled back, structural ops
  applied and fully reverted, a staged insert placed, addressable by its
  provisional id and withdrawn, double-click asking permission before a
  caret goes anywhere (with Escape restoring the original text), the layer
  tree reported nested/labeled with untagged wrappers transparent, a staged
  insert appearing in that tree marked `staged`, `hover-id`
  drawing/clearing the hover chrome without a pointer, `reload`
  refreshing in place but reloading *at* a pinned route when given one (how a
  newly enabled mock session reaches a frame bounced to /login), and page
  console forwarding (an SDK error reaches the editor with objects
  serialized, the page's own console still fires, a cyclic argument doesn't
  throw).
- `pnpm test:scan`: 10 — scan bundle E2E via child process: near-dup clustering
  + unrelated separation, canvas-scope filtering (project-wide call sites),
  knob-value equivalence, trivial-component exclusion, node_modules/garbage
  resilience, memo/forwardRef, progress stream, gallery filter (structural +
  interactive; text/icons/app-shells excluded), gallery cluster-id + schema.
- `pnpm test:tw`: 16 — class⇄knob mapping, spacing precedence + regeneration,
  swatch colour resolution (palette vars, arbitrary values, refusals),
  `mergeClasses` conflict resolution incl. independent background properties.
- `pnpm test:errors`: 5 — dev-server stream → build errors: chatter ignored,
  detail lines folded into one error, cleared by a successful compile,
  repeats deduped, ANSI stripped.
- `pnpm test:origins`: 8 — which session a page artboard renders under: the
  default, the redirect fallback moving one frame only, an explicit choice
  beating the fallback in both directions, a signed-out and a signed-in
  artboard live at once, graceful degrade with no alternate origin, and null
  before the dev server is up; plus the hold flag's URL handling and the
  cross-bundle invariant that the editor and the tagger spell it the same.
- `pnpm test:highlight`: 11 — the code panel's syntax colouring, with the
  load-bearing invariant first: every character survives tokenizing exactly
  once (the tokens are painted *behind* a transparent textarea, so a dropped
  character moves the caret away from what the user is typing). Plus strings,
  templates and comments as single tokens, an escaped quote not ending a
  string, an unterminated quote stopping at its line rather than painting the
  rest of the file, comment markers inside strings and vice versa, keywords vs
  identifiers that merely start with one, JSX tag names, and a `<` that isn't
  a tag.
- `pnpm test:chat`: 8 — chat edit-block parse/apply: single/multi block,
  deletion, non-match + ambiguous + malformed all throw (no half-applies),
  full-file fallback, prose passthrough.
- `pnpm test:merge`: 18 — the merge codemod against the built bundle: a plan
  reporting sources/props/call sites; a same-named component from a library
  *not* counted as a call site (the trap a name-based codemod falls into); call
  sites reached through a tsconfig alias; behaviour differences surfaced and
  identical behaviour left unflagged; a dry run producing the whole diff and
  writing nothing; an apply that rewrites call sites, fixes imports and stages
  the retired file; merging into a new file; a name collision aliasing the
  import instead of shadowing a library's `Card`; a default-exported member
  rewritten through its default import; a shared file left in place with a
  reason rather than gutted; and six refusals that each write nothing — source
  that doesn't parse, a missing export, dropped exports on the canonical file,
  a re-exporting barrel, a member that moved, and a prop value that would break
  out of its JSX attribute. Plus the trash lifecycle.
- `pnpm test:proposal`: 21 — the frontend half of the merge. The model-reply
  parser (a well-formed proposal; a forgotten member, a source that never
  mentions the promised name, a path escaping the project, a prop value that
  would break out of the JSX, and a non-scalar prop all refused); the review
  diff (an unchanged file has no hunks, a changed line carries both line
  numbers, distant changes stay in separate hunks with nothing elided, created
  and retired files, and a realistic import swap); the gate rules (a failed
  gate blocks and a skipped one does not, the summary never hides a skip, no
  dev server means *skipped* rather than passed); and the visual signal
  (confidence untouched with no pass or no renders, a disagreement pulling it
  down and saying so, an unrenderable member reported rather than averaged).
- Manual E2E: wrapper config against a real Vite app (tags + overlay + harness
  served); Claude Code CLI envelope round-trip; dogfooded on mintWash.
- Manual: the whole editor chrome was driven in a browser against a stub
  Tauri bridge during the floating-canvas redesign — top bar, both panels,
  toolbar, console, the Components gallery, the merge review with a full
  proposal + diff, and the history panel.
- Not yet auto-covered: in-app artboard render, AI categorization/mock-props
  end-to-end and the merge *proposal* call itself (all need a live backend),
  the canvas navigation and editing gestures (drag-to-reparent, drop
  indicators, click-to-insert) — no browser in the test path, though their
  write-back half is covered — the visual pass's capture half (needs a real
  webview; its comparison and hashing halves are unit-tested), and the Next.js
  webpack loader against a real Next build (the transform it calls is the same
  one 38 tagger tests cover).
