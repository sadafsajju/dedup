# dedup — working notes for agents

macOS Tauri 2 app: opens a React+Tailwind codebase, Figma-style inspection and
Tailwind editing with AST write-back and AI chat edits.
Deduplication was removed on 2026-11-10; earlier progress entries are historical. **Read `dedup-mvp-prd.md` before
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
pnpm test:tw            # tailwind class⇄knob mapping tests
pnpm test:errors        # dev-server output → build-error parsing
pnpm test:origins       # which session (origin) a page artboard renders under
pnpm test:chat          # chat agent: tool protocol + multi-file edit parse/apply
pnpm test:highlight     # code-panel syntax colouring (round-trip invariant)
pnpm test:html          # static sites: HTML walk/stamp/write-back + the server
pnpm test:prompts       # chat composer: ↑/↓ prompt history state machine
pnpm test:mentions      # chat composer: which agent `@claude`/`@codex` routes to
pnpm test:parking       # parked canvas pieces + one-gesture undo (lib/parking, lib/undo)
pnpm test:marquee       # what a marquee selects (plugin-src/marquee.mjs) + multi-selection rules
pnpm test:commit        # Commit tab: the one list, the message, when push/land are offered
pnpm test:openprefs     # when opening a project stops to ask (command / dirty tree)
pnpm test:canvas        # the canvas a project reopens with (routes + choices)
pnpm test:annotate      # canvas markup: rough.js geometry + what a mark stores
pnpm test:frame         # frame-blocking response headers the canvas must relax
cargo test              # from src-tauri/ — all Rust tests
```

## Architecture map

- AI backends are coding-agent CLIs the user already pays for (`ai.rs`:
  `Agent::ClaudeCode`, `Agent::Codex`), with a raw API key as the fallback.
  Everything agent-specific — binary name, install fallbacks, the flags that
  mean "headless, no tools, no session", how the answer is framed — lives in
  `Agent`; adding one is a match arm plus a row in `CLI_AGENTS` (lib/types).
  That now includes `asset_dir` — where the agent leaves files it generates,
  which is the whole trust boundary for importing one (see `asset.rs`).
  They are asked for *text*, never given tools or write access: dedup edits
  through its own parse-gated write-back, and a second path to the user's
  source would be an unaudited one.
- An agent is only usable after an explicit Connect — a live round-trip. It is
  the one thing that distinguishes "installed" from "signed in", which for
  these CLIs is a real and common difference.
- `src-tauri/src/` — Rust core: `project.rs` (detection), `devserver.rs`
  (child process in own pgroup, log streaming, ready-URL parse), `proxy.rs`
  (HTTP→self-signed-HTTPS tunnel for the canvas), `instrument.rs` (writes
  plugin assets into the user's `node_modules/.dedup/`, rewrites vite launch),
  `sidecar.rs` (one-shot node runner for write-back), `git.rs` (session
  branch + scoped commits), `session.rs` (mock-session seed for zero-login
  editing + the auth-context scanner that feeds its AI draft), `history.rs`
  (session save history and scoped undo), `publish.rs` (push a named branch;
  fast-forward the user's branch to the session — the only git that leaves
  the session branch), `asset.rs` (the gated copy of an agent-generated image into the
  project), `scaffold.rs` (the two starters written into an empty folder),
  `export.rs` (an artboard as PNG or
  vector PDF, rendered off-screen at its real size), `appmenu.rs` (the menu
  bar: Tauri's default menu plus Settings… ⌘,), `terminal.rs` (the console
  drawer's shells: the user's login shell on a PTY in the project root).
- **Two kinds of project.** A *node* project (Vite/Next) runs the user's own
  dev server with dedup's tagger injected into the build. A *static* project (a
  folder of `.html` files, `Framework::Static`) has no build to inject into, so
  **dedup is the dev server**: `plugin-src/serve.mjs` serves the folder and runs
  every HTML response through the stamper on the way out. Same guarantee — ids
  exist only in what the browser receives — reached by a shorter road. It
  announces its URL in Vite's format on purpose, so `devserver.rs` needs no
  second code path for it.
- **Every folder opens; there is no compatibility verdict** (owner's decision,
  2026-11-10). `project::detect` describes, it does not grade: `framework` is
  only *how dedup drives it* (`Unknown` = run the project's own server as
  written, untagged), `stack` is what it is called, and `runnable` is the one
  thing that can make opening stop — to ask for a command, never to refuse.
  What dedup cannot do for a project is said inside the editor, beside the
  thing that is off (the instrumentation event), not at the door. Don't
  reintroduce a grade, a struck-out capability chip, or a "first open" card:
  `reasonToAsk` (`lib/openPrefs.ts`) returns only `needs-command` and
  `needs-ack`. Backend markers (`manage.py`, `artisan`, `bin/rails`…) are
  checked **before** the JS heuristics on purpose — Laravel depends on `vite`
  and Rails ships `public/404.html`. And opening wider did not widen the write
  gate: `validateContent` still refuses any file type it has no check for.
- An empty folder is not an unsupported project, it is a project that does not
  exist yet: `project::detect` reports `is_empty` before any heuristic runs, and
  the launch screen offers a starter (`scaffold.rs`) instead of a verdict.
- `plugin-src/` — JS that runs *inside the user's project*: `jsxwalk.mjs` (the
  shared JSX traversal defining element ids + what may be done to each node),
  `tagcode.mjs` (the one stamping transform, shared by both build pipelines),
  `tagger.mjs` (Vite plugin + routes/session routes), `next.mjs` +
  `next-loader.mjs` (the Next config wrapper and its webpack loader),
  `overlay.js` (in-iframe hover/select/staged-program preview/drag-to-reparent
  + postMessage bridge), `writeback.mjs` (AST inspect + copy + edit
  programs: class/text/insert/remove/move), `files.mjs` (shared project traversal and parsing),
  `marquee.mjs` (which elements a marquee selects — pure, bundled into the overlay),
  bundled self-contained by `build.mjs` — never depends on the
  user's node_modules.
- `plugin-src/` (static sites): `htmlwalk.mjs` (the shared HTML traversal —
  htmlwalk is to HTML exactly what jsxwalk is to JSX), `htmltag.mjs` (the
  stamper), `htmlback.mjs` (the HTML write-back, which `writeback.mjs`
  dispatches to by file extension), `serve.mjs` (the static dev server), plus
  `boot.mjs` and `srcedit.mjs` — extracted because two callers each need one
  copy of what they hold (the head-injected boot script; the
  line/indent/re-indent helpers every write-back path needs).
- `src/` — editor frontend (React 19 + Tailwind v4 + zustand):
  `lib/store.ts` (all state incl. the staged edit program), `lib/types.ts`
  (`EditAction` — the one description of an edit, previewed/undone/reviewed/
  written), `lib/tailwind.ts` (class⇄knob mapping + `mergeClasses`),
  `lib/errors.ts` (dev-server stream → build errors), `lib/palette.ts`
  (insertable elements + the one-element snippet rewriter), `lib/bridge.ts`
  (iframe messaging),
  `lib/chat.ts` + `lib/chatEdits.ts` (the chat agent's boundary: prompt, tool
  protocol, and the strict parse of what comes back),
  `lib/promptHistory.ts` (the composer's ↑/↓ walk, pure so it can be tested),
  `lib/annotate.ts` (canvas markup: rough.js geometry, seeds, storage),
  `lib/diff.ts` (the review diff), `lib/commitTab.ts` (the Commit tab's list,
  message and push/land rules, pure),
  `components/` (LaunchScreen/ProjectDetails/Editor/Canvas/AnnotationLayer/
  Inspector/StylePanel/Sidebar → Pages/Layers/CommitTab/NextSetup).

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
- One head-injected boot script (`buildBootScript`, now in `boot.mjs` — the
  Vite tagger and the static server both inject it) carries
  everything that must run *before the app boots*: the mock-session seed, the
  offline cut and the hold. Both are gated to framed pages by the wrapper, never by their own
  content — neither may run when the user opens their dev server in a
  browser. The seed writes browser storage only; it never mocks the render,
  because the user edits what they see. Both servers **serve** it at
  `/__dedup/session.js` rather than inlining it: a seed is user-authored script
  text, and the string `</script>` anywhere inside an inline tag would close it
  and spill the rest of the boot script into the page as markup.
- **Offline** renders the app's no-internet state by cutting the *app's*
  network and nothing else: `fetch`/XHR/WebSocket/EventSource/`sendBeacon` fail
  and `navigator.onLine` reads false, while same-origin requests under the
  `TOOLING` prefixes (dedup's routes, `/@vite/`, `/node_modules/`, `/_next/
  static/`, …) and the `vite-hmr` socket still go out — cut those and the
  artboard stops hot-reloading the moment it goes offline. Nothing is mocked:
  every blocked request fails the way one fails with no network (WebKit's
  "Load failed", XHR readyState 4 + status 0, close code 1006), so what renders
  is the app's real behaviour. Armed by `?__dedup_offline=1` (`OFFLINE_FLAG`)
  and installed **before** the hold, which ends the boot script with an early
  return. Limitation worth knowing: it blocks requests the app *makes*, not
  subresources the browser fetches, so a remote `<img>` still loads.
- **Every frame flag lives in the query string and wears the `__dedup`
  prefix.** They have to reach the page before the app boots and the URL is
  the only channel that early, so anything sending a frame to a bare path
  drops them — an offline artboard silently comes back online while the
  editor's label still says otherwise. `withFlags` in the overlay carries them
  across any navigation it drives, matched by prefix rather than by name
  because the overlay is a third separately bundled world (after `boot.mjs`
  and `lib/origins.ts`) and one more list to sync is one more way to lose one.
- **Hold** freezes a frame on its first screen (splash/interstitial editing)
  by queueing timers ≥400ms and freezing `history`. Never hold short timers:
  React's scheduler falls back to `setTimeout`, so stalling it hangs the page
  instead of pausing it. It is armed by `?__dedup_hold=1` on the frame URL
  (`HOLD_FLAG`, duplicated in `lib/origins.ts` and the tagger because they
  are separately bundled — `test:origins` asserts they agree).
- **Double-click-to-edit has to wait for the write-back, not read it.** The two
  clicks of a double-click both select, and "may I type into this?" comes from
  a sidecar spawn that usually has not returned when `dblclick` fires. Reading
  `sourceInfo` and giving up on a null made the gesture work about half the
  time. `sourceInfoPending` (module scope in `lib/store.ts`, deliberately not
  store state — nothing renders it) holds the in-flight lookup so
  `requestTextEdit` can await it; `setSelected` short-circuits a re-select of
  the same element so the second click cannot throw the answer away.
- **The text tool follows the caret, not the other way round.** Only the
  overlay knows when an edit ends — Escape, Enter, a click elsewhere and a
  re-render all end one without the editor being asked — so it posts
  `text-editing {id|null}` and the store's `setTextEditing` owns the mode.
  `setTool` starts an edit and `setTextEditing` sets the tool *directly* rather
  than calling `setTool`, because routing it back through would bounce between
  the two. `textToolSticky` is the difference between the two ways in: T (or
  the toolbar button) is chosen and stays; a double-click borrows the tool for
  one edit and hands it back. `clearSelection` ends an edit in flight, because
  the overlay's `clear` does not and neither does the iframe losing focus (its
  blur handler only ends drags) — the element would otherwise stay
  contenteditable while the editor believed nothing was selected.
- **The chat agent has no tools — it has a protocol.** It replies `TOOL: read
  <path>` / `grep <pattern>` / `list`, dedup runs the read-only sidecar and
  feeds the results back as the next turn (`MAX_TOOL_ROUNDS` caps the loop).
  That is deliberate and load-bearing: a CLI agent given real file access would
  be a second, unaudited path to the user's source. Everything it can see,
  dedup fetched. Two rules keep it safe and each has a test — a SEARCH block
  naming a file the model never read is refused (a quote written from memory is
  what exact-match exists to catch), and a file over 120KB is never sent, because
  a truncated reply written back would delete the rest of the module.
- **A chat reply is a proposal, and a proposal is previewed on the canvas.**
  A diff says what changed; it cannot say how it *looks*, and looking is the
  reason dedup renders the app at all. So `sendChat` writes the proposal out —
  parse-gated, through `writeSources`, and **uncommitted** — and the running
  dev server shows it. The commit is the decision: `acceptChatEdit` commits to
  the session branch, `rejectChatEdit` calls `revertSources` to put every file
  back byte-for-byte (`before` in `pendingEdit`, `null` for a file the edit
  created, which is then removed). The safety line is *committed vs not*, not
  *written vs not* — same bargain Cursor makes, and the same one that makes the
  preview possible at all. Three consequences worth keeping: the revert path is
  the one write that is **not** content-gated (it restores bytes dedup read,
  and a file that was already broken must still be restorable — that is the
  case where the user asked the agent for help); leaving the project reverts a
  live preview, because closing is not a decision to keep it; and the top bar
  shows a live preview, because a user who switched off the chat tab otherwise
  has uncommitted AI edits with nothing on screen saying so.
- **An ASSET block is the one thing the model can say that names a path
  outside the project**, and it exists because an image is the one output an
  agent cannot type out as text. So it is a *request*, answered by `asset.rs`
  under gates of its own: the source must resolve (through symlinks —
  canonicalize both sides) inside that agent's `asset_dir` and nowhere else,
  it must sniff as PNG/JPEG/GIF/WebP by **magic bytes** rather than by the
  extension the model chose, the destination extension must agree with those
  bytes, and the destination must be a new path inside the root. A model
  naming `~/.ssh/id_rsa` is the case every one of those is written against.
  The prompt only mentions the directive for a backend whose `generatesAssets`
  is true — inviting one that could only fail is worse than not having it.
  Marker paths go through `undecoratePath`: the prompt writes placeholders as
  `<project-relative path>` and models copy the brackets, which reached the
  import gate as a file whose extension was `png>`. Angle brackets are stripped
  even unpaired (illegal in a path, so always decoration); quotes only in
  balanced pairs, because `it's.png` is a real filename.
  Imports run *before* the text write in `sendChat`, because a new file can be
  taken back cleanly and a landed text write cannot; and they ride the same
  proposal lifecycle as everything else (previewed uncommitted, committed on
  accept, removed on discard — `revertSources` with a null content).
