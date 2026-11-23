//! Everything that touches the Writing Studio folder on disk.
//!
//! Layout (all plain files, readable in Finder and on Google Drive):
//!
//! ```text
//! Writing Studio/
//!   <Book>/
//!     _book.txt            Title and goal
//!     _order.txt           Chapter order, one folder name per line
//!     <Chapter>/
//!       _order.txt         Section order, one file name per line
//!       <Section>.md
//!   Writing Studio - App Data/   settings.json, devices/<Mac>.json
//!   Writing Studio - Backups/    <Book>/<YYYY.MM.DD HHMM> - <Mac>.zip
//!   Writing Studio - Inbox/      ideas captured on the iPhone
//!   Writing Studio - Trash/      anything deleted in the app
//! ```
//!
//! Rules this module keeps:
//! - Every save writes a complete temporary copy, flushes it to disk, then swaps it in.
//! - Nothing is ever deleted: "delete" moves to the Trash folder.
//! - Files the order list doesn't mention still appear, at the end.
//! - A save never overwrites a version it hasn't seen (hash check), so two Macs can't
//!   silently clobber each other.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const APP_DATA: &str = "Writing Studio - App Data";
pub const BACKUPS: &str = "Writing Studio - Backups";
pub const TRASH: &str = "Writing Studio - Trash";
pub const INBOX: &str = "Writing Studio - Inbox";
const ORDER: &str = "_order.txt";
const BOOK_META: &str = "_book.txt";
const RESERVED_PREFIX: &str = "Writing Studio - ";

pub type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{context}: {e}")
}

// ---------------------------------------------------------------- data shapes

#[derive(Serialize, Debug, Clone)]
pub struct Section {
    pub file: String,
    pub title: String,
    pub words: usize,
    pub modified: i64,
    /// Looks like a duplicate made by Google Drive, e.g. "Opening (1).md".
    pub conflict: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct Chapter {
    pub name: String,
    pub sections: Vec<Section>,
    pub words: usize,
}

#[derive(Serialize, Debug, Clone)]
pub struct Book {
    pub name: String,
    pub title: String,
    pub goal: Option<usize>,
    pub chapters: Vec<Chapter>,
    pub words: usize,
}

#[derive(Serialize, Debug)]
pub struct Library {
    pub books: Vec<Book>,
    pub inbox: Vec<Section>,
}

#[derive(Serialize, Debug)]
pub struct Loaded {
    pub text: String,
    pub hash: String,
}

#[derive(Serialize, Debug)]
pub struct Saved {
    /// "saved" or "conflict"
    pub status: String,
    pub hash: String,
    /// When status is "conflict": the version currently on disk.
    pub disk_text: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Activity {
    pub device: String,
    pub section: Option<String>,
    pub at: i64,
}

#[derive(Serialize, Debug)]
pub struct Snapshot {
    pub file: String,
    pub when: String,
    pub device: String,
    pub bytes: u64,
}

// ---------------------------------------------------------------- helpers

pub fn hash(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn word_count(text: &str) -> usize {
    text.split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .count()
}

/// Turn a title into a safe file or folder name.
pub fn safe_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut s = cleaned.trim().trim_matches('.').trim().to_string();
    if s.starts_with('_') || s.starts_with(RESERVED_PREFIX) {
        s = s.trim_start_matches('_').replacen(RESERVED_PREFIX, "", 1);
    }
    let s: String = s.chars().take(120).collect();
    if s.trim().is_empty() {
        "Untitled".into()
    } else {
        s.trim().to_string()
    }
}

fn is_reserved(name: &str) -> bool {
    name.starts_with('_') || name.starts_with('.') || name.starts_with(RESERVED_PREFIX)
}

fn looks_like_drive_duplicate(stem: &str) -> bool {
    // "Opening (1)", "Opening (2)" ...
    if let Some(open) = stem.rfind(" (") {
        let rest = &stem[open + 2..];
        return rest.ends_with(')') && rest[..rest.len() - 1].chars().all(|c| c.is_ascii_digit()) && rest.len() > 1;
    }
    false
}

/// Resolve a path relative to the library root, refusing anything that escapes it.
pub fn resolve(root: &Path, rel: &str) -> Res<PathBuf> {
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return Err(format!("Not a path inside the library: {rel}")),
        }
    }
    Ok(root.join(rel_path))
}

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write a whole file safely: temporary copy, flush to disk, then swap it in.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Res<()> {
    let dir = path.parent().ok_or("File has no folder")?;
    fs::create_dir_all(dir).map_err(err("Could not create folder"))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.ws-saving"));
    {
        let mut f = fs::File::create(&tmp).map_err(err("Could not start saving"))?;
        f.write_all(bytes).map_err(err("Could not write"))?;
        f.sync_all().map_err(err("Could not flush to disk"))?;
    }
    fs::rename(&tmp, path).map_err(err("Could not finish saving"))?;
    Ok(())
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

fn write_lines(path: &Path, lines: &[String]) -> Res<()> {
    let mut body = lines.join("\n");
    body.push('\n');
    atomic_write(path, body.as_bytes())
}

/// Order the names found on disk: those in the order file first, the rest after (A–Z).
pub fn apply_order(found: Vec<String>, order: &[String]) -> Vec<String> {
    let mut out: Vec<String> = order.iter().filter(|n| found.contains(n)).cloned().collect();
    out.dedup();
    let mut rest: Vec<String> = found.into_iter().filter(|n| !out.contains(n)).collect();
    rest.sort_by_key(|s| s.to_lowercase());
    out.extend(rest);
    out
}

fn child_dirs(dir: &Path) -> Vec<String> {
    let mut v = vec![];
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() && !is_reserved(&name) {
                v.push(name);
            }
        }
    }
    v
}

