//! The Mac menu bar. Each custom item sends its id to the window as a "menu" event,
//! and the window runs the matching command. Shortcuts live here so the Mac routes
//! them reliably (a shortcut with no menu item can be claimed by the system first).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub enum Item {
    /// id, label, shortcut
    Custom(&'static str, &'static str, Option<&'static str>),
    Sep,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Minimize,
    Zoom,
    Fullscreen,
    CloseWindow,
}
use Item::*;

pub const MENUS: &[(&str, &[Item])] = &[
    ("Writing Studio", &[
        About, Sep,
        Custom("settings", "Look & Settings…", Some("CmdOrCtrl+,")),
        Custom("updates", "Check for Updates…", None),
        Sep, Services, Sep, Hide, HideOthers, ShowAll, Sep, Quit,
    ]),
    ("File", &[
        Custom("new-section", "New Section", Some("CmdOrCtrl+N")),
        Custom("new-chapter", "New Chapter", Some("CmdOrCtrl+Shift+N")),
        Custom("new-note", "New Reference Note", None),
        Custom("new-book", "New Book…", None),
        Sep,
        Custom("quick-open", "Quick Open…", Some("CmdOrCtrl+O")),
        Sep,
        Custom("export-word", "Export Book to Word…", None),
        Custom("export-pdf", "Export Book to PDF…", Some("CmdOrCtrl+P")),
        Custom("export-md", "Export Book to Markdown…", None),
        Sep,
        Custom("save", "Save Now", Some("CmdOrCtrl+S")),
        CloseWindow,
    ]),
    ("Edit", &[
        Undo, Redo, Sep, Cut, Copy, Paste, SelectAll, Sep,
        Custom("find", "Find…", Some("CmdOrCtrl+F")),
        Custom("find-book", "Find in Book…", Some("CmdOrCtrl+Shift+F")),
        Sep,
        Custom("ask-claude", "Ask Claude…", Some("CmdOrCtrl+J")),
        Sep,
        Custom("smart-typing", "Smart Quotes and Dashes", None),
    ]),
    ("Format", &[
        Custom("bold", "Bold", Some("CmdOrCtrl+B")),
        Custom("italic", "Italic", Some("CmdOrCtrl+I")),
        Custom("strike", "Strikethrough", Some("CmdOrCtrl+Shift+X")),
        Custom("link", "Link…", Some("CmdOrCtrl+K")),
        Sep,
        Custom("h1", "Heading 1", Some("CmdOrCtrl+Alt+1")),
        Custom("h2", "Heading 2", Some("CmdOrCtrl+Alt+2")),
        Custom("h3", "Heading 3", Some("CmdOrCtrl+Alt+3")),
        Custom("body", "Body Text", Some("CmdOrCtrl+Alt+0")),
        Sep,
        Custom("bullets", "Bulleted List", Some("CmdOrCtrl+Shift+8")),
        Custom("numbers", "Numbered List", Some("CmdOrCtrl+Shift+7")),
        Custom("checklist", "Checklist", Some("CmdOrCtrl+Shift+L")),
        Custom("quote", "Quote", Some("CmdOrCtrl+Shift+'")),
        Sep,
        Custom("note", "Note to Self", Some("CmdOrCtrl+Shift+K")),
        Sep,
        Custom("clear", "Clear Formatting", Some("CmdOrCtrl+\\")),
    ]),
    ("View", &[
        Custom("focus", "Focus Mode", Some("CmdOrCtrl+.")),
        Custom("typewriter", "Typewriter Scrolling", None),
        Sep,
        Custom("sidebar", "Show or Hide Sidebar", Some("CmdOrCtrl+1")),
        Custom("panel", "Show or Hide Reference Panel", Some("CmdOrCtrl+2")),
        Sep,
        Custom("goals", "Writing Goals…", None),
        Sep,
        Fullscreen,
    ]),
    ("Window", &[Minimize, Zoom]),
    ("Help", &[Custom("shortcuts", "Formatting and Shortcuts", Some("CmdOrCtrl+/"))]),
];

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for (title, items) in MENUS {
        let sub = Submenu::new(app, *title, true)?;
        for it in items.iter() {
            match it {
                Custom(id, label, accel) => sub.append(&MenuItem::with_id(app, *id, *label, true, *accel)?)?,
                Sep => sub.append(&PredefinedMenuItem::separator(app)?)?,
                Undo => sub.append(&PredefinedMenuItem::undo(app, None)?)?,
                Redo => sub.append(&PredefinedMenuItem::redo(app, None)?)?,
                Cut => sub.append(&PredefinedMenuItem::cut(app, None)?)?,
                Copy => sub.append(&PredefinedMenuItem::copy(app, None)?)?,
                Paste => sub.append(&PredefinedMenuItem::paste(app, None)?)?,
                SelectAll => sub.append(&PredefinedMenuItem::select_all(app, None)?)?,
                About => sub.append(&PredefinedMenuItem::about(app, Some("About Writing Studio"), None)?)?,
                Services => sub.append(&PredefinedMenuItem::services(app, None)?)?,
                Hide => sub.append(&PredefinedMenuItem::hide(app, None)?)?,
                HideOthers => sub.append(&PredefinedMenuItem::hide_others(app, None)?)?,
                ShowAll => sub.append(&PredefinedMenuItem::show_all(app, None)?)?,
                Quit => sub.append(&PredefinedMenuItem::quit(app, None)?)?,
                Minimize => sub.append(&PredefinedMenuItem::minimize(app, None)?)?,
                Zoom => sub.append(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)?,
                Fullscreen => sub.append(&PredefinedMenuItem::fullscreen(app, None)?)?,
                CloseWindow => sub.append(&PredefinedMenuItem::close_window(app, None)?)?,
            }
        }
        menu.append(&sub)?;
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::str::FromStr;

    #[test]
    fn every_shortcut_parses_and_none_repeat() {
        let mut seen = HashSet::new();
        let mut ids = HashSet::new();
        for (_, items) in MENUS {
            for it in items.iter() {
                if let Custom(id, _, accel) = it {
                    assert!(ids.insert(*id), "duplicate id {id}");
                    if let Some(a) = accel {
                        muda::accelerator::Accelerator::from_str(a).unwrap_or_else(|e| panic!("{a}: {e}"));
                        assert!(seen.insert(*a), "duplicate shortcut {a}");
                    }
                }
            }
        }
    }
}