- **Who answers is a property of the message, not a mode.** Both agents can be
  connected at once; `@claude`/`@codex` (`lib/mentions.ts`) sends one message to
  that agent and no mention means the top-bar default. Only the first mention
  routes and only it leaves the prompt — a later one is part of the sentence. A
  mention of an unconnected agent errors rather than falling back: a silent
  substitute is what the AI menu exists to rule out. The composer's `@` popup
  must take its keys *before* prompt history and Enter-to-send. So the AI menu
  is per-backend **switches**, not one choice (`agentOn` in `lib/types.ts` is
  the single rule for "may be sent to"); with no mention the first one on, in
  CLI_AGENTS order, answers — and so do the non-chat AI features, which have
  no `@`. A Codex model list comes from the installed CLI (`codex debug
  models`, `ai::models`), never a list in dedup: two copies of Codex on one
  machine can know different models, and a name the running copy doesn't know
  is a refused run.
- **An IMAGE block is how a model that cannot generate asks one that can.** It
  is offered only to a non-generating backend while a generating agent is
  connected, and it names no source path — dedup asks Codex itself
  (`imageRequestPrompt`), takes exactly one ASSET block from the answer
  (`pickGeneratedImage` refuses prose, two images, or any edit alongside), and
  imports it through `asset.rs` as **Codex's** output. So imports carry their
  agent: the gate is chosen per file, never per turn. Cheap refusals run on
  destinations before Codex is asked, because generating is the slow part.
  The requester names the destination before the image exists and cannot pick
  its format, so for a *delegated* import only, `asset::import` corrects a
  disagreeing extension (`hero.jpg` → `hero.png`) instead of refusing — the
  name still always agrees with the bytes — and `retargetReferences` renames
  the references that edit added. A name the user's file already used before
  the edit is refused, never renamed: it is theirs, about something else.