fn child_md_files(dir: &Path) -> Vec<String> {
    let mut v = vec![];
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_file() && name.to_lowercase().ends_with(".md") && !name.starts_with('.') {
                v.push(name);
            }
        }
    }
    v
}

fn ordered_dirs(dir: &Path) -> Vec<String> {
    apply_order(child_dirs(dir), &read_lines(&dir.join(ORDER)))
}

fn ordered_files(dir: &Path) -> Vec<String> {
    apply_order(child_md_files(dir), &read_lines(&dir.join(ORDER)))
}

fn section_info(dir: &Path, file: &str) -> Section {
    let path = dir.join(file);
    let text = fs::read_to_string(&path).unwrap_or_default();
    let stem = file.strip_suffix(".md").or_else(|| file.strip_suffix(".MD")).unwrap_or(file);
    Section {
        file: file.to_string(),
        title: stem.to_string(),
        words: word_count(&text),
        modified: modified_ms(&path),
        conflict: looks_like_drive_duplicate(stem),
    }
}

fn read_meta(book_dir: &Path) -> HashMap<String, String> {
    read_lines(&book_dir.join(BOOK_META))
        .into_iter()
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())))
        .collect()
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> (String, PathBuf) {
    let mut n = 1;
    loop {
        let name = if n == 1 { format!("{stem}{ext}") } else { format!("{stem} {n}{ext}") };
        let p = dir.join(&name);
        if !p.exists() {
            return (name, p);
        }
        n += 1;
    }
}

fn insert_after(list: &mut Vec<String>, name: &str, after: Option<&str>) {
    list.retain(|n| n != name);
    match after.and_then(|a| list.iter().position(|n| n == a)) {
        Some(i) => list.insert(i + 1, name.to_string()),
        None => list.push(name.to_string()),
    }
}

fn now_stamp() -> String {
    Local::now().format("%Y.%m.%d %H%M").to_string()
}

// ---------------------------------------------------------------- reading

