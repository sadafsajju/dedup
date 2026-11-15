# dedup — MVP Product Requirements Document

**Version:** 0.1 (MVP)
**Author:** Sadaf Kasim (GetBega Tech)
**Date:** July 2026
**Platform:** macOS desktop (Tauri 2.x)
**Status:** Historical MVP specification

**Scope update — 2026-11-10:** Deduplication has been removed. Duplicate and
Drift detection, similarity scoring, cluster review, merge proposals, call-site
merge rewrites, deletion staging, and merge gates are retired requirements.
The product is a visual web editor with component inventory/previews, source
editing, AI chat, and save history. The original requirements below document
the earlier plan; use README.md and the latest PROGRESS.md entry for current scope.

---

## 1. Overview

### 1.1 One-liner

dedup is a macOS desktop app that opens an existing React + Tailwind codebase, renders the running app on a canvas with Figma-style inspection and editing tools, and — its core differentiator — detects near-duplicate components across the codebase and safely merges them into a single canonical component with variants.

### 1.2 Problem

Real-world React codebases accumulate design debt: the same button, card, or badge gets rebuilt three, five, ten times with slightly different padding, colors, and structure. Existing visual editors (Onlook, Figma Dev Mode) help you *use* components you already have, but nothing detects that six components are actually the same component and consolidates them. Manual consolidation is tedious, risky (call sites break), and therefore rarely done.

### 1.3 Solution

A desktop tool that combines:

1. **Visual inspection layer** — load your real app, click any element, see and tweak its styles in a Figma-like right panel, with changes written back to source via AST edits.
2. **Deduplication engine** — scan the codebase, cluster similar components, and run a guarded merge that rewrites call sites, verified by typecheck + visual regression before anything is committed.

The visual layer is table stakes (borrowed architecture from the Onlook approach). The dedup engine is the product.

### 1.4 Why desktop / why Tauri

- Codebase never leaves the machine (privacy, no upload of client code).
- Needs to spawn the user's dev server, run `tsc`, run git commands, watch files — all local process work.
- Tauri gives a small binary, Rust backend for file/process orchestration, and a webview frontend where we can build the UI in our own stack (React + TS + Tailwind).

### 1.5 Non-goals for MVP

- Windows/Linux builds.
- Creating new projects / scaffolding (this is not a v0/Lovable competitor).
- AI generation of new UI from prompts.
- Drag-and-drop layout editing, drawing new elements, or reparenting DOM nodes.
- Collaboration, comments, cloud sync, deploy.
- Support for non-Tailwind styling (CSS modules, styled-components) — detect and warn only.
- Support for non-Vite/non-Next dev servers beyond a custom command escape hatch.
- Class components, React < 18.

---

## 2. Target user & positioning

**Primary persona (MVP):** the design engineer / solo founder — designs and ships production React alone, has 2+ year old codebases with duplicated UI, cares about code quality but can't justify days of manual refactoring. (This is a build-for-yourself product first: MintWash, BidBOO, WholesaleBook are the first test codebases.)

**Secondary persona (post-MVP):** frontend leads at small teams who want to consolidate toward a design system without a rewrite.

**Positioning:** "Onlook helps you design in code. dedup cleans up the code your designs left behind." Not a competitor to visual builders — a complement that plugs the gap none of them address.

---

## 3. MVP scope — feature requirements

### 3.1 Project open & load

**P0 — must ship**

