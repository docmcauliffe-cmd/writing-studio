mod export;
mod images;
mod library;
mod menu;

use library::*;
use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

#[derive(Default)]
struct WatchState(Mutex<Option<notify::RecommendedWatcher>>);

fn root(p: &str) -> PathBuf {
    PathBuf::from(p)
}

fn local_backups() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("Writing Studio").join("Backups"))
}

#[tauri::command]
fn device_name() -> String {
    // The name shown in System Settings > General > Sharing, e.g. "Nick's iMac".
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    hostname::get()
        .map(|h| h.to_string_lossy().trim_end_matches(".local").to_string())
        .unwrap_or_else(|_| "This Mac".into())
}

#[tauri::command]
fn local_backup_folder() -> String {
    local_backups().map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
fn library_list(root_dir: String) -> Res<Library> {
    list_library(&root(&root_dir))
}

#[tauri::command]
fn section_read(root_dir: String, rel: String) -> Res<Loaded> {
    read_section(&root(&root_dir), &rel)
}

#[tauri::command]
fn section_save(root_dir: String, rel: String, text: String, base_hash: Option<String>) -> Res<Saved> {
    save_section(&root(&root_dir), &rel, &text, base_hash.as_deref())
}

#[tauri::command]
fn book_create(root_dir: String, title: String) -> Res<String> {
    create_book(&root(&root_dir), &title)
}

#[tauri::command]
fn chapter_create(root_dir: String, book: String, title: String, after: Option<String>) -> Res<String> {
    create_chapter(&root(&root_dir), &book, &title, after.as_deref())
}

#[tauri::command]
fn section_create(root_dir: String, chapter: String, title: String, after: Option<String>) -> Res<String> {
    create_section(&root(&root_dir), &chapter, &title, after.as_deref())
}

#[tauri::command]
fn order_set(root_dir: String, dir: String, names: Vec<String>) -> Res<()> {
    set_order(&root(&root_dir), &dir, names)
}

#[tauri::command]
fn item_rename(root_dir: String, rel: String, title: String) -> Res<String> {
    rename_item(&root(&root_dir), &rel, &title)
}

#[tauri::command]
fn item_move(root_dir: String, from: String, to_dir: String, index: usize) -> Res<String> {
    move_item(&root(&root_dir), &from, &to_dir, index)
}

#[tauri::command]
fn item_trash(root_dir: String, rel: String) -> Res<String> {
    trash_item(&root(&root_dir), &rel)
}

#[tauri::command]
fn book_meta_set(root_dir: String, book: String, title: Option<String>, goal: Option<usize>, clear_goal: Option<bool>) -> Res<()> {
    let g = if clear_goal.unwrap_or(false) { Some(None) } else { goal.map(Some) };
    set_book_meta(&root(&root_dir), &book, title.as_deref(), g)
}

#[tauri::command]
fn inbox_file(root_dir: String, file: String, chapter: String) -> Res<String> {
    file_inbox_note(&root(&root_dir), &file, &chapter)
}

#[tauri::command]
fn book_export(root_dir: String, book: String) -> Res<String> {
    export_book(&root(&root_dir), &book)
}

#[tauri::command]
async fn image_save(root_dir: String, section: String, name: String, data: String) -> Res<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|_| "The picture could not be read.".to_string())?;
    images::save_image(&root(&root_dir), &section, &name, &bytes)
}

#[tauri::command]
async fn image_read(root_dir: String, section: String, src: String) -> Res<String> {
    images::read_image(&root(&root_dir), &section, &src)
}

#[tauri::command]
fn book_export_docx(root_dir: String, book: String, path: String) -> Res<()> {
    export::export_docx(&root(&root_dir), &book, Path::new(&path))
}

#[tauri::command]
async fn book_export_pdf(root_dir: String, book: String, path: String) -> Res<()> {
    export::export_pdf(&root(&root_dir), &book, Path::new(&path))
}

#[tauri::command]
fn export_write(path: String, text: String) -> Res<()> {
    atomic_write(Path::new(&path), text.as_bytes())
}

#[tauri::command]
fn settings_read(root_dir: String) -> String {
    read_settings(&root(&root_dir))
}

#[tauri::command]
fn settings_write(root_dir: String, json: String) -> Res<()> {
    write_settings(&root(&root_dir), &json)
}

