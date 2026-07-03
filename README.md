# dedup

A macOS desktop app (Tauri 2 + React + Tailwind) that opens an existing
React&nbsp;+&nbsp;Tailwind codebase, renders the running app on a canvas with
Figma-style inspection, and — its core differentiator — detects near-duplicate
components and safely merges them behind deterministic gates.

See [`dedup-mvp-prd.md`](./dedup-mvp-prd.md) for the full product spec.

## Status

**Phase 0 — spike (complete).** Tauri shell, project open + compatibility
detection, managed dev-server child process, and the webview canvas.

Implemented so far:

- **Launch screen** — native folder picker + drag-onto-window, recent projects,
  and a compatibility card (package manager / Vite·Next / Tailwind / TS / git)
  with a dirty-working-tree acknowledgement (FR-1.1, FR-1.2, FR-1.5).
- **Dev-server manager** — spawns `<pm> run dev` (or a custom command) in its own
  process group, streams stdout/stderr to a collapsible console, detects the
  ready URL/port, and handles crash/stop without orphaning the server
  (FR-1.3, FR-1.6).
- **Canvas** — embeds the running app in an iframe with mobile/tablet/desktop
  viewport presets and ⌘-scroll zoom (FR-1.4).
- **App shell** — three-zone layout (sidebar / canvas / inspector) with the
  top bar, dark-mode-first (FR-6.1, FR-6.5). Sidebar tabs and inspector controls
  are stubbed for Phases 1–3.

Next: Phase 1 — build-time element↔source tagging + hover/select overlay.

## Develop

```sh
pnpm install
pnpm tauri dev      # run the desktop app
pnpm build          # typecheck + build the frontend
cargo test          # run Rust unit tests (from src-tauri/)
```

Requires Node, Rust, Xcode Command Line Tools, and a package manager
(pnpm recommended).

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