- Keep the proposal's file *contents* out of the persisted transcript (chat
  sessions are saved per project; source snapshots don't belong there), and
  keep it to one unresolved proposal: a second is computed against the contents
  the first put on disk, so both cannot be right. Superseding one reverts its
  preview first.
- **The composer's arrow keys are shared with the caret.** It is a textarea
  (Shift+Enter makes a line), so ↑ inside a multi-line draft must move the
  caret or the box cannot be edited — history only moves from the edges (↑ on
  the first line, ↓ on the last, nothing selected). `stepHistory` returns null
  for "not ours", and returns the *same* state for the ↑ at the oldest entry:
  swallowed, because a caret jumping to the top reads as a recall that failed.
  A half-written draft is stashed on the first ↑ and returned by the last ↓ —
  losing typed text to a keystroke is the failure that shape exists to
  prevent.
- **A selection is chat context, not a gate.** The composer works with nothing
  selected — that is the case where a user most needs it (a build error means
  there may be nothing on the canvas to click). Anything that re-adds a
  `!selected` guard to a chat path is re-breaking it; the same reasoning
  un-gated the console drawer's Ask AI button.
- `sidecar::resolve_in_root` canonicalizes the file, so it only ever names
  something that exists. Creating a file (the agent extracting a component)
  goes through `resolve_new_in_root`, which canonicalizes the nearest existing
  ancestor instead. Don't relax the first one to cover the second — the
  containment check is the whole point of both.
