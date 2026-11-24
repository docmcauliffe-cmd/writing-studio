# Writing Studio Capture (iPhone)

A home-screen web page for jotting ideas on the iPhone. Each note becomes its own `.md` file in
`Writing Studio - Inbox` on Google Drive, named `YYYY.MM.DD HHMM First few words.md`, and shows up
in the Mac app's Inbox. Built the same way as Lift Log.

- `site/` is the whole page (static files, no build step). Netlify publishes it from this folder
  (project `writing-studio-capture`, base directory `capture`).
- `apps-script/Code.gs` is a Google Apps Script web app that runs as the owner and writes the files.
  Its private key is created by `setup()` and kept in Script Properties, never in this repo.
- Pairing: after `setup()` runs, the script hands its key to the first device that pastes the web app
  link within 30 minutes. Run `setup()` again to pair another device.
- Notes wait on the phone (localStorage) until the script confirms each one, so nothing is lost
  without signal. Every note has an id, so a retry never makes a duplicate file.
- Capture only: the page can't read or change anything already in Drive.

Changes to `capture/` don't trigger a Mac release (the build workflow ignores this folder).