#[tauri::command]
fn activity_write(root_dir: String, activity: Activity) -> Res<()> {
    write_activity(&root(&root_dir), &activity)
}

#[tauri::command]
fn progress_read(root_dir: String) -> std::collections::HashMap<String, std::collections::HashMap<String, i64>> {
    read_progress(&root(&root_dir))
}

#[tauri::command]
fn progress_write(root_dir: String, device: String, days: std::collections::HashMap<String, i64>) -> Res<()> {
    write_progress(&root(&root_dir), &device, &days)
}

#[tauri::command]
fn activity_read(root_dir: String) -> Vec<Activity> {
    read_activity(&root(&root_dir))
}

#[tauri::command]
fn snapshot_take(root_dir: String, book: String, device: String) -> Res<String> {
    snapshot_book(&root(&root_dir), &book, &device, local_backups().as_deref())
}

#[tauri::command]
fn snapshot_list(root_dir: String, book: String) -> Vec<Snapshot> {
    list_snapshots(&root(&root_dir), &book)
}

#[tauri::command]
fn snapshot_restore(root_dir: String, book: String, file: String) -> Res<String> {
    restore_snapshot(&root(&root_dir), &book, &file)
}

#[tauri::command]
fn folder_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Ask Claude: optionally put the request on the clipboard, then open Claude (the desktop
/// app for claude:// links, the browser for https). Only Claude's own addresses are allowed.
/// Errors if nothing could open the link, so the window can fall back to the browser.
#[tauri::command]
fn claude_open(url: String, copy: Option<String>) -> Res<()> {
    if !(url.starts_with("claude://claude.ai/") || url.starts_with("https://claude.ai/")) {
        return Err("Only Claude links can be opened here.".into());
    }
    if let Some(text) = copy {
        copy_text(&text)?;
    }
    #[cfg(target_os = "macos")]
    {
        let ok = std::process::Command::new("/usr/bin/open").arg(&url).output().map(|o| o.status.success()).unwrap_or(false);
        if ok { Ok(()) } else { Err("Could not open Claude.".into()) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("Opening Claude works on the Mac only.".into())
    }
}

fn copy_text(text: &str) -> Res<()> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let mut child = std::process::Command::new("/usr/bin/pbcopy")
            .env("LANG", "en_US.UTF-8")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not copy: {e}"))?;
        child.stdin.take().ok_or("Could not copy")?.write_all(text.as_bytes()).map_err(|e| format!("Could not copy: {e}"))?;
        child.wait().map_err(|e| format!("Could not copy: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("Copying works on the Mac only.".into())
    }
}

/// Watch the library folder and tell the window which files changed
/// (edits from the other Mac arriving through Google Drive, or Finder changes).
#[tauri::command]
fn watch_start(app: tauri::AppHandle, state: State<WatchState>, root_dir: String) -> Res<()> {
    let base = root(&root_dir);
    let base2 = base.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let paths: Vec<String> = ev
                .paths
                .iter()
                .filter_map(|p| p.strip_prefix(&base2).ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .filter(|p| !p.split('/').any(|seg| seg.starts_with('.')))
                .collect();
            if !paths.is_empty() {
                let _ = app.emit("library-changed", paths);
            }
        }
    })
    .map_err(|e| format!("Could not watch the folder: {e}"))?;
    watcher.watch(&base, RecursiveMode::Recursive).map_err(|e| format!("Could not watch the folder: {e}"))?;
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![
            device_name,
            local_backup_folder,
            library_list,
            section_read,
            section_save,
            book_create,
            chapter_create,
            section_create,
            order_set,
            item_rename,
            item_move,
            item_trash,
            book_meta_set,
            inbox_file,
            book_export,
            book_export_docx,
            book_export_pdf,
            image_save,
            image_read,
            export_write,
            settings_read,
            settings_write,
            activity_write,
            activity_read,
            progress_read,
            progress_write,
            snapshot_take,
            snapshot_list,
            snapshot_restore,
            folder_exists,
            claude_open,
            watch_start,
        ])
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .setup(|app| {
            let m = menu::build(app.handle())?;
            app.set_menu(m)?;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Writing Studio");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Writing Studio");
}