- **A copy is two renderings of one element, like a palette entry.** The
  *source* comes from the write-back's `copy` command (the file is the truth
  about what a paste writes) and the *picture* from the overlay's
  `copy-element` (only the page knows what that source rendered as) — deriving
  either from the other would mean a JSX renderer in the overlay. So a copy is
  what the **file** says, not what the screen shows: `copy` reports the
  ordinals it swallowed and the editor names the staged edits inside that the
  copy therefore doesn't carry. The overlay strips every `data-dedup-` stamp
  out of the markup it hands back — `data-dedup-id` above all, or the pasted
  preview answers to the same id as its original and every lookup in that file
  starts hitting whichever the DOM returns first.
- **A staged program must never be able to strand itself.** An edit addressed
  to a `pending:` insert is refused by `opsForFile` once that insert is gone —
  correctly, and *permanently*: every later save throws, and the chat refuses
  while any edit targets the file, so there is no way forward and no way back.
  `withoutAction` is why discarding an insert takes its edits with it (the rule
  `removeSelected` always had, which the review panel's per-row discard did
  not), and `discardAllEdits` is the escape hatch for a program that is already
  stuck. Anything new that drops actions individually needs the same rule.
- **`stage` is the one gate on what may be staged**, and it returns false when
  it refuses — a program is only ever invalid as a *combination*, so the check
  belongs where every action arrives rather than at each call site.
  `stagingConflict` holds the rule: an element on its way out cannot also be a
  party to another structural edit (something inserted against it, or a move in
  or out of it). Without it, paste-beside-a-section-then-delete-it built a
  program that could never be saved and blocked the chat too. Callers that
  chain off a stage — selecting a pasted element, clearing the selection after
  a delete — must check the return rather than assume.
