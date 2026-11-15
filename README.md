# dedup

**Edit your real React + Tailwind app like a Figma file, and get real code back.**

dedup is a macOS desktop app. Point it at a project folder and it starts your
dev server, renders every page side by side on an infinite canvas, and lets you
click any element to restyle it, retype its text, move it, copy it or delete
it. Every change is written back into your source files as a small, readable
diff, on its own git branch, and only after the edited file has been
re-parsed and checked.

Your code never leaves your machine. No account or cloud service is involved,
and the AI features use the coding-agent CLIs you already pay for.

> **Status:** early (v0.1), macOS only, no prebuilt download yet. You build it
> from source, which takes about five minutes the first time.

---

## What you can do with it

- **See every page at once.** Each route of your app is a live artboard on the
  canvas, at phone, tablet or desktop width. Drag artboards around like Figma
  frames.
- **Click to inspect.** Select any element to see the component and source line
  that rendered it, its Tailwind classes, and a layer tree.
- **Style without hunting for classes.** Change spacing, size, colour, type,
  borders, radius and layout from a style panel. dedup edits the `className`
  in your file, not an inline style.
- **Edit text in place.** Double-click any text and type.
- **Move things around.** Drag an element to re-parent it, or drag it into
  another page. Drop it on the empty canvas to "park" it for later.
  Copy, cut, paste and delete work too, on one element or a marquee selection.
- **Insert elements.** Frames, text, buttons and images from the toolbar.
- **Ask an AI to make the change.** Describe what you want in the chat. The
  proposal is applied to your files *uncommitted*, so you see it live on the
  canvas before you keep it or throw it away.
- **Mark it up.** Sketch boxes, circles, arrows and freehand notes on top of
  any page. These marks are never written to your code.
- **Preview hard-to-reach states:** signed in vs. signed out, offline, or
  frozen on a splash screen.
- **Export** any artboard as a PNG or vector PDF at its real size.
- **Review and ship.** The Commit tab lists every change, lets you undo one,
  and can push the session branch or fast-forward your own branch onto it.
- **Built-in terminals** for the project, in the console drawer.

## What works with what

dedup opens almost any web project. How much you can *edit* depends on whether
dedup can tag elements in your build:

| Project | Preview on canvas | Click-to-edit + style panel | AI chat edits |
|---|:-:|:-:|:-:|
| **Vite + React + Tailwind** | ✅ | ✅ | ✅ |
| **Next.js + Tailwind** (webpack) | ✅ | ✅ ¹ | ✅ |
| **Plain HTML/CSS sites** | ✅ | ✅ | ✅ |
| Astro, Remix, Nuxt, SvelteKit, Vue, Angular, CRA, Gatsby… | ✅ | — | JS/TS/CSS/HTML files only |
| Django, Rails, Laravel, Flask, FastAPI, Hugo, Jekyll… | ✅ | — | JS/TS/CSS/HTML files only |
| Expo / React Native (web build), Flutter web | ✅ | — | Expo only |
| Empty folder | Start from a React or HTML starter | ✅ | ✅ |

¹ Next.js needs one line added to `next.config`. dedup offers that line as a
diff you approve, commits it on its own branch, and the line does nothing
outside dedup.

Styling knobs assume Tailwind. Projects using other CSS can still be
previewed, have their text edited, and be changed through the chat.

---

## Install

### Requirements

