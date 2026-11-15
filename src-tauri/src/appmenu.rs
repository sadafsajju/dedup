//! The macOS menu bar: Tauri's default menu, plus **Settings… ⌘,** in the app
//! menu where every Mac app keeps it.
//!
//! Built *from* the default rather than from scratch on purpose. The default
//! Edit menu is what gives text fields ⌘C/⌘V/⌘Z/⌘A at all — on macOS those
//! shortcuts are menu items, not something a web view does on its own — so a
//! hand-written menu that forgot one would quietly break copy and paste in
//! every input in the app.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Runtime};

/// The menu item's id, and the event the frontend listens for.
pub const OPEN_SETTINGS: &str = "open-settings";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // The first submenu is the app menu on macOS (About, Services, Hide,
    // Quit). Settings goes right after About, behind a separator — the
    // position the platform's own apps use.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        app_menu.insert(
            &MenuItem::with_id(app, OPEN_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            2,
        )?;
    }
    Ok(menu)
}

/// Menu clicks that dedup handles itself. Everything predefined (copy, quit,
/// hide…) is handled by the platform and never reaches here.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == OPEN_SETTINGS {
        let _ = app.emit(OPEN_SETTINGS, ());
    }
}
