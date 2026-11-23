# Writing Studio

A calm, distraction-free Mac app for writing books in plain Markdown, modeled on the parts of Ulysses that matter most: elegant typography, chapters and sections you can drag into any order, and saving you never have to think about.

## Where your writing lives

Everything is ordinary files in **Google Drive › My Drive › 02 I-O Practice › Writing Studio**:

```
Writing Studio/
  <Book>/
    _book.txt                 title and word goal
    _order.txt                chapter order
    <Chapter>/
      _order.txt              section order
      <Section>.md            your text, plain Markdown
  Writing Studio - Inbox/     ideas captured on the iPhone
  Writing Studio - Backups/   hourly/daily/weekly snapshots of each book (.zip)
  Writing Studio - Trash/     anything deleted in the app, dated
  Writing Studio - App Data/  look settings and "which Mac is active" notes
```

## How saving and backup work

1. Autosave about a second after you pause, and whenever you switch sections, switch apps or quit.
2. Every save writes a full temporary copy, flushes it to disk, then swaps it in, so a crash or power cut can't leave a half-written file.
3. Google Drive for desktop syncs the folder to Drive and your other Mac, and keeps 30 days of file versions.
4. The app snapshots a book when you start writing in a session and every hour while you write, to `Writing Studio - Backups` and to `~/Library/Application Support/Writing Studio/Backups` on each Mac. It keeps everything from the last 48 hours, one per day for 60 days, and one per week after that. **Backups › Restore as a copy** brings one back as a separate book and never replaces anything.

## Two Macs

Both Macs run the same app on the same folder. If a section changes on the other Mac while you have unsaved typing here, the app shows both versions side by side and you choose: keep this one, keep the other, or keep both. It never overwrites a version it hasn't seen. A banner warns you when the other Mac was active on the same section in the last 10 minutes.

## Install

1. Go to the repository's **Releases** page and download the latest `Writing Studio_x.y.z_universal.dmg`.
2. Open it and drag **Writing Studio** to **Applications**.
3. The first time only: open Writing Studio. macOS says it can't verify the developer. Click **Done**, open **System Settings › Privacy & Security**, scroll down, and click **Open Anyway** next to Writing Studio. (The app is for your own use, so it isn't registered with Apple.)
4. Choose the Writing Studio folder in Google Drive when asked.

On each Mac, right-click the Writing Studio folder in Finder and choose **Google Drive › Available offline**, so you can write without a connection.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘. | Focus mode: hide everything but the paragraph you're writing |
| ⌘1 | Show or hide the sidebar |
| ⌘N | New section after the current one |
| ⇧⌘N | New chapter |
| ⌘, | Look & settings |
| ⌘S | Save now (it saves automatically anyway) |

Double-click a chapter or section to rename it. Right-click for more options. Drag sections and chapters to reorder them, or drop a section on a chapter title to move it there.

## Development

```
npm install
npm test                         # interface logic
(cd src-tauri && cargo test)     # file handling, saving, backups
npm run tauri dev                # run the app (Mac)
npm run dev                      # then open http://localhost:1420/dev/mock.html to try the interface in a browser with sample data
```

Pushing to `main` builds the app on GitHub (Actions › run › Artifacts). Pushing a tag such as `v0.1.1` publishes a release with the installer.
