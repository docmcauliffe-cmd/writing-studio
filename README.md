# Writing Studio

A calm, distraction-free Mac app for writing books in plain Markdown, modeled on the parts of Ulysses that matter most: elegant typography, chapters and sections you can drag into any order, and saving you never have to think about.

## Where your writing lives

Everything is ordinary files in a **Writing Studio** folder inside Google Drive (any location you choose on first launch):

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

## Updates

When a new version is published, an **Update to x.y.z** button appears at the top right. Click it: your writing is saved, the update installs, and the app restarts. You can also check in **Look & settings › Check for updates**. Updates come from this repository's Releases and are signed, so the app only installs versions built here. Install the update on each Mac.

## Writing and formatting

The text looks formatted while you write: bold is bold and headings are headings, and the Markdown symbols stay out of sight. The files are still plain Markdown.

- **Format menu** in the menu bar, and a small bar that appears when you select text.
- **⌘B / ⌘I** work like Pages. With a selection, they toggle it. With the cursor inside a word, they format the word. Anywhere else, they turn bold or italic on for what you type next; press again to turn it off.
- **Lists**: ⇧⌘8 bullets, ⇧⌘7 numbers, ⇧⌘L checklist (click a box to tick it). Return adds the next item, Return on an empty item ends the list, and Tab / ⇧Tab nest and un-nest.
- **Notes to self** (⇧⌘K): highlighted comments that are never counted or exported. Return at the end of a note, ⇧⌘K again, or Esc steps back out to normal text. Saved as `<!-- note -->`, which other Markdown apps hide too.
- **Smart quotes and dashes**: “curly” quotes, `--` becomes —, `...` becomes …. Turn off in Edit › Smart Quotes and Dashes.
- **Quick Open (⌘O)** jumps to any section by typing a few letters. **Find (⌘F)** searches the section; **Find in Book (⇧⌘F)** searches and replaces across the whole book (a backup snapshot is taken before replacing).
- **Pictures**: paste a screenshot (⌘V) or drag a picture into a section. It is saved in the book's `_Images` folder and written as ordinary Markdown (`![](<../_Images/2026.11.24 2115 Screenshot.png>)`), so moving sections between chapters never breaks it. Backspace removes a picture; the file itself stays in `_Images`. Pictures appear in Word and PDF exports.
- **Links**: ⌘K adds one; ⌘-click a link to open it in your browser.
- **Sidebar width**: drag the sidebar's right edge; double-click it to reset. Each Mac remembers its own width.
- **Export** (File menu, or the book menu): Word (.docx), PDF (typeset directly, in Georgia on US Letter), or Markdown. Chapters start on new pages; notes to self are left out.
- **Goals** (View › Writing Goals): a daily word goal with a streak, a target per section, and a goal for the book. Rings at the bottom of the window fill as you write; words count across both Macs.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘B / ⌘I / ⇧⌘X | Bold / italic / strikethrough |
| ⌥⌘1, ⌥⌘2, ⌥⌘3 / ⌥⌘0 | Heading 1, 2, 3 / body text |
| ⇧⌘8 / ⇧⌘7 / ⇧⌘L | Bulleted list / numbered list / checklist |
| ⇧⌘' | Quote |
| ⌘K | Link |
| ⇧⌘K | Note to self |
| ⌘\\ | Clear formatting |
| ⌘O | Quick Open |
| ⌘F / ⇧⌘F | Find / Find in Book |
| ⌘P | Export to PDF |
| ⌘. | Focus mode: hide everything but the paragraph you're writing |
| ⌘1 / ⌘2 | Sidebar / Reference note beside your writing |
| ⌘N / ⇧⌘N | New section / new chapter |
| ⌘, | Look & settings |
| ⌘/ | All formatting and shortcuts |

Double-click a chapter or section to rename it. Right-click for more options. Drag sections and chapters to reorder them, or drop a section on a chapter title to move it there.

## Development

```
npm install
npm test                         # interface logic
(cd src-tauri && cargo test)     # file handling, saving, backups
npm run tauri dev                # run the app (Mac)
npm run dev                      # then open http://localhost:1420/dev/mock.html to try the interface in a browser with sample data
```

Pull requests build the app on GitHub (Actions › run › Artifacts). Every push to `main` publishes a release named after the version in `src-tauri/tauri.conf.json`; bump it (and `package.json`, `Cargo.toml`) for each new release.
