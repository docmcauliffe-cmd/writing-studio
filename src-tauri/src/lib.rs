mod library;

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
            export_write,
            settings_read,
            settings_write,
            activity_write,
            activity_read,
            snapshot_take,
            snapshot_list,
            snapshot_restore,
            folder_exists,
            watch_start,
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Writing Studio");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Writing Studio");
}
