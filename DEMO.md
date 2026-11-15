# Historical demo — dedup — demo runbook

> Retired on 2026-11-10: this script demonstrates deduplication features that
> have been removed. For the current product, demonstrate opening a project,
> inspecting and styling an element, reviewing source edits, scanning the
> component gallery, and undoing a save from history.


Demo project: **Harbor**, a seller dashboard at
`../harbor` (sibling of this repo). Vite + React 19 + Tailwind v4 +
react-router, 14 source files, git-initialised with one clean baseline commit.
It typechecks and builds clean — which matters, because the merge gates run
both.

Harbor is a *curated* codebase, not a faked one. The drift in it was written
in deliberately, the way drift actually happens; every number below came out of
the real sidecars on the real files. Nothing in the demo path is stubbed.

---

## Before you walk on

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Kill anything holding **5173/5174**. A tauri-dev hot-restart orphans the
user-project dev server, Harbor then lands on 5175, and the canvas points at
whatever stale app is squatting the port. There were two orphans on this
machine while the demo was being built — assume there will be on the day.

Then: `pnpm tauri dev`, open Harbor once to warm the install, quit, reopen.
The first open is the slow one; never let the audience watch it.

---

## The numbers (verified, quote them exactly)

| | |
|---|---|
| Files scanned | 14 |
| Inline drift scan | **63 ms** |
| Component scan | **84 ms** |
| Drift candidates | **5**, in 5 different component *kinds* |
| Total drifted copies | **34** |
| Elements the fixes remove | **52** |
| Inline markup spent on copies | **7,823 bytes** |

The five candidates:

| what | copies | files | note |
|---|---|---|---|
| primary `<button>` | **15** | 9 | **`Button.tsx` already exists.** Fifteen places ignore it. |
| status badge `<span>` | 7 | 4 | 3 colours → one `tone` prop |
| form field (`label`+`input`) | 5 | 1 | 2 radii, 2 border colours, 2 label margins |
| stat tile (4 elements) | 4 | 1 | `p-4`/`p-5`, `rounded-lg`/`rounded-xl`, `shadow-sm`/`shadow` |
| empty state (4 elements) | 3 | 3 | contains a component child; still detected. `mt-8` on one is flagged **layout** |

Component-level cluster (a separate, older feature): **ProductCard,
OrderCard, CustomerCard** at **0.848** confidence, 3 call sites.

---

## Act 1 — "Here is a normal app" *(30s)*

Open Harbor in dedup. Let the canvas paint the five routes.

> "This is a real React app. Six pages, fourteen files, builds clean, no
> warnings. Nothing is wrong with it. Now watch."

Don't explain the canvas. Let them notice it renders the real thing.

## Act 2 — The drift reveal *(90s — the whole pitch)*

**Sidebar → Drift → "Find drift".** It returns in well under a second on
Harbor. Five candidates, badged on the tab.

Open the first one: **`<button>` ×15 in 9 files**.

The row itself carries the punchline before you say anything —

> **Button already exists — 14 copies ignore it.**

Then expand it and let the *What drifted* table do the work. It shows the
value spread per knob, with counts. These are the real numbers — read them
off the screen, don't memorise them:

```
px                px-3 ×11              px-4 ×4
py                py-1.5 ×6             py-1 ×5        py-2 ×4
text              text-sm ×10           text-xs ×5
font-medium       font-medium ×14       — ×1
hover:bg-color    hover:bg-indigo-500 ×12   — ×3
disabled:opacity  — ×8   disabled:opacity-50 ×6   disabled:opacity-60 ×1
mt*               — ×14                 mt-4 ×1
```

The three strongest things to say, in order:

> "Three of these buttons have **no hover state at all**. Not a different
> one — none. That's not inconsistency, that's a bug, and it shipped."

> "One lost its font weight. Three different paddings. Two text sizes."

> "Nobody decided any of this. It happened one sprint at a time, and no tool
> in your stack was ever going to tell you."

Then point at the `*`:

> "That one's a margin. It's not a variant — it's where somebody *put* the
> button. So it stays at the call site. Getting that distinction wrong is how
> a shared component ends up fighting every page that uses it."