pub fn list_library(root: &Path) -> Res<Library> {
    if !root.is_dir() {
        return Err(format!("The Writing Studio folder was not found at {}", root.display()));
    }
    let mut books = vec![];
    for name in ordered_dirs(root) {
        let dir = root.join(&name);
        let meta = read_meta(&dir);
        let mut chapters = vec![];
        for ch in ordered_dirs(&dir) {
            let cdir = dir.join(&ch);
            let sections: Vec<Section> = ordered_files(&cdir).iter().map(|f| section_info(&cdir, f)).collect();
            let words = sections.iter().map(|s| s.words).sum();
            chapters.push(Chapter { name: ch, sections, words });
        }
        let words = chapters.iter().map(|c| c.words).sum();
        books.push(Book {
            title: meta.get("title").cloned().unwrap_or_else(|| name.clone()),
            goal: meta.get("goal").and_then(|g| g.replace(',', "").parse().ok()),
            name,
            chapters,
            words,
        });
    }
    let inbox_dir = root.join(INBOX);
    let mut inbox: Vec<Section> = child_md_files(&inbox_dir).iter().map(|f| section_info(&inbox_dir, f)).collect();
    inbox.sort_by_key(|s| s.modified);
    Ok(Library { books, inbox })
}

pub fn read_section(root: &Path, rel: &str) -> Res<Loaded> {
    let text = fs::read_to_string(resolve(root, rel)?).map_err(err("Could not open this section"))?;
    Ok(Loaded { hash: hash(&text), text })
}

// ---------------------------------------------------------------- saving

/// Save a section. `base_hash` is the version the editor started from; if the file on
/// disk has changed since (edited on the other Mac), nothing is written and the caller
/// gets the disk version to compare.
pub fn save_section(root: &Path, rel: &str, text: &str, base_hash: Option<&str>) -> Res<Saved> {
    let path = resolve(root, rel)?;
    if let (Some(base), Ok(disk)) = (base_hash, fs::read_to_string(&path)) {
        let disk_hash = hash(&disk);
        if disk_hash != base && disk_hash != hash(text) {
            return Ok(Saved { status: "conflict".into(), hash: disk_hash, disk_text: Some(disk) });
        }
    }
    atomic_write(&path, text.as_bytes())?;
    Ok(Saved { status: "saved".into(), hash: hash(text), disk_text: None })
}

// ---------------------------------------------------------------- creating

pub fn create_book(root: &Path, title: &str) -> Res<String> {
    let (name, dir) = unique_path(root, &safe_name(title), "");
    fs::create_dir_all(&dir).map_err(err("Could not create the book"))?;
    write_lines(&dir.join(BOOK_META), &[format!("Title: {}", title.trim()), "Goal: ".into()])?;
    let mut order = read_lines(&root.join(ORDER));
    insert_after(&mut order, &name, None);
    write_lines(&root.join(ORDER), &order)?;
    let ch = create_chapter(root, &name, "Chapter One", None)?;
    create_section(root, &format!("{name}/{ch}"), "Opening", None)?;
    Ok(name)
}

pub fn create_chapter(root: &Path, book: &str, title: &str, after: Option<&str>) -> Res<String> {
    let bdir = resolve(root, book)?;
    let (name, dir) = unique_path(&bdir, &safe_name(title), "");
    fs::create_dir_all(&dir).map_err(err("Could not create the chapter"))?;
    let mut order = ordered_dirs(&bdir);
    insert_after(&mut order, &name, after);
    write_lines(&bdir.join(ORDER), &order)?;
    Ok(name)
}

pub fn create_section(root: &Path, chapter: &str, title: &str, after: Option<&str>) -> Res<String> {
    let cdir = resolve(root, chapter)?;
    let (name, path) = unique_path(&cdir, &safe_name(title), ".md");
    atomic_write(&path, b"")?;
    let mut order = ordered_files(&cdir);
    insert_after(&mut order, &name, after);
    write_lines(&cdir.join(ORDER), &order)?;
    Ok(name)
}

// ---------------------------------------------------------------- organizing

