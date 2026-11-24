# Writing Studio: notes for assistants

- Tauri 2 desktop app. Frontend: plain JS + Vite + CodeMirror 6 (`src/`). Backend: Rust (`src-tauri/src/library.rs` holds all file logic and its tests; `export.rs` Word/HTML export; `menu.rs` the Mac menu bar; `lib.rs` exposes it as commands).
- The editor hides Markdown symbols (`src/editor.js` live decorations + atomic ranges); pure text rules live in `src/markup.js` with tests. Menu items send their id as a `menu` event; `runAction` in `main.js` handles them. Shortcuts belong in `menu.rs` (the Mac routes them there first); editor keymaps cover the browser preview.
- Linux `cargo test` needs `libxdo-dev` (the menu code links it).
- The library is a folder named Writing Studio in the owner's Google Drive (location recorded in project memory, not here). Never write test data there. Use temp dirs (Rust tests) or `dev/mock.html` (browser preview with an in-memory mock).
- Safety rules the code must keep: atomic writes only; never delete user text (trash = move to `Writing Studio - Trash`); never overwrite a version the editor hasn't seen (hash check in `save_section`); unlisted files still show up.
- Folder names follow the owner's Drive rules: self-descriptive names ("Writing Studio - Inbox", not "Inbox"), dates as YYYY.MM.DD, max 4 levels below the top-level Drive folder.
- Run `npm test` and `cd src-tauri && cargo test` before pushing. CI builds a universal macOS .dmg; pushes to main publish a GitHub Release tagged from the version in tauri.conf.json (this session's proxy can't push tags).
- Phase 2: `capture/` is the iPhone page (Netlify static site + Google Apps Script web app that writes new notes into `Writing Studio - Inbox`, same pattern as Lift Log). See `capture/README.md`. Changes there do not trigger a Mac release.