- **FR-1.1** Open a project folder via native macOS file picker or drag-onto-window. Recent projects list on the launch screen.
- **FR-1.2** Detect project type on open: package manager (npm/pnpm/yarn/bun), framework (Vite / Next.js), Tailwind presence, TypeScript presence. Show a compatibility summary before loading ("Vite + React 18 + Tailwind 3 + TS — fully supported").
- **FR-1.3** Start the project's dev server as a managed child process (auto-detect `dev` script; allow custom command override). Show streamed logs in a collapsible console drawer. Detect the ready URL and port.
- **FR-1.4** Render the running app in an embedded webview on the canvas. Support viewport presets (mobile 390px, tablet 768px, desktop 1440px) and manual resize.
- **FR-1.5** Require a clean-ish git state: if the working tree is dirty, warn and offer to continue read-only or let the user proceed anyway. All write operations happen on a dedicated branch (see FR-4.6).
- **FR-1.6** Graceful failure states: dev server crash (show logs + restart button), port conflict (auto-increment), unsupported project (explain what's missing).

### 3.2 Element ↔ source mapping (the plumbing everything depends on)

**P0**

- **FR-2.1** Inject a build-time tagging plugin into the user's dev pipeline that stamps every JSX element with a `data-dedup-id` attribute encoding `file:line:col` + component name. Implementation: a Vite plugin (Babel/SWC transform) injected via a temporary config wrapper — never permanently modifying the user's config. For Next.js, inject via a wrapped `next.config` using the same transform.
- **FR-2.2** An overlay layer in the canvas (injected script) that on hover highlights the element under cursor with its component name badge, and on click selects it — reporting the `data-dedup-id` back to the app over a message bridge.
- **FR-2.3** Selection resolves to the exact AST node: Rust backend (or Node sidecar) parses the file with SWC/ts-morph and locates the JSX element at file:line:col.
- **FR-2.4** Breadcrumb of the component ancestry for the selected element (e.g. `HomePage → PricingSection → PlanCard → Button`), clickable to re-select any ancestor.

**Known limitation (accepted for MVP):** elements rendered inside `.map()` loops map to one source node for many DOM instances. Selecting any instance edits the shared source. Show a subtle "×12 instances" badge when this is detected.

### 3.3 Figma-style right panel (inspect & fine-tune)

**P0**

The right panel mirrors Figma's inspector layout and vocabulary so it feels instantly familiar. It operates exclusively on Tailwind classes.

- **FR-3.1** **Selection header:** component name, file path (click to reveal in Finder / open in editor via `code --goto file:line`), instance count badge.
- **FR-3.2** **Layout section:** display (flex/grid/block), direction, justify/align, gap, padding, margin — rendered as Figma-like controls (four-way padding input, alignment grid). Each control reads the current computed Tailwind classes and writes class changes.
- **FR-3.3** **Size section:** width/height/min/max with Tailwind scale steppers and arbitrary value input (`w-[137px]`).
- **FR-3.4** **Typography section:** font size, weight, line height, letter spacing, color, alignment — Tailwind classes only.
- **FR-3.5** **Fill & border section:** background color, border width/color/radius, shadow — with a color picker that snaps to the project's Tailwind theme tokens first, arbitrary values second. Theme tokens are parsed from `tailwind.config.*` on project load.
- **FR-3.6** **Classes field:** raw editable class list (the escape hatch), with autocomplete from the project's Tailwind config.
- **FR-3.7** All edits apply **live** to the canvas instantly (patch the class in the DOM via the bridge), and are staged — not yet written to disk — until the user hits **Save (⌘S)**.

**P1 — nice to have in MVP if time allows**

- FR-3.8 Text content editing (double-click text to edit static string literals only).
- FR-3.9 Hover/active/dark variant toggle to preview `hover:` / `dark:` classes.

### 3.4 Write-back engine

**P0**

- **FR-4.1** On Save, staged edits are applied to source via AST transformation (locate JSX node → rewrite `className` attribute), preserving formatting elsewhere in the file. Run the project's Prettier config on modified files if present.
- **FR-4.2** Only `className` string literals and simple template literals with a static base are editable. If the class attribute is fully dynamic (`className={cn(styles[variant])}`), the panel goes read-only for that element with an explanatory tooltip. Honesty over magic.
- **FR-4.3** After write, rely on the dev server's HMR for canvas refresh; verify the edit landed by re-reading the tagged element.
- **FR-4.4** Undo/redo stack for staged edits (pre-save). Post-save undo = git revert of the specific change (each save is a commit, see below).
- **FR-4.5** Every Save creates a commit on the dedup working branch with a descriptive message (`dedup: adjust padding on PlanCard`). User squashes/merges via their normal git flow.
- **FR-4.6** On first write operation, create/switch to branch `dedup/session-<date>` (configurable). Never write to main directly.

### 3.5 Deduplication engine (the differentiator)

**P0 — scan & cluster**

- **FR-5.1** **Component inventory:** static scan of the codebase (SWC-based) building a registry of all function components: name, file, props signature, JSX structure summary, export type.
- **FR-5.2** **Similarity scoring**, three signals combined into a weighted score:
  - *Structural:* normalized JSX tree comparison (tag sequence, nesting shape) via tree edit distance on a simplified AST. Class lists compared as token sets grouped by category (spacing/color/typography), so `p-4` vs `p-6` counts as "same knob, different value."
  - *Visual:* render each candidate component in isolation inside a hidden sandbox route (auto-generated harness page served by the dev server) with neutral mock props, screenshot via the webview, compare perceptual hashes. Components that fail to render in isolation (need context/providers) fall back to structural + semantic only, flagged accordingly.
  - *Semantic:* embed normalized component source and cluster by cosine similarity (local embedding model or API — configurable; API key in settings, off by default for privacy).
- **FR-5.3** **Cluster review UI:** a dedicated "Duplicates" tab listing clusters ranked by confidence × instance count. Each cluster shows side-by-side rendered previews, the diff of their JSX/classes, file locations, and total call-site count. User can remove members from a cluster or dismiss the cluster ("not duplicates" — persisted so it isn't resurfaced).

**P0 — guarded merge**

- **FR-5.4** **Merge proposal:** for a confirmed cluster, generate (LLM-assisted, Claude API, user-supplied key) a single canonical component where differences become props/variants — preferring a `variant` union prop + cva-style class maps over boolean prop sprawl. Show the proposed component source and the rewritten call sites as a reviewable diff before anything is written.
- **FR-5.5** **Call-site rewrite:** codemod every usage of the merged-away components to the canonical one with correct props; update imports; mark old files for deletion (moved to a `.dedup-trash/` staging dir, deleted only on session end confirmation).
- **FR-5.6** **Safety gate — a merge lands only if all pass:**
  1. `tsc --noEmit` passes (or the project's existing typecheck script).
  2. Project builds/dev server HMR shows no compile errors.
  3. Visual regression: screenshot every affected call-site route/harness before and after; pixel diff must be under a configurable tolerance (default 1%). Any failure → automatic rollback of the merge commit + a report showing which check failed and why.
- **FR-5.7** Each merge is its own commit (`dedup: merge Card, ProductCard, InfoCard → Card`), individually revertible from a session history panel.

**P1**

- FR-5.8 "Merge behavior differences" detection: if candidates differ in handlers/logic (not just markup/classes), warn loudly and default to markup-only merge with behavior passed in as props.
- FR-5.9 Batch mode: queue multiple cluster merges, run gates sequentially, report a summary.

### 3.6 App shell & layout

**P0**

- **FR-6.1** Three-zone layout: left sidebar (Pages/Layers/Duplicates tabs), center canvas (webview + zoom/pan, ⌘+scroll to zoom), right inspector panel. Top bar: project name, branch indicator, viewport switcher, Save state, Scan button.
- **FR-6.2** **Layers tab:** component tree of the current route (derived from the tagging data), synced with canvas selection both directions.
- **FR-6.3** **Pages tab:** detected routes (file-based routing parse for Next/Vite+router conventions); clicking navigates the canvas webview.
- **FR-6.4** Keyboard: ⌘S save, ⌘Z/⇧⌘Z undo/redo, Esc deselect, ⌘1/2/3 viewport presets.
- **FR-6.5** Dark-mode-first UI, matching the density and feel of Figma's inspector (small controls, 11–12px labels, generous use of segmented controls).

---

## 4. Technical architecture

### 4.1 High-level

```
┌─────────────────────────── Tauri (macOS) ───────────────────────────┐
│                                                                      │
│  Webview UI (React + TS + Tailwind)                                  │
│  ├─ Canvas: <webview/iframe> → user's dev server (localhost:PORT)    │
│  │   └─ injected overlay script ↔ postMessage bridge                 │
│  ├─ Inspector panel (Tailwind class ⇄ control mapping layer)         │
│  └─ Duplicates tab (cluster review, merge diff viewer)               │
│                                                                      │
│  Rust core (Tauri commands)                                          │
│  ├─ Process manager: dev server, tsc, git, prettier                  │
│  ├─ File watcher (notify) + read/write                               │
│  └─ Screenshot capture (webview snapshot API)                        │
│                                                                      │
│  Node sidecar (bundled)                                              │
│  ├─ SWC/ts-morph AST parse + transform (edits, codemods)             │
│  ├─ Vite/Next config wrapper + tagging plugin injection              │
│  ├─ Component inventory + structural similarity                      │
│  └─ Harness route generator for isolated component rendering         │
│                                                                      │
│  External (optional, user key): Claude API for merge proposals,      │
│  embeddings for semantic similarity                                  │
└──────────────────────────────────────────────────────────────────────┘
```

**Why a Node sidecar:** all serious JS/TS AST tooling (SWC bindings, ts-morph, jscodeshift, Tailwind config resolution) lives in the Node ecosystem. Fighting to do this in pure Rust is wasted time for an MVP. Tauri bundles the sidecar binary.

### 4.2 Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Element↔source mapping | Build-time attribute injection | Proven approach (Onlook); deterministic; works with HMR |
| Style model | Tailwind-only | Statically round-trippable; matches target user; scope control |
| Write mechanism | AST edit + Prettier | Never corrupt files; preserve user formatting |
| Safety model | Branch + commit-per-change + gates | Every operation revertible; user trusts the tool with real code |
| Merge intelligence | LLM proposal + deterministic gates | LLM is good at "what should the unified component be"; gates make it safe regardless of LLM quality |
| Isolation rendering | Auto-generated harness route on the user's own dev server | Reuses their exact build/theme; no separate bundler needed |

### 4.3 Performance targets

- Project open → canvas rendered: ≤ 20s on a typical Vite project (dominated by their dev server boot).
- Select element → inspector populated: ≤ 150ms.
- Class edit → canvas update: ≤ 50ms (DOM patch, no file write).
- Save → HMR settle: ≤ 2s.
- Full duplicate scan, 300-component codebase: ≤ 90s structural+semantic; visual pass ≤ 5 min (parallel harness screenshots).

---

## 5. UX flows (MVP)

### Flow A — open & tweak
1. Launch → drag project folder in → compatibility check passes → dev server boots with tagging plugin → canvas shows app.
2. Click a button → inspector shows its Tailwind-derived controls → nudge padding 4→6 → canvas updates live → ⌘S → commit on `dedup/session-*` branch → HMR confirms.

### Flow B — scan & merge
1. Click **Scan** → progress (inventory → structural → visual → semantic) → Duplicates tab badge shows "7 clusters".
2. Open top cluster: `Card` (3 files, 41 call sites, 92% confidence) → side-by-side previews + class diff → confirm cluster.
3. **Propose merge** → canonical component + call-site diffs shown → user reviews, optionally edits the proposed component source inline → **Merge**.
4. Gates run (typecheck ✓ → build ✓ → visual regression 0.3% ✓) → merge commits → cluster marked resolved → summary: "3 components → 1, 41 call sites rewritten, −214 LOC."
5. If a gate fails → automatic rollback → failure report (which call site, which screenshot diff) → user can adjust and retry.

### Flow C — recover
Session history panel lists every commit this session → revert any single change → canvas refreshes.

---

## 6. Success metrics (MVP)

- **Activation:** ≥ 80% of compatible projects reach "canvas rendered + first element selected" without manual config.
- **Trust (the metric that matters):** zero instances of a merge landing that breaks build or visibly regresses UI past tolerance — the gates must be airtight. One corrupted user codebase kills this product.
- **Core value:** on the three internal codebases (MintWash, BidBOO, WholesaleBook), the scan finds ≥ 5 legitimate clusters each, and ≥ 70% of proposed merges pass gates on first attempt.
- **Efficiency proof point:** a 3-component merge with ~40 call sites completes (review included) in under 10 minutes vs. an estimated 2+ hours manually.

---

## 7. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Dynamic classNames make inspector read-only too often | Editing feels broken | Read-only with clear explanation; measure % of selections that are editable; consider `cn()`/`clsx` static-part editing post-MVP |
| Components won't render in isolation (contexts, data) | Visual signal missing for many clusters | Graceful degradation to structural+semantic; label confidence accordingly |
| LLM merge proposals are subtly wrong | Trust destroyed | Gates are deterministic and non-negotiable; proposal is always human-reviewed diff; markup-only merges by default |
| `.map()` instance ambiguity confuses users | Editing surprises | Instance-count badge; docs; never hide it |
| Next.js config wrapping is fragile across versions | Support burden | MVP: pin support to Next 14–15 + Vite 5–6; explicit version matrix in compat check |
| Scope creep toward Onlook feature set | Never ship | Non-goals list is contractual; dedup engine gets ≥ 50% of build time |

---

## 8. Milestones (solo builder, aggressive but honest)

| Phase | Duration | Deliverable |
|---|---|---|
| 0. Spike | 1 wk | Tauri shell + open project + dev server child process + webview canvas |
| 1. Mapping | 2 wk | Tagging plugin (Vite first) + hover/select overlay + AST node resolution |
| 2. Inspector | 3 wk | Right panel (layout/size/type/fill) + live patch + AST write-back + git branch/commits |
| 3. Scan | 3 wk | Inventory + structural similarity + cluster review UI (semantic/visual signals stubbed) |
| 4. Merge | 3 wk | LLM proposal + codemod + typecheck/build gates; visual regression gate |
| 5. Harden | 2 wk | Visual similarity pass, harness rendering, failure states, Next.js support, dogfood on MintWash |
| **Total** | **~14 wk** | MVP dogfooded on 3 internal codebases |

Cut line if timeline slips: ship Phases 0–4 with structural+semantic similarity only (no visual pass), Vite-only. That is still the product no one else has.

---

## 9. Open questions

1. Webview screenshot fidelity in Tauri (WKWebView snapshot API) — validate in Phase 0 spike; fallback is a headless Chromium sidecar (playwright-core) for the visual passes only.
2. Embeddings local vs. API — default to structural-only scan with semantic as opt-in until decided.
3. Licensing/positioning: fully closed, open-core (engine open, app paid), or free-while-dogfooding? Decide before public launch, not before building.
4. Should Save also work with no git repo present (fallback to internal snapshots)? MVP stance: require git — the safety model depends on it.