pub fn set_order(root: &Path, dir_rel: &str, names: Vec<String>) -> Res<()> {
    let dir = if dir_rel.is_empty() { root.to_path_buf() } else { resolve(root, dir_rel)? };
    // The library and each book order folders; a chapter orders its .md files.
    // Anything on disk the caller didn't mention is kept, so nothing drops out.
    let depth = Path::new(dir_rel).components().count();
    let found = if depth <= 1 { child_dirs(&dir) } else { child_md_files(&dir) };
    let ordered = apply_order(found, &names);
    write_lines(&dir.join(ORDER), &ordered)
}

/// Rename a book, chapter or section. Returns the new relative path.
pub fn rename_item(root: &Path, rel: &str, new_title: &str) -> Res<String> {
    let path = resolve(root, rel)?;
    let parent = path.parent().ok_or("Nothing to rename")?.to_path_buf();
    let old_name = path.file_name().and_then(|n| n.to_str()).ok_or("Nothing to rename")?.to_string();
    let is_file = path.is_file();
    let ext = if is_file { ".md" } else { "" };
    let wanted = format!("{}{ext}", safe_name(new_title));
    if wanted == old_name {
        return Ok(rel.to_string());
    }
    let (new_name, new_path) = if wanted.to_lowercase() == old_name.to_lowercase() {
        (wanted.clone(), parent.join(&wanted)) // case-only change
    } else {
        unique_path(&parent, &safe_name(new_title), ext)
    };
    fs::rename(&path, &new_path).map_err(err("Could not rename"))?;
    let order_path = parent.join(ORDER);
    let order: Vec<String> = read_lines(&order_path)
        .into_iter()
        .map(|n| if n == old_name { new_name.clone() } else { n })
        .collect();
    write_lines(&order_path, &order)?;
    // A book also keeps its title in _book.txt.
    if !is_file && parent == root {
        set_book_meta(root, &new_name, Some(new_title.trim()), None)?;
    }
    let parent_rel = Path::new(rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    Ok(if parent_rel.is_empty() { new_name } else { format!("{parent_rel}/{new_name}") })
}

/// Move a section or chapter into another chapter or book, at a position.
pub fn move_item(root: &Path, from_rel: &str, to_dir_rel: &str, index: usize) -> Res<String> {
    let from = resolve(root, from_rel)?;
    let to_dir = resolve(root, to_dir_rel)?;
    let from_parent = from.parent().ok_or("Nothing to move")?.to_path_buf();
    let name = from.file_name().and_then(|n| n.to_str()).ok_or("Nothing to move")?.to_string();
    let is_file = from.is_file();
    let mut final_name = name.clone();
    if from_parent != to_dir {
        let (stem, ext) = if is_file { (name.trim_end_matches(".md").to_string(), ".md") } else { (name.clone(), "") };
        let (n, dest) = unique_path(&to_dir, &stem, ext);
        fs::rename(&from, &dest).map_err(err("Could not move"))?;
        final_name = n;
        let src_order: Vec<String> = read_lines(&from_parent.join(ORDER)).into_iter().filter(|n| n != &name).collect();
        write_lines(&from_parent.join(ORDER), &src_order)?;
    }
    let mut order = if is_file { ordered_files(&to_dir) } else { ordered_dirs(&to_dir) };
    order.retain(|n| n != &final_name);
    order.insert(index.min(order.len()), final_name.clone());
    write_lines(&to_dir.join(ORDER), &order)?;
    Ok(format!("{}/{final_name}", to_dir_rel.trim_end_matches('/')))
}

/// "Delete": move to the Trash folder with a dated name. Never erases anything.
pub fn trash_item(root: &Path, rel: &str) -> Res<String> {
    let path = resolve(root, rel)?;
    let parent = path.parent().ok_or("Nothing to delete")?.to_path_buf();
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("Nothing to delete")?.to_string();
    let trash = root.join(TRASH);
    fs::create_dir_all(&trash).map_err(err("Could not create the Trash folder"))?;
    let label = rel.replace('/', " - ");
    let (stem, ext) = if path.is_file() { (label.trim_end_matches(".md").to_string(), ".md") } else { (label, "") };
    let (trashed, dest) = unique_path(&trash, &format!("{} - {stem}", now_stamp()), ext);
    fs::rename(&path, &dest).map_err(err("Could not move to Trash"))?;
    let order: Vec<String> = read_lines(&parent.join(ORDER)).into_iter().filter(|n| n != &name).collect();
    if parent.join(ORDER).exists() {
        write_lines(&parent.join(ORDER), &order)?;
    }
    Ok(trashed)
}

pub fn set_book_meta(root: &Path, book: &str, title: Option<&str>, goal: Option<Option<usize>>) -> Res<()> {
    let dir = resolve(root, book)?;
    let meta = read_meta(&dir);
    let t = title.map(|s| s.to_string()).or_else(|| meta.get("title").cloned()).unwrap_or_else(|| book.to_string());
    let g = match goal {
        Some(g) => g.map(|n| n.to_string()).unwrap_or_default(),
        None => meta.get("goal").cloned().unwrap_or_default(),
    };
    write_lines(&dir.join(BOOK_META), &[format!("Title: {t}"), format!("Goal: {g}")])
}

/// Move an Inbox note into a chapter as a new section (at the end).
pub fn file_inbox_note(root: &Path, file: &str, chapter_rel: &str) -> Res<String> {
    let from_rel = format!("{INBOX}/{file}");
    let count = ordered_files(&resolve(root, chapter_rel)?).len();
    move_item(root, &from_rel, chapter_rel, count)
}

/// The whole book as one Markdown document, in order.
pub fn export_book(root: &Path, book: &str) -> Res<String> {
    let lib = list_library(root)?;
    let b = lib.books.iter().find(|b| b.name == book).ok_or("Book not found")?;
    let mut out = format!("# {}\n\n", b.title);
    for ch in &b.chapters {
        out.push_str(&format!("## {}\n\n", ch.name));
        for s in &ch.sections {
            let text = fs::read_to_string(root.join(book).join(&ch.name).join(&s.file)).unwrap_or_default();
            let t = text.trim();
            if !t.is_empty() {
                out.push_str(t);
                out.push_str("\n\n");
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- settings and devices

pub fn read_settings(root: &Path) -> String {
    fs::read_to_string(root.join(APP_DATA).join("settings.json")).unwrap_or_else(|_| "{}".into())
}

pub fn write_settings(root: &Path, json: &str) -> Res<()> {
    serde_json::from_str::<serde_json::Value>(json).map_err(err("Settings are not valid"))?;
    atomic_write(&root.join(APP_DATA).join("settings.json"), json.as_bytes())
}

pub fn write_activity(root: &Path, a: &Activity) -> Res<()> {
    let body = serde_json::to_string_pretty(a).map_err(err("Could not record activity"))?;
    atomic_write(&root.join(APP_DATA).join("devices").join(format!("{}.json", safe_name(&a.device))), body.as_bytes())
}

pub fn read_activity(root: &Path) -> Vec<Activity> {
    let mut v = vec![];
    if let Ok(rd) = fs::read_dir(root.join(APP_DATA).join("devices")) {
        for e in rd.flatten() {
            if let Ok(s) = fs::read_to_string(e.path()) {
                if let Ok(a) = serde_json::from_str::<Activity>(&s) {
                    v.push(a);
                }
            }
        }
    }
    v
}

// ---------------------------------------------------------------- snapshots

fn zip_dir(src: &Path, dest: &Path) -> Res<()> {
    fs::create_dir_all(dest.parent().unwrap()).map_err(err("Could not create the backup folder"))?;
    let tmp = dest.with_extension("zip.ws-saving");
    {
        let file = fs::File::create(&tmp).map_err(err("Could not create backup"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut stack = vec![src.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for e in fs::read_dir(&dir).map_err(err("Could not read book"))?.flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let rel = p.strip_prefix(src).unwrap().to_string_lossy().replace('\\', "/");
                if p.is_dir() {
                    stack.push(p);
                } else {
                    zip.start_file(rel, opts).map_err(err("Backup failed"))?;
                    let mut buf = vec![];
                    fs::File::open(&p).and_then(|mut f| f.read_to_end(&mut buf)).map_err(err("Backup failed"))?;
                    zip.write_all(&buf).map_err(err("Backup failed"))?;
                }
            }
        }
        let f = zip.finish().map_err(err("Backup failed"))?;
        f.sync_all().map_err(err("Backup failed"))?;
    }
    fs::rename(&tmp, dest).map_err(err("Backup failed"))?;
    Ok(())
}

fn parse_snapshot_name(file: &str) -> Option<(NaiveDateTime, String)> {
    let stem = file.strip_suffix(".zip")?;
    let (when, device) = stem.split_once(" - ")?;
    let t = NaiveDateTime::parse_from_str(when, "%Y.%m.%d %H%M").ok()?;
    Some((t, device.to_string()))
}

/// Keep: everything from the last 48 hours, one per day for 60 days, one per week after.
pub fn prune_snapshots(dir: &Path, now: DateTime<Local>) -> Res<Vec<String>> {
    let mut by_device: HashMap<String, Vec<(NaiveDateTime, String)>> = HashMap::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some((t, dev)) = parse_snapshot_name(&name) {
                by_device.entry(dev).or_default().push((t, name));
            }
        }
    }
    let now = now.naive_local();
    let mut removed = vec![];
    for (_, mut list) in by_device {
        list.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
        let mut seen: Vec<String> = vec![];
        for (t, name) in list {
            let age = now - t;
            let bucket = if age <= Duration::hours(48) {
                None
            } else if age <= Duration::days(60) {
                Some(format!("d{}", t.date()))
            } else {
                let w = t.date().iso_week();
                Some(format!("w{}-{}", w.year(), w.week()))
            };
            if let Some(b) = bucket {
                if seen.contains(&b) {
                    // Snapshots are app-made copies; old extras are thinned out, never the writing itself.
                    fs::remove_file(dir.join(&name)).map_err(err("Could not tidy old backups"))?;
                    removed.push(name);
                } else {
                    seen.push(b);
                }
            }
        }
    }
    Ok(removed)
}

/// Snapshot one book into the Drive backups folder and a local folder on this Mac.
pub fn snapshot_book(root: &Path, book: &str, device: &str, local_backups: Option<&Path>) -> Res<String> {
    let src = resolve(root, book)?;
    let file = format!("{} - {}.zip", now_stamp(), safe_name(device));
    let drive_dir = root.join(BACKUPS).join(book);
    zip_dir(&src, &drive_dir.join(&file))?;
    prune_snapshots(&drive_dir, Local::now())?;
    if let Some(local) = local_backups {
        let ldir = local.join(book);
        if zip_dir(&src, &ldir.join(&file)).is_ok() {
            let _ = prune_snapshots(&ldir, Local::now());
        }
    }
    Ok(file)
}

pub fn list_snapshots(root: &Path, book: &str) -> Vec<Snapshot> {
    let dir = root.join(BACKUPS).join(book);
    let mut v: Vec<(NaiveDateTime, Snapshot)> = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some((t, device)) = parse_snapshot_name(&name) {
                let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                let when = Local.from_local_datetime(&t).single().map(|d| d.format("%a %b %-d, %Y at %-I:%M %p").to_string()).unwrap_or_default();
                v.push((t, Snapshot { file: name, when, device, bytes }));
            }
        }
    }
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, s)| s).collect()
}

