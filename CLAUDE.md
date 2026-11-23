# Writing Studio: notes for assistants

- Tauri 2 desktop app. Frontend: plain JS + Vite + CodeMirror 6 (`src/`). Backend: Rust (`src-tauri/src/library.rs` holds all file logic and its tests; `lib.rs` exposes it as commands).
- The library is the user's Google Drive folder `02 I-O Practice/Writing Studio`. Never write test data there. Use temp dirs (Rust tests) or `dev/mock.html` (browser preview with an in-memory mock).
- Safety rules the code must keep: atomic writes only; never delete user text (trash = move to `Writing Studio - Trash`); never overwrite a version the editor hasn't seen (hash check in `save_section`); unlisted files still show up.
- Folder names follow the owner's Drive rules: self-descriptive names ("Writing Studio - Inbox", not "Inbox"), dates as YYYY.MM.DD, max 4 levels below the top-level Drive folder.
- Run `npm test` and `cd src-tauri && cargo test` before pushing. CI builds a universal macOS .dmg; tags `v*` publish a release.
- Phase 2 (planned): iPhone capture page that writes new notes into `Writing Studio - Inbox` via the Drive API (drive.file scope).