- **A staged snippet carries its language** (`SnippetLang`). Palette markup is
  one element, so `toHtmlSnippet` can respell it for an HTML page; an arbitrary
  copied subtree has no such translation, and a mismatch is refused at paste
  time and again in `opsForFile`. For the same reason a pasted section is
  read-only until saved — the fold-into-the-snippet rewriter parses one element
  with quoted attributes, and `pendingNodeInfo` says so rather than accepting
  edits the save would refuse. Everything that reads or rewrites a staged
  snippet's classes must ask that language first (`classAttrFor`): writing
  `className` into an HTML page is an unknown attribute that styles nothing,
  so the restyle silently does not happen.
- **A cut and its paste land in one program.** Appending content onto a chunk
  the same program removes drops it silently, so both write-backs resolve what
  a program deletes *before* the op loop and refuse an insert whose anchor is
  being deleted or whose insertion point falls inside something that is. Before
  the loop, not during it: the two ops arrive in either order.
- **A save must never land on disk and then report failure.** `saveAll` and
  `saveCode` write first and commit second, so in a folder with no git the
  write succeeded, the commit threw, and the edit stayed staged under a save
  error — a second save could apply it twice. The no-git check therefore
  comes *before* the write (`needsDirectWriteWarning`), never after it.
- **"Set up git" (`git::init_baseline`) commits the user's files, not a
  preview.** A live chat proposal is set aside first (`revertPreview`) and put
  back after (`reapplyPreview`, images re-imported from the agent's own
  directory, hence `agent` on `PendingEdit.assets`), so the first commit in
  their new history never contains an AI edit they did not accept. If the
  baseline commit fails, the `.git` it just made is removed again.
- **A pending preview lives only in memory**, and a tauri-dev hot restart
  (any `src-tauri/` edit) kills the app hard — the preview stays on disk and
  its `before` snapshots are gone. Resolve a pending proposal before touching
  Rust while the user has one open.
- **`git commit -- <path>` takes a pathspec, and a pathspec only matches files
  git already knows.** Any dedup path that can be a *new* file — a chat agent
  creating a component or a page — must be
  `git add`ed first or the whole commit dies with "did not match any file(s)
  known to git", after the file is already on disk. `git::commit_paths` stages
  exactly the untracked paths in the set and no others: for a tracked path the
  bare pathspec form is what leaves the user's own staged version of that file
  alone, which is the FR-4.5 guarantee. A path that is neither tracked nor
  listed as untracked is `.gitignore`d, and is refused with that reason rather
  than force-added — overriding an ignore rule the user wrote down is not
  dedup's call.
- **Push and land are the only git that leaves the session branch**
  (`publish.rs`, owner's decision 2026-11-10), and the rules are structural,
  not checks to remember. Both take the branch and remote **by name** from a
  confirm in the Commit tab that spells the sentence out — never "whatever is
  configured", never as a side effect of a save. Push builds its own refspec
  (`refs/heads/x:refs/heads/x`), so there is no `+` and no way to force; a
  rejected push stays rejected. Land is **fast-forward or refuse**, done by
  moving the target's *ref* (`update-ref` compare-and-swap) with the target
  not checked out — HEAD, index and files never move, so the user's
  uncommitted work and a chat preview cannot be swept in by construction.
  The one path that moves files is "target is checked out in this folder",
  and it requires a clean tree; checked out in another worktree is refused.
  Diverged is a refusal on purpose: a merge commit is a tree nobody has seen
  rendered. Don't add `--force`, `-u`, `--no-verify`, a fetch, or a merge
  here without a new decision. Each refusal has a test; add the refusal first.
- **`SyncStatus` never touches the network.** "Behind the remote" is as of
  the user's last fetch and the tab says so; the push is what finds out.
  Remote URLs are stripped of `user:token@` before they reach the UI.
- **A save commits whole files, so it must not run over a chat preview.**
  `git commit -- <path>` takes the file as it is on disk; a staged edit saved
  into a file a live preview has changed would commit the AI's edit
  unaccepted. `previewClash` (`lib/commitTab.ts`) stops `saveAll` and
  `saveCode`, and blocks Undo on a commit whose file holds a preview (the
  restore would overwrite it). A new save path needs the same check.
- **`saveAll` takes an optional message — never wire it straight to
  `onClick`**, or the "message" is a MouseEvent. It checks `typeof`, and the
  type makes `onClick={saveAll}` a compile error; keep both. Whatever the
  user types, the subject is `dedup: …` (`commitMessage`): that prefix is how
  history and undo tell dedup's commits from the user's.
- History undo restores the commit's own paths and commits that — never
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
- **HTML5 has no such thing as invalid input**, so "the output still parses"
  proves nothing about an HTML edit — a class attribute with a stray quote
  becomes a very long class attribute that ate the rest of the page, and the
  parser reports no error. The HTML write-back's gate is therefore *structural*:
  for a content-only program the output's tag sequence (depth + tag, in walk
  order) must be **identical**; for a structural one the element count must be
  exactly what the ops said; and either way the output may introduce no HTML5
  parse error the input did not already have. The snippet validator is part of
  the same rule — an unclosed `<div>` is a legal fragment that would swallow
  every sibling after it, so it is refused where the intent is still visible.
  Each rule has a test in `test:html`; add the refusal and its test first.