/// Bring a snapshot back as a new book next to the original. Never overwrites anything.
pub fn restore_snapshot(root: &Path, book: &str, file: &str) -> Res<String> {
    let zip_path = resolve(root, &format!("{BACKUPS}/{book}/{file}"))?;
    let when = parse_snapshot_name(file).map(|(t, _)| t.format("%Y.%m.%d %H%M").to_string()).unwrap_or_default();
    let (name, dir) = unique_path(root, &format!("{book} (restored {when})"), "");
    let f = fs::File::open(&zip_path).map_err(err("Could not open backup"))?;
    let mut archive = zip::ZipArchive::new(f).map_err(err("Backup is unreadable"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(err("Backup is unreadable"))?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(err("Restore failed"))?;
        } else {
            let mut buf = vec![];
            entry.read_to_end(&mut buf).map_err(err("Restore failed"))?;
            atomic_write(&out, &buf)?;
        }
    }
    let meta = read_meta(&dir);
    let title = meta.get("title").cloned().unwrap_or_else(|| book.to_string());
    set_book_meta(root, &name, Some(&format!("{title} (restored {when})")), None)?;
    Ok(name)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn lib() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn creates_a_book_with_first_chapter_and_section() {
        let d = lib();
        let name = create_book(d.path(), "The Bench").unwrap();
        let l = list_library(d.path()).unwrap();
        assert_eq!(l.books.len(), 1);
        assert_eq!(l.books[0].name, name);
        assert_eq!(l.books[0].title, "The Bench");
        assert_eq!(l.books[0].chapters[0].name, "Chapter One");
        assert_eq!(l.books[0].chapters[0].sections[0].file, "Opening.md");
    }

    #[test]
    fn unlisted_files_still_appear_at_the_end() {
        assert_eq!(
            apply_order(vec!["b".into(), "a".into(), "z".into(), "c".into()], &["c".into(), "gone".into(), "a".into()]),
            vec!["c", "a", "b", "z"]
        );
    }

    #[test]
    fn save_refuses_to_overwrite_a_version_it_has_not_seen() {
        let d = lib();
        let b = create_book(d.path(), "B").unwrap();
        let rel = format!("{b}/Chapter One/Opening.md");
        let first = save_section(d.path(), &rel, "one", None).unwrap();
        // The other Mac changes the file.
        fs::write(d.path().join(&rel), "from the laptop").unwrap();
        let r = save_section(d.path(), &rel, "two", Some(&first.hash)).unwrap();
        assert_eq!(r.status, "conflict");
        assert_eq!(r.disk_text.as_deref(), Some("from the laptop"));
        assert_eq!(fs::read_to_string(d.path().join(&rel)).unwrap(), "from the laptop");
        // Saving from the right base works.
        let ok = save_section(d.path(), &rel, "merged", Some(&hash("from the laptop"))).unwrap();
        assert_eq!(ok.status, "saved");
    }

    #[test]
    fn move_rename_and_trash_keep_order_files_right() {
        let d = lib();
        let b = create_book(d.path(), "B").unwrap();
        let c1 = format!("{b}/Chapter One");
        let c2 = create_chapter(d.path(), &b, "Two", Some("Chapter One")).unwrap();
        create_section(d.path(), &c1, "Second", Some("Opening.md")).unwrap();
        let moved = move_item(d.path(), &format!("{c1}/Second.md"), &format!("{b}/{c2}"), 0).unwrap();
        assert_eq!(moved, format!("{b}/{c2}/Second.md"));
        let renamed = rename_item(d.path(), &moved, "The Letter").unwrap();
        assert_eq!(renamed, format!("{b}/{c2}/The Letter.md"));
        let l = list_library(d.path()).unwrap();
        assert_eq!(l.books[0].chapters[1].sections[0].title, "The Letter");
        trash_item(d.path(), &renamed).unwrap();
        let l = list_library(d.path()).unwrap();
        assert!(l.books[0].chapters[1].sections.is_empty());
        assert_eq!(fs::read_dir(d.path().join(TRASH)).unwrap().count(), 1);
        // reorder chapters
        set_order(d.path(), &b, vec![c2.clone(), "Chapter One".into()]).unwrap();
        let l = list_library(d.path()).unwrap();
        assert_eq!(l.books[0].chapters[0].name, c2);
    }

    #[test]
    fn drive_duplicates_are_flagged() {
        assert!(looks_like_drive_duplicate("Opening (1)"));
        assert!(!looks_like_drive_duplicate("Opening (draft)"));
        assert!(!looks_like_drive_duplicate("Opening"));
    }

    #[test]
    fn rejects_paths_outside_the_library() {
        assert!(resolve(Path::new("/x"), "../etc/passwd").is_err());
        assert!(resolve(Path::new("/x"), "/etc/passwd").is_err());
    }

    #[test]
    fn snapshot_and_restore_round_trip() {
        let d = lib();
        let b = create_book(d.path(), "B").unwrap();
        save_section(d.path(), &format!("{b}/Chapter One/Opening.md"), "It began.", None).unwrap();
        let local = lib();
        let f = snapshot_book(d.path(), &b, "iMac", Some(local.path())).unwrap();
        assert_eq!(list_snapshots(d.path(), &b).len(), 1);
        assert!(local.path().join(&b).join(&f).exists());
        let restored = restore_snapshot(d.path(), &b, &f).unwrap();
        let text = fs::read_to_string(d.path().join(&restored).join("Chapter One/Opening.md")).unwrap();
        assert_eq!(text, "It began.");
        // The backups folder is not shown as a book.
        assert_eq!(list_library(d.path()).unwrap().books.len(), 2);
    }

    #[test]
    fn pruning_keeps_recent_then_daily_then_weekly() {
        let d = lib();
        let now = Local.with_ymd_and_hms(2026, 11, 23, 12, 0, 0).unwrap();
        let names = [
            "2026.11.23 1100 - iMac.zip", // recent: kept
            "2026.11.23 1000 - iMac.zip", // recent: kept
            "2026.11.10 1500 - iMac.zip", // daily: newest of the day kept
            "2026.11.10 0900 - iMac.zip", // daily: removed
            "2026.11.10 0900 - MacBook Pro.zip", // other Mac: kept
            "2026.01.05 0900 - iMac.zip", // weekly
            "2026.01.06 0900 - iMac.zip", // same ISO week: newer kept
        ];
        for n in names {
            fs::write(d.path().join(n), "x").unwrap();
        }
        let mut removed = prune_snapshots(d.path(), now).unwrap();
        removed.sort();
        assert_eq!(removed, vec!["2026.01.05 0900 - iMac.zip", "2026.11.10 0900 - iMac.zip"]);
    }

    #[test]
    fn inbox_notes_can_be_filed_into_a_chapter() {
        let d = lib();
        let b = create_book(d.path(), "B").unwrap();
        fs::create_dir_all(d.path().join(INBOX)).unwrap();
        fs::write(d.path().join(INBOX).join("2026.11.23 0930 Idea.md"), "a thought").unwrap();
        assert_eq!(list_library(d.path()).unwrap().inbox.len(), 1);
        let rel = file_inbox_note(d.path(), "2026.11.23 0930 Idea.md", &format!("{b}/Chapter One")).unwrap();
        assert!(rel.ends_with("Idea.md"));
        let l = list_library(d.path()).unwrap();
        assert!(l.inbox.is_empty());
        assert_eq!(l.books[0].chapters[0].sections.len(), 2);
    }

    #[test]
    fn export_stitches_the_book_in_order() {
        let d = lib();
        let b = create_book(d.path(), "My Book").unwrap();
        save_section(d.path(), &format!("{b}/Chapter One/Opening.md"), "First words.", None).unwrap();
        let out = export_book(d.path(), &b).unwrap();
        assert_eq!(out, "# My Book\n\n## Chapter One\n\nFirst words.\n\n");
    }
}