Click a `file:line` row → the code panel opens on the real source. *"Not a
report. The actual line."*

Then scroll the candidate list — badge, form field, stat tile, empty state —
because the first question is always *"so it just finds buttons?"* Answer it
by scrolling, before it's asked.

Slide backup: the ghost overlay (all 15 buttons stacked at 20% opacity — a
blur) is still the strongest single image you have. Use it as the *opener*
before you switch to the app.

## Act 3 — "Why not just ask an AI" *(30s)*

> "We tried. It invented components that didn't exist and missed ones that did.
> So detection here is deterministic — same answer every run, file and line,
> reproducible. The model never decides what's a duplicate."

This is the slide that makes technical judges relax.

## Act 4 — The live loop *(90s — this is all real, in the app)*

**Select the Customers artboard first.** Click its name label above the frame
on the canvas. The scan refuses without a selection ("Select an artboard
first"), because a live canvas scans one page at a time.

It has to be **Customers** specifically. The scan scopes to the files that
rendered on the selected page, and Customers is the only page that renders all
three cards — `ProductCard` is the bridge that links `CustomerCard` and
`OrderCard` into one cluster, and without it in scope there is no cluster at
all. On any other artboard this act finds nothing.

Then Sidebar → **Duplicates** → **Scan now**. Expect:
**ProductCard / OrderCard / CustomerCard, confidence 0.848, 4 call sites.**

1. Show the side-by-side rendered previews. *"Same component, three names."*
2. **Propose merge.** The model writes one canonical component with a `variant`
   prop. Show the proposed source and the rewritten call sites as a diff.
3. **Run the gates.** Typecheck, build, visual regression. Let them watch it
   pass — Harbor typechecks and builds clean, so they will.
4. Show the commit in the history panel. Then **roll it back**.

> "Every merge is one commit on a session branch. If you don't like it, it's
> gone. We never touch your main branch and we never write a file we haven't
> re-parsed first."

The rollback is the trust moment. Don't skip it to save time.

## Act 5 — The vision *(45s)*

Drift in CI → git blame for design → the self-assembling design system.
Land on:

> "Today we find drift. Next we stop it at the pull request. Then design
> systems become something you discover, not something you maintain."

---

## What's real, and what to say if asked

Know this line cold — a judge who finds it themselves is a different day than
one you told.

| | status |
|---|---|
| Inline drift **detection + the Drift tab** | **Real.** Ships, tested, 63 ms on Harbor. |
| Inline drift **auto-fix** | **Not built.** The tab is read-only on purpose. |
| Component duplicate scan | **Real.** |
| AI merge + write-back + gates + rollback | **Real, end to end.** |
| Drift Score / CI / git-blame-for-design | **Vision.** Say so. |

The Drift tab shows evidence and jumps to source; it never offers a fix it
cannot land. If someone asks why there's no Fix button, that *is* the answer,
and it's the same rule the merge gates follow.

If asked *"can it fix the buttons?"*:

> "Not yet — that's what we're raising for. The detection is done and the
> write-back machinery is done; you just watched it merge three components and
> roll back. Wiring the second to the first is the next build."

That answer is strong **because** you just demonstrated both halves working
separately.

## Known limitations (have answers ready)

- **Computed classNames are invisible.** Harbor's Orders filter buttons use a
  `cn()` helper and dedup does not see them. Anything using `clsx`/`cn`
  heavily under-reports. *"We read static classes today; the helper case is on
  the roadmap."*
- **Big components fragment.** Bucketing is on exact structure, so a card with
  one extra child lands in a different bucket. Small rigid things are found
  brilliantly, large variable ones are missed.
- **Structurally identical SVG icons cluster as duplicates** in the component
  scan. Harbor's icons were made distinct so it doesn't show — on a real
  codebase it will. Have "dismiss cluster" ready as the answer.
- **Vite only** for the live canvas signals; Next is partial.

## If something breaks on stage

- Canvas won't paint → check the port (see *Before you walk on*).
- Merge gate fails → that's a **feature**: "the gate caught it and rolled back,
  which is the point." Do not apologise for it.
- AI backend not connected → the Connect round-trip is live; have a second
  backend (Codex) configured as a fallback.