- The JSX palette snippet is respelled for HTML exactly once, at the boundary
  (`toHtmlSnippet` in `lib/palette.ts`, called from `opsForFile`). Staging keeps
  one spelling so the fold-into-the-snippet path has one shape. `<div />` is not
  a self-closing div in HTML — it is a `<div>` that never closes — so the
  translation pairs non-void tags as well as renaming `className`.
- **A static site has no node_modules to hide in.** `node_modules/.dedup` was
  chosen because it is git-invisible by construction; creating one in a static
  site purely to hide files would put an untracked folder in the user's repo.
  `sidecar::support_dir` is the single answer to "where do dedup's files for
  this project go" — `node_modules/.dedup` when there is a package.json, the
  app cache dir keyed by project path otherwise. Never hardcode the path again.
- The static server takes both `--root` (the folder it serves) and `--base`
  (the project root). They differ when the pages live in `site/`, `www/`,
  `public/`. Ids are always relative to `--base`, because that is the path the
  write-back opens — one project, one path vocabulary. `test:html` pins the
  round-trip across the two separately-bundled halves.
- **The bundle tests test the built bundles.** After editing anything under
  `plugin-src/`, run `pnpm build:plugin` before the suites, or you will be
  testing the previous build and drawing conclusions from it.
- Route discovery has two callers — the Vite plugin's `/__dedup/routes`
  middleware and the write-back sidecar's `routes` command — because Next has
  no middleware dedup can add. It lives in `plugin-src/routes.mjs`; a copy in
  either caller would mean Vite and Next projects disagreed about what pages a
  project has.
- The code panel paints highlight tokens *behind* a transparent textarea, so
  `tokenize` must round-trip its input exactly. A dropped or added character
  moves the caret away from the text under it. `test:highlight` pins it.
- Overlay chrome is drawn in **screen** pixels (`position: fixed`), not page
  ones — the element-name badge and the resize grips both rely on it, so they
  stay legible however far the canvas is zoomed out. The busy grid is the
  exception that proves it: it is sized *from* the element's rect, because it
  is meant to cover the thing it is about.
- **A re-parent drag says three things, and none of them touch the page.** The
  grab/grabbing cursor is a stylesheet the overlay owns, keyed by dedup id
  (`setCursor`) — the user's app names a cursor on nearly everything, so it
  takes `!important` to outrank, and `grabbing` is scoped to the *document*
  because mid-drag the pointer is over whatever it passes. The drop **ghost**
  is the element's own footprint drawn in the slot it would land in, which the
  2px line cannot say: it clamps the cross axis to the container, places
  `inside` as the **last** child (where the write-back puts it) and, in a flex
  row, draws `before` to the *left* — a ghost stacked above a row is a
  confident lie. Grid is deliberately not guessed at. The dragged element's
  fade is inline and restored to what was found, and every way a drag can end
  (pointerup, Escape, blur) must clear all three — `test:overlay` walks them.
