# dedup

A macOS desktop app (Tauri 2 + React + Tailwind) that opens an existing
React&nbsp;+&nbsp;Tailwind codebase, renders the running app on a canvas with
Figma-style inspection, and — its core differentiator — detects near-duplicate
components and safely merges them behind deterministic gates.

See [`dedup-mvp-prd.md`](./dedup-mvp-prd.md) for the full product spec.

## Status

**Phases 0–3 complete** — project open, dev-server management, element↔source
tagging, Figma-style Tailwind inspector with live preview, AST write-back on a
git session branch, and the duplicate scan: component inventory, deterministic
structural similarity, cluster review UI. Next: Phase 4 (guarded merge).

Full per-phase log against the PRD's requirements — including decisions,
deviations, and known limitations — lives in **[PROGRESS.md](./PROGRESS.md)**.

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