- **macOS** (Apple silicon or Intel)
- **Xcode Command Line Tools:** `xcode-select --install`
- **Node.js 20+** and **pnpm** (`npm install -g pnpm`)
- **Rust** (stable), installed with [rustup](https://rustup.rs)
- **git**, recommended. dedup works without it, but then it can't undo your
  saves for you.

### Build the app

```bash
git clone https://github.com/sadafsajju/dedup.git
```

```bash
cd dedup && pnpm install
```

```bash
pnpm tauri build
```

This produces `src-tauri/target/release/bundle/macos/dedup.app`, plus a `.dmg`
next to it in `bundle/dmg/`. Drag `dedup.app` into `/Applications`.

To run it without building a release (with hot reload, for hacking on dedup
itself):

```bash
pnpm tauri dev
```

---

## Quick start

1. **Open a project.** Launch dedup and choose a folder, or drag one onto the
   window. Recent projects are listed on the launch screen. An empty folder
   offers a React or HTML starter.
2. **Let it start.** dedup finds your `dev` script (or the right command for
   your stack) and starts the dev server. Its output is in the console drawer
   at the bottom. If it can't work out how to start your project, it asks for
   the command once and remembers it.
3. **Pick pages.** The **Pages** tab lists your routes. Open the ones you want
   as artboards.
4. **Select and edit.** Click an element (tool **V**) and change it in the
   style panel on the right, or double-click text to retype it. Edits preview
   instantly but stay *staged* until you save.
5. **Save.** Press **⌘S**. dedup writes the files and commits them to a
   `dedup/session-…` branch, never to the branch you were on.
6. **Review and ship.** The **Commit** tab shows what changed. From there you
   can undo any save, push the session branch, or fast-forward your own branch
   onto it when you're happy.

### Tools and shortcuts

| Key | Does |
|---|---|
| **V** | Select: click to inspect, drag to marquee-select, drag a selected element to move it |
| **T** | Text: click text to type into it (or double-click with any tool) |
| **H** / hold **Space** | Hand: pan the canvas |
| **B** | Browse: clicks go to your app, so you can log in or navigate |
| **A** | Annotate: draw on top of the page |
| **⌘1 / ⌘2 / ⌘3** | Phone / tablet / desktop width |
| **⌘C / ⌘X / ⌘V** | Copy / cut / paste the selected element(s) |
| **⌫** | Delete the selection |
| **⌘Z / ⇧⌘Z** | Undo / redo staged edits |
| **⌘S** | Save staged edits |
| **Esc** | Deselect |
| **⌘,** | Settings |

### Pages behind a login

Switch to **Browse (B)** and sign in to your app on the canvas the way you
normally would. All artboards share that session. Each artboard can also be
pinned to *signed out*. For apps that keep their session in browser storage,
dedup can seed a mock session instead (it tells you up front when your auth
provider rules that out).

---

## AI chat

Open **Settings (⌘,)** and connect at least one backend:

| Backend | What you need |
|---|---|
| **Claude Code** | The [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code), installed and signed in (uses your subscription) |
| **Codex** | The [`codex` CLI](https://github.com/openai/codex), installed and signed in. Codex can also generate images for your page |
| **Anthropic API key** | A key from [console.anthropic.com](https://console.anthropic.com), used directly and billed per token |

**Connect** runs a real round-trip, so a CLI that's installed but signed out
shows up as signed out. With both agents on, start a message with `@claude` or
`@codex` to pick which one answers it.

Select an element first to give the AI context, or don't: the chat works with
nothing selected, which is handy when a build error has left the canvas blank.

**The AI never touches your files directly.** It's run with no tools and no
write access. It asks dedup to read files, and replies with exact search/replace
edits that go through the same checks as your own edits. A proposal is shown
live, uncommitted; **Keep** commits it, **Discard** restores every file
byte-for-byte.

---

## How dedup keeps your code safe

One corrupted codebase would kill trust in a tool like this, so the rules are
strict:

- **Edits go to a session branch.** Every save is a commit on
  `dedup/session-…` containing only the files dedup changed. Your own
  uncommitted or staged work is left alone.
- **Nothing is written unless it still parses.** Each edited file is re-parsed
  (JSX/TSX, CSS, and a structural check for HTML) before it touches disk, and
  a multi-file change applies completely or not at all.
- **Nothing is injected into your repo.** dedup's tooling lives in
  `node_modules/.dedup/` (or the app's cache folder for non-Node projects) and
  only runs inside dedup's own dev server. Your `npm run dev`, CI and
  production builds are unaffected.
- **Pushing is explicit.** Push and land happen only when you confirm them in
  the Commit tab, by branch name. Push never forces. Land is fast-forward only,
  and refuses rather than merge.
- **No git? You're told first.** In a folder without git, dedup offers to set
  it up, or names the files it will overwrite in place before it does.

## Known limitations

- macOS only. The canvas and export rely on WebKit APIs.
- Click-to-edit needs Vite + React, Next.js (webpack), or plain HTML. Other
  stacks are preview + chat.
- Next.js under Turbopack isn't tagged, so dedup runs `next dev --webpack`
  for you. Headers set in a Next `middleware.ts` can still block the canvas.
- Staged (unsaved) edits aren't included in exports. Save first.
- Native iOS and Android screens can't be shown. Only web builds can.

---

## Contributing

Issues and pull requests are welcome. Before a non-trivial change:

- Read **[CLAUDE.md](./CLAUDE.md)**. It's the architecture map and the list of
  hard-won gotchas, and it's written for humans as much as for agents.
- **[PROGRESS.md](./PROGRESS.md)** records why things are the way they are.
  Please don't re-open a settled decision without a new reason.
- The safety rules above are non-negotiable. A change that writes to user
  files needs a test proving it refuses the bad case.

```bash
pnpm build             # typecheck + build the frontend
pnpm build:plugin      # rebuild plugin-src/ bundles (required after editing plugin-src/)
pnpm test:plugin       # write-back + tagger smoke tests (run after build:plugin)
cd src-tauri && cargo test
```

Each area has its own suite (`pnpm test:overlay`, `test:html`, `test:chat`, …).
The full list is in `package.json` and in CLAUDE.md.

**Layout:** `src/` is the editor UI (React 19, Tailwind v4, zustand),
`src-tauri/src/` is the Rust core (dev server, git, proxy, export), and
`plugin-src/` is the code that runs *inside* your project's dev server
(element tagging, the in-page overlay, AST write-back).

## License

[MIT](./LICENSE) © 2026 Sadaf Kasim (GetBega Tech)