- **In the select tool a drag is one of two gestures, decided at the press**
  (settled 2026-11-10, when the marquee landed). A press *inside the single
  selected element* picks that element up — the re-parent drag, unchanged from
  there on (ghost, capture, park, cross-artboard). Every other press-and-drag
  draws a **marquee**; Shift always means marquee, and adds to the selection;
  with several selected a drag is always a marquee. `dragOwner` in the overlay
  is the whole rule. It replaced "any press on any element is a drag" because
  a page has no empty space — every pixel is inside some element — so that
  rule left nowhere to start a marquee from. The cost, on purpose: moving an
  element is now select, then drag (Figma's order), and the grab cursor is
  offered only over the selection. Three things that are easy to break: a
  marquee release is never also a click (`suppressClick`, spent by the click
  the browser fires next, reset by the next press) or a `drop` (its branch
  returns before the drag's); Escape mid-marquee is *not* forwarded, or it
  would also deselect what was there before; and every way it can end —
  release, Escape, blur, leaving the tool — hides the box. `test:overlay`
  walks them.
- **What a marquee selects is one pure function** (`marqueeHits`,
  `plugin-src/marquee.mjs`), which is why `build.mjs` now *bundles* the overlay
  instead of copying it. Outermost wins; a *container* that encloses the
  marquee is looked through (a drag inside a section must not select the
  section), a leaf that encloses it is selected (nothing to look through to),
  and an element the marquee misses is still descended into (overflowing
  children, `display: contents`). The overlay is still one script that must
  not throw while evaluating — the import only moved where one function lives.
- **A multi-selection is `multi`, and `selected` is null while it is not
  empty** (`lib/store.ts`; the overlay mirrors it as `multiEls` / `selectedEl`).
  That invariant is the safety: class edits, text, resize grips, the paste
  anchor and chat context all read `selected`, so none of them can quietly act
  on one element of several. Anything that sets `selected: null` must also set
  `multi: []`. What *is* offered for several — ⌫, ⌘C, ⌘X — goes through the
  same `captureClip` / `stageRemoval` / `stagePaste` as one element, shares a
  `gesture` id (one undo), is all-or-nothing (one element the write-back won't
  remove refuses the gesture; a `stage` refusal part-way puts the program
  back), and acts on `outermostOnly` — a shift-click can select a parent and
  its child, and deleting both is a program the write-back refuses. A
  selection is unique by dedup id and never spans artboards; the frame that
  reports one is the only one that keeps it.
- **Clicks inside an artboard never reach the canvas root** — they happen in
  another document and arrive as overlay messages instead. So the canvas root's
  own click handler only ever sees empty canvas or its floating chrome, which
  is what makes click-to-deselect a two-part rule: the target must be the
  container or the pannable surface (`data-canvas-surface`), and *both ends* of
  the click must be there, or a pan finishing over the background reads as a
  click on it.
- **Artboards sit where the user puts them** — dragged by their name label,
  Figma's gesture (the page under the label stays the page; dragging there
  edits it). `artboardLayout` (store) over `layoutArtboards` (canvasMemory) is
  the *only* answer to "where is this page on the canvas": stored positions,
  per viewport id (a layout of 390px boards overlaps at 1440), and anything
  unstored joins to the right of the rightmost — which with nothing stored is
  the old row. The canvas, the markup layer (marks are artboard-local, so they
  follow), focus-a-route and the pinch-zoom anchor all read it; never
  recompute `index × step`. The first move stores the *whole* current layout,
  not one board, or every unstored board would jump with it.
- **An element can leave its artboard, and "outside" has to mean something in
  source.** A codebase has no off-frame layer, so dropping on the empty canvas
  *parks* the element: a staged removal from its page plus a `ParkedPiece`
  (`lib/parking.ts`) holding the clip a paste writes and a picture for the
  card. Dropping into another artboard is a cut + paste; dragging a card into
  one is a paste. All three go through `captureClip` / `stagePaste` /
  `stageRemoval` — the same rules as ⌘X/⌘V (language, missing names, anchors on
  their way out) — never a second implementation. The lifecycle rides the
  staged program: `reconcileParked` runs on every program change (undo the
  removal → piece gone, it's back in its page; undo a placement → card back),
  and `saveAll` must apply `settleParked` **in the same `set` that empties the
  program** — after it, reconcile sees no removals and drops the pieces, which
  by then are the only copy. Saved pieces live in the app *data* dir
  (`parking.rs`), not `node_modules/.dedup` (a reinstall wipes it) and not a
  cache; nothing is written until the project's pieces have been read back, or
  an early save would overwrite them with `[]`.
- **The overlay hears a drag past its own edge only because it captures the
  pointer** (`setPointerCapture` on activation). Out there it reports
  `drag-outside`/`drop-outside` in its own CSS px and draws nothing; the
  editor converts with the frame's measured box (`frameToScreen`, zoom
  measured, not assumed). Another page is *probed* (`probe-drop` → that
  overlay's own `dropTargetAt` → `probe-result`), so a drop from outside lands
  exactly where an in-page drag would. A release outside is never also a
  `drop` — `test:overlay` pins it.
- **One gesture, one undo.** Structural actions may carry a `gesture` id;
  `lib/undo.ts` takes a run sharing one as a single step. A cross-artboard move
  is a paste *and* a removal — undoing half leaves the element in both pages
  or neither. Anything new that stages several actions for one gesture should
  share an id the same way.
- **Canvas markup is dedup's ink on the user's page, and it lives above the
  frames, never inside one.** `AnnotationLayer` is one layer over the
  artboards: inert (`pointer-events: none`) in every tool but `annotate`, and
  while armed it covers the frames completely — which is why entering the tool
  clears the selection, since grips drawn on an element no gesture can reach
  are a lie about what is interactive. Two rules in `lib/annotate.ts` are the
  ones that only show up on screen. **Every mark stores its rough.js seed**:
  rough re-randomises per call, so a shape regenerated on a pan or any
  re-render is a different shape, and the sketch visibly crawls. And
  **geometry is generated once at artboard scale**, with the nib held to a
  constant screen width by `vector-effect: non-scaling-stroke` — regenerating
  per zoom step is slower *and* makes the wobble breathe as you pinch. That is
  the opposite of the overlay-chrome rule above, on purpose: a mark belongs to
  the page it was drawn on, so it scales with it. Note chips are the exception
  that proves it (chrome, so screen-positioned at a fixed size). Coordinates
  are **artboard-local** and a mark belongs to a *route*, because pages get
  closed and reordered. Nothing in this path can reach the user's source, and
  the gesture hint says so.
- The chrome floats over a full-bleed canvas. Anything that positions content
  on the canvas (initial pan, focus-a-route) must inset
  by the live panel widths, or it lands under a panel. `.panel` in `styles.css`
  is the single definition of that elevation — new floating surfaces use it
  rather than re-deriving a shadow.

- **A security header can render the whole canvas blank, silently.** dedup
  frames the user's app, so `X-Frame-Options: DENY` (or a CSP with
  `frame-ancestors`) makes the browser refuse the frame — with no console
  error, no failed request and no clue anywhere the user can see. That header
  is boilerplate in production-minded projects, so this is what a *well*
  configured app looks like, not an exotic one. `frameable.mjs` is the single
  rule: both dev pipelines strip it on the way out (the Vite tagger patches
  `setHeader` *and* `writeHead` first in the middleware chain; `withDedup`
  rewrites the project's declared `headers()`), only in the dev server dedup
  starts, and only the framing directive — a CSP keeps everything else,
  because the rest changes how the app behaves and the canvas exists to show
  the app as it really is. Each pipeline announces the relaxation on the
  dev-server stream, which the console drawer shows: a silent fix for a silent
  failure is still silent. Known gap: a header set by a Next `middleware.ts`
  is out of a config wrapper's reach.

- **The menu bar is Tauri's default menu with one item added, never a
  hand-built one.** On macOS ⌘C/⌘V/⌘Z/⌘A in a text field *are* Edit-menu
  items — a web view does not do them on its own — so a menu written from
  scratch that forgot one breaks copy and paste in every input. `appmenu.rs`
  inserts **Settings… ⌘,** after About and emits `open-settings`; the Settings
  page (`components/Settings.tsx`) mounts at the app root, over the launch
  screen as well as the editor. AI backends live there and only there — the
  top bar has no AI control (the chat links to Settings when nothing is on).
  Being a native
  accelerator, ⌘, works even with focus inside a canvas iframe.
- **An artboard export is a render, not a crop.** `thumbs::snapshot_png`
  rasterises a region of the app window — right for before/after diffs,
  wrong for a deliverable (canvas zoom, the window edge, a floating panel over
  the artboard all end up in it). `export.rs` loads the artboard's URL into a
  throwaway `WKWebView` the artboard's exact size, in a borderless window at
  alpha 0 placed 40,000pt off-screen — it must be *on* the window list
  (`orderFrontRegardless`), because WebKit does not paint a view that is
  ordered out, and borderless, because a titled window is clamped to the
  screen and pages are taller than screens. It shares the canvas's
  `WKWebsiteDataStore` (one session) and loads the page **inside an iframe**,
  because the boot script — seed, offline, hold — only runs framed. URL and
  size come from `artboardUrl` / `artboardHeight`, the same helpers the canvas
  uses, so an export cannot show a different session or height than the
  artboard. `takeSnapshot`'s width is in *points* and returns at the screen's
  backing scale (`snapshot_width_pt`). Staged edits are not in an export —
  the overlay previews them, the files don't have them — and the notice says so.
- **A terminal is the user's, and only the user's.** Each console-drawer
  shell lives exactly as long as its `TerminalPane` — mount opens the PTY,
  unmount hangs it up — so panes stay mounted (hidden) while the drawer is
  folded, and nothing may key a pane on anything but the tab. Nothing in dedup
  writes to one: the chat agent having no tools is the design, and a shell is
  the least audited path to the source there is. PTY output is raw bytes all
  the way to xterm; decoding it anywhere earlier splits characters that
  straddle two reads.
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
  **The one exception is a project with no git at all**, by the owner's
  decision (2026-10-24): saving there writes the files in place, but only
  after `DirectWritePrompt` has said so in as many words — which files, and
  that there is no branch or commit to undo it — once per session, with "Set
  up git" offered beside "Replace files". Every save path goes through
  `needsDirectWriteWarning` + `commitOrDirect`; a new save path must too.
- User's source/config are never mutated for tooling — everything injected
  lives in `sidecar::support_dir` (see the gotcha) or is served virtually.
  Scaffolding a starter into an **empty** folder is not an exception to that
  rule but its opposite: the user asked for those files by name and they are
  the project from the moment they land, not tooling smuggled into one. It
  refuses any folder that isn't empty, and the starter is the repo's initial
  commit so every dedup edit afterwards has a clean baseline behind it.
- Honesty over magic: what can't be edited safely is read-only with a reason.
- Commit style: imperative subject, body explains the *why* and mechanism;
  update `PROGRESS.md` at phase completion and for significant decisions.
- Every phase lands with tests (Rust + plugin smoke); test the built
  artifacts, not just sources.
