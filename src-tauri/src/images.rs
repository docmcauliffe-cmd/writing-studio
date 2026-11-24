//! Pictures in sections: pasted or dropped screenshots live in one `_Images` folder per book.
//!
//! A section refers to its pictures with ordinary Markdown, `![](<../_Images/2026.11.24 2115 Screenshot.png>)`,
//! so the files stay readable in any Markdown app. One folder per book (not per chapter) means
//! moving a section between chapters never breaks a picture, and backups and Drive sync
//! carry the folder along with the book.

use crate::library::{atomic_write, resolve, safe_name, unique_path, Res, INBOX};
use base64::Engine;
use pulldown_cmark::{Event, Parser, Tag};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const IMAGES: &str = "_Images";
const KINDS: &[(&str, &str)] = &[("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("webp", "image/webp"), ("heic", "image/heic")];

fn book_of(section_rel: &str) -> Res<&str> {
    let book = section_rel.split('/').next().unwrap_or("");
    if book.is_empty() || book == INBOX {
        return Err("File this note into a chapter first, then add pictures to it.".into());
    }
    Ok(book)
}

/// Save picture bytes for a section and return the Markdown path to use from that section.
pub fn save_image(root: &Path, section_rel: &str, name: &str, bytes: &[u8]) -> Res<String> {
    let book = book_of(section_rel)?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s, e.to_lowercase()),
        None => (name, "png".to_string()),
    };
    if !KINDS.iter().any(|(k, _)| *k == ext) {
        return Err("Only pictures can be added (PNG, JPEG, GIF, WebP or HEIC).".into());
    }
    if bytes.is_empty() {
        return Err("The picture is empty.".into());
    }
    let dir = resolve(root, book)?.join(IMAGES);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create the pictures folder: {e}"))?;
    let (file, path) = unique_path(&dir, &safe_name(stem), &format!(".{ext}"));
    atomic_write(&path, bytes)?;
    let depth = section_rel.split('/').filter(|c| !c.is_empty()).count().saturating_sub(2);
    Ok(format!("{}{IMAGES}/{file}", "../".repeat(depth)))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// Where a picture path written in a file in `dir` points, if it stays inside the library.
pub fn picture_file(root: &Path, dir: &Path, src: &str) -> Option<PathBuf> {
    let src = src.trim().trim_start_matches('<').trim_end_matches('>');
    if src.contains("://") || src.starts_with('/') || src.starts_with("data:") {
        return None;
    }
    let mut out = dir.to_path_buf();
    for c in Path::new(&percent_decode(src)).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    (out.starts_with(root) && out.is_file()).then_some(out)
}

/// A picture as a data: URL for the editor to show.
pub fn read_image(root: &Path, section_rel: &str, src: &str) -> Res<String> {
    let section = resolve(root, section_rel)?;
    let dir = section.parent().ok_or("No folder")?;
    let path = picture_file(root, dir, src).ok_or("Picture not found")?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = KINDS.iter().find(|(k, _)| *k == ext).map(|(_, m)| *m).ok_or("Not a picture")?;
    let bytes = fs::read(&path).map_err(|e| format!("Could not read the picture: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// The picture paths a section uses.
pub fn picture_refs(text: &str) -> Vec<String> {
    Parser::new(text)
        .filter_map(|e| match e {
            Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.to_string()),
            _ => None,
        })
        .collect()
}

/// After a section moves to another book, copy the pictures it uses into that book's folder
/// (the originals stay where they were, so nothing is ever lost).
pub fn carry_pictures(root: &Path, old_dir: &Path, new_dir: &Path, text: &str) {
    for src in picture_refs(text) {
        let Some(from) = picture_file(root, old_dir, &src) else { continue };
        if picture_file(root, new_dir, &src).is_some() {
            continue;
        }
        let mut to = new_dir.to_path_buf();
        for c in Path::new(&percent_decode(&src)).components() {
            match c {
                Component::Normal(p) => to.push(p),
                Component::ParentDir => {
                    to.pop();
                }
                _ => {}
            }
        }
        if to.starts_with(root) {
            if let Some(p) = to.parent() {
                let _ = fs::create_dir_all(p);
            }
            let _ = fs::copy(&from, &to);
        }
    }
}

/// Rewrite a section's relative picture paths as absolute ones (for the one-file Markdown export).
pub fn absolute_pictures(root: &Path, dir: &Path, text: &str) -> String {
    let mut out = text.to_string();
    for src in picture_refs(text) {
        if let Some(p) = picture_file(root, dir, &src) {
            let abs = format!("<{}>", p.display());
            for form in [format!("(<{src}>)"), format!("({src})")] {
                out = out.replace(&form, &format!("({abs})"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pictures_save_per_book_and_resolve_from_any_chapter() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        fs::create_dir_all(root.join("Bk/One")).unwrap();
        fs::write(root.join("Bk/One/A.md"), "x").unwrap();
        let md = save_image(root, "Bk/One/A.md", "2026.11.24 2115 Screenshot.png", b"png-bytes").unwrap();
        assert_eq!(md, "../_Images/2026.11.24 2115 Screenshot.png");
        let again = save_image(root, "Bk/One/A.md", "2026.11.24 2115 Screenshot.png", b"more").unwrap();
        assert_eq!(again, "../_Images/2026.11.24 2115 Screenshot 2.png");
        assert!(read_image(root, "Bk/One/A.md", &format!("<{md}>")).unwrap().starts_with("data:image/png;base64,"));
        assert!(read_image(root, "Bk/Two/B.md", "../_Images/2026.11.24%202115%20Screenshot.png").is_ok(), "same path works from another chapter");
        assert!(read_image(root, "Bk/One/A.md", "../../../etc/passwd").is_err());
        assert!(save_image(root, &format!("{INBOX}/n.md"), "a.png", b"x").is_err());
        assert!(save_image(root, "Bk/One/A.md", "evil.exe", b"x").is_err());

        // Moving to another book carries the picture along.
        fs::create_dir_all(root.join("Other/Ch")).unwrap();
        let text = format!("Look: ![](<{md}>)");
        carry_pictures(root, &root.join("Bk/One"), &root.join("Other/Ch"), &text);
        assert!(root.join("Other/_Images/2026.11.24 2115 Screenshot.png").is_file());
        assert!(root.join("Bk/_Images/2026.11.24 2115 Screenshot.png").is_file(), "original kept");

        let abs = absolute_pictures(root, &root.join("Bk/One"), &text);
        assert!(abs.contains(&format!("(<{}>)", root.join("Bk/One/../_Images/2026.11.24 2115 Screenshot.png").display())) || abs.contains("Bk/_Images/2026.11.24 2115 Screenshot.png>)"));
    }
}
