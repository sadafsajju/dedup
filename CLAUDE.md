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
pnpm test:overlay       # overlay load + select/stage paths against a stub DOM
pnpm test:actions       # staged program → write-back ops (incl. insert folding)
pnpm test:scan          # duplicate-scan bundle tests
pnpm test:tw            # tailwind class⇄knob mapping tests
pnpm test:errors        # dev-server output → build-error parsing
pnpm test:origins       # which session (origin) a page artboard renders under
pnpm test:chat          # AI chat edit-block parse/apply
pnpm test:merge         # guarded-merge codemod (tests the BUILT bundle)
pnpm test:proposal      # merge proposal parse + review diff + gate rules
pnpm test:highlight     # code-panel syntax colouring (round-trip invariant)
cargo test              # from src-tauri/ — all Rust tests
```

## Architecture map

- `src-tauri/src/` — Rust core: `project.rs` (detection), `devserver.rs`
  (child process in own pgroup, log streaming, ready-URL parse), `proxy.rs`
  (HTTP→self-signed-HTTPS tunnel for the canvas), `instrument.rs` (writes
  plugin assets into the user's `node_modules/.dedup/`, rewrites vite launch),
  `sidecar.rs` (one-shot node runner for write-back), `git.rs` (session
  branch + scoped commits), `session.rs` (mock-session seed for zero-login
  editing + the auth-context scanner that feeds its AI draft), `merge.rs`
  (guarded-merge sidecar runner, the typecheck/build gates, session history +
  rollback), `visual.rs` (PNG diff for the regression gate, perceptual hash
  for the visual similarity signal).
- `plugin-src/` — JS that runs *inside the user's project*: `jsxwalk.mjs` (the
  shared JSX traversal defining element ids + what may be done to each node),
  `tagcode.mjs` (the one stamping transform, shared by both build pipelines),
  `tagger.mjs` (Vite plugin + harness/routes/session routes), `next.mjs` +
  `next-loader.mjs` (the Next config wrapper and its webpack loader),
  `overlay.js` (in-iframe hover/select/staged-program preview/drag-to-reparent
  + postMessage bridge), `writeback.mjs` (AST inspect + edit programs:
  class/text/insert/remove/move), `files.mjs` (the one project traversal the
  scan and the merge share), `resolve.mjs` (import-specifier resolution:
  relative, tsconfig `paths`, `baseUrl`), `merge.mjs` (the guarded-merge
  codemod). Bundled self-contained by `build.mjs` — never depends on the
  user's node_modules.
- `src/` — editor frontend (React 19 + Tailwind v4 + zustand):
  `lib/store.ts` (all state incl. the staged edit program), `lib/types.ts`
  (`EditAction` — the one description of an edit, previewed/undone/reviewed/
  written), `lib/tailwind.ts` (class⇄knob mapping + `mergeClasses`),
  `lib/errors.ts` (dev-server stream → build errors), `lib/palette.ts`
  (insertable elements), `lib/bridge.ts` (iframe messaging),
  `lib/mergeProposal.ts` (the model boundary: prompt + strict reply parsing),
  `lib/mergeFlow.ts` (the gate runner), `lib/diff.ts` (the review diff),
  `lib/visualPass.ts` (perceptual-hash similarity over the rendered gallery),
  `components/` (LaunchScreen/Editor/Canvas/Inspector/StylePanel/ReviewPanel/
  MergeReview/History/NextSetup).

## Gotchas (hard-won)

- `src-tauri/assets/*` are embedded via `include_str!`. After
  `pnpm build:plugin`, the tauri-dev watcher does NOT notice the asset change
  — `touch src-tauri/src/instrument.rs` to force the rebuild/restart.
- `overlay.js` is one IIFE: anything that throws while it evaluates silently
  kills every listener declared after it, and the canvas just stops selecting
  with no error anywhere the user can see. It is injected `defer`, so
  `readyState` is `"interactive"` and `mount()` runs during evaluation —
  everything it touches must be declared above it. `pnpm test:overlay` guards
  the load path; run it after touching that file.
- Overlay/tagger/writeback reach the user's project at **dev-server start**
  (`instrument::setup`) — plugin changes require the user to reopen the
  project, not just an app restart. The mock-session seed is the exception:
  the tagger reads `node_modules/.dedup/session.json` per request, so saving
  one takes effect on the next frame reload.
- Protected pages: **signing in for real is the primary path**, not the mock
  seed. One WebKit session backs every same-origin frame, so one login
  unlocks every artboard with real tokens. Seeds only work for apps that keep
  the session in JS-reachable storage — an SDK-managed one (Firebase →
  IndexedDB, NextAuth → httpOnly cookie, Clerk) is unreachable by
  construction, which `session::detect_auth_provider` reports up front.
- Which session a page artboard renders under is decided in one place:
  `resolveOrigin` (`lib/origins.ts`), reconciling the user's explicit
  per-artboard choice (auto/in/out) with the automatic redirect fallback.
  It is pure so React and the store share one implementation — never inline
  origin-picking into a component. "Signed out" = a second loopback spelling
  of the dev server (separate storage bucket, so genuinely no session);
  nothing about it is mocked.
- The automatic guest-origin fallback (`frameOrigins`) is for pages guarded
  *against* signed-in users. It is backwards for pages guarded *for* them —
  separate origin, separate storage, so a real login never applies there, and
  providers checking authorized domains only whitelist `localhost`. Anything
  that changes the session must call `reloadPinnedFrames` to put every frame
  back on the shared origin at its pinned route.
- **In browse mode, never touch the frame.** The `page-meta` handler returns
  early there. Both of its reactions (guest-origin flip, snap-back to the
  pinned route) reload or relocate the frame, which destroys any in-memory
  state a multi-step flow is holding — a phone-OTP login restarts. The
  gesture flag is a 1.5s heuristic and is *not* reliable for async flows.
- One head-injected boot script (`buildBootScript` in the tagger) carries
  everything that must run *before the app boots*: the mock-session seed and
  the hold. Both are gated to framed pages by the wrapper, never by their own
  content — neither may run when the user opens their dev server in a
  browser. The seed writes browser storage only; it never mocks the render,
  because the user edits what they see.
- **Hold** freezes a frame on its first screen (splash/interstitial editing)
  by queueing timers ≥400ms and freezing `history`. Never hold short timers:
  React's scheduler falls back to `setTimeout`, so stalling it hangs the page
  instead of pausing it. It is armed by `?__dedup_hold=1` on the frame URL
  (`HOLD_FLAG`, duplicated in `lib/origins.ts` and the tagger because they
  are separately bundled — `test:origins` asserts they agree).
- **A merge is the one place a bug corrupts a codebase.** Its rules are not
  negotiable and are each covered by a test: every output file is re-parsed
  *before any file is written* (all-or-nothing across files, the same guarantee
  the class write-back makes within one file); a call site only counts when its
  binding resolves to the member's file through a real import — a name match is
  not a call site; and the model's reply crosses one narrow boundary
  (`lib/mergeProposal.ts`), never the codemod's decisions about what to rewrite
  or delete. When adding to it, add the refusal and its test first.
- **A gate that could not run is not a gate that passed.** `skipped` is a real
  verdict with a reason attached (no typecheck script, no build script, no
  artboard on screen), and it must survive into the summary line. Rounding it
  up to a pass is the failure mode the whole phase exists to prevent.
- Merge rollback restores the commit's own paths and commits that — never
  `git revert`, which demands a clean tree and would involve the user's
  in-flight work.
- The Vite plugin and the Next webpack loader both call `tagcode.mjs` and
  nothing else. An element's id is its ordinal in `jsxwalk`, so a second
  stamping implementation would be a second, silently incompatible identity
  scheme for one write-back. Never fork it (same rule as jsxwalk itself).
- Next.js: element tagging needs a line in the user's `next.config`, because
  Next has no `--config` flag. Two things that only showed up on a real app —
  a TypeScript config under `strict` needs the shipped `next.d.mts` or dedup's
  own line fails dedup's typecheck gate, and Turbopack never runs `webpack()`,
  so dedup runs `next` directly under `--webpack`. It cannot *append* the flag
  through the package manager: a script that already says `--turbopack` then
  gets both and Next refuses to start. The rewrite lifts the script's
  `KEY=value` prefixes into the child env (dropping them reintroduces the OOM
  a heap bump was added for) and refuses any script with shell operators. That is offered with its diff, committed on the
  session branch and undoable — and the wrapper is inert without
  `DEDUP_TAGGING=1`, so it changes nothing about the user's own `next dev`,
  CI or production build. The convention forbids *silent* mutation; this is
  the opposite of silent.
- The visual similarity hash is median-thresholded aHash, **not** dHash. dHash
  only sees horizontal gradients, so a component with a dark left column and
  one with a dark top row hash identically — and UI is mostly flat,
  axis-aligned blocks. Both invariants are pinned by tests; don't "simplify"
  it back.
- Route discovery has two callers — the Vite plugin's `/__dedup/routes`
  middleware and the write-back sidecar's `routes` command — because Next has
  no middleware dedup can add. It lives in `plugin-src/routes.mjs`; a copy in
  either caller would mean Vite and Next projects disagreed about what pages a
  project has.
- The code panel paints highlight tokens *behind* a transparent textarea, so
  `tokenize` must round-trip its input exactly. A dropped or added character
  moves the caret away from the text under it. `test:highlight` pins it.
- The chrome floats over a full-bleed canvas. Anything that positions content
  on the canvas (initial pan, focus-a-route, the Components gallery) must inset
  by the live panel widths, or it lands under a panel. `.panel` in `styles.css`
  is the single definition of that elevation — new floating surfaces use it
  rather than re-deriving a shadow.

- tauri-dev hot-restarts kill the app hard → the user-project dev server can
  be orphaned. Check `lsof -nP -iTCP:5173 -sTCP:LISTEN` after restarts; kill
  leftovers.
- Vite on macOS binds `[::1]` (IPv6) only; anything dialing the dev server
  must try IPv6 loopback first.
- Tailwind JIT: classes not present in source have NO generated CSS — that's
  why the overlay mirrors staged classes as inline styles (theme-var based).
- Write-back edit positions come from one parse (magic-string ranges), so
  ops within a file need no ordering — and a program applies completely or
  not at all (output is re-parsed before any write).
- An element's id is its **ordinal in `jsxwalk.mjs`'s traversal**, not a
  source position — so a save shifting columns no longer invalidates ids.
  The catch: the tagger and the write-back must walk identically, which is
  why both import that one module. Never fork it. (A structural save *does*
  renumber ordinals after the edit, so those saves end with a canvas reload.)
- Structural gestures are gated by what the write-back says it will accept
  (`inspect` capability flags, mirrored into `data-dedup-dyn`/`-core` so the
  overlay can refuse a drag before it starts). Adding an edit type means
  teaching all three: jsxwalk (classification), writeback (op + refusal),
  overlay (preview + inverse).

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
