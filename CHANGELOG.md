# Changelog

All notable changes to Hugging Face Downloader are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

Dates are the date the version was prepared.

## 0.3.0 — 2026-09-14

First version prepared for public release. Both engines — the desktop app and the
terminal script — are covered; where a fix applies to only one, it says so.

### Security

- **The terminal engine handed your token to Hugging Face's CDN.** Every LFS file,
  which is every model weight, answers a `/resolve/` request with a redirect to
  another origin, and aria2 replays `--header` values on each hop. The unresolved
  URL plus the bearer token therefore sent that token to a third-party host that
  neither needs nor should see it. The terminal engine now walks the redirect chain
  itself, exactly as the desktop app already did: the signed CDN address is handed
  over with no credential, and a file served directly by `huggingface.co` gets the
  header only alongside `max-redirect=0`, so aria2 cannot forward it. The test that
  asserted the old behaviour now asserts the new invariant.
- **The same leak in the terminal engine's size probe.** Its fallback followed up to
  ten redirects with the `Authorization` header attached; Windows PowerShell does
  not strip that header across a redirect, which is the reason the rest of the file
  walks redirects by hand.
- **A release tag could write the installer anywhere.** The version regex was not
  anchored at the end, so a tag like `0.9.0-x/../../../…/Startup/payload` parsed as
  a valid prerelease and the whole string was interpolated into the download path —
  landing an executable in the per-user Startup folder. The published SHA-256 was no
  defence, because whoever controls the release also controls the notes it is read
  from. The version is now anchored, checked again before it becomes a filename, and
  the resolved path is confirmed to stay inside the updates folder.
- **The installer was not re-checked before it ran.** Its digest was taken as the
  bytes arrived; the user then read a dialog and decided, while the file sat at a
  predictable path. It is now hashed again at the moment of launch and deleted if it
  no longer matches.
- **A repository file name could disguise its extension.** Bidirectional and
  zero-width characters are legal in a filename and render as nothing, so
  `payload<RLO>gpj.exe` appeared everywhere as `payloadexe.jpg`. Such names are now
  refused; ordinary non-ASCII names are unaffected.
- **A download folder could be a UNC share.** `path.isAbsolute()` accepts
  `\\host\share`, and Windows attempts NTLM against a remote share unprompted,
  leaking the account name and a challenge response. A download folder must now be
  on a local drive.
- The terminal engine now confirms the resolved target really sits inside the
  destination and refuses to write through any symbolic link or junction on the way
  — the guarantee the desktop app already made and the README already claimed for
  both. The desktop app additionally checks the final file and its `.part`, which
  were previously left out.
- `--no-conf=true` is passed in both engines, so a stray `aria2.conf` in a user
  profile cannot turn off certificate checking, redirect the output folder, or run a
  program after each file.
- A repository name can no longer contain `.` or `..` path segments.
- **The download engine could be pointed at a network location.** The Settings field
  is free text and whatever it names is spawned; "exists and ends in .exe" accepted
  `\\host\share\aria2c.exe`, so a pasted path could run a binary from another
  machine, with Windows authenticating to that share on the way. It must now be an
  absolute path on a local drive, matching how the destination folder is checked.

### Fixed

- **A direct file link could finish a truncated download and call it complete.**
  That path carried no digest, and its size came from a probe whose every failure
  was swallowed. With both missing, verification returned true unconditionally. The
  SHA-256 is now read from the LFS ETag, and a file with neither a size nor a digest
  is refused rather than promoted on trust.
- **Non-ASCII filenames were corrupted on the way to aria2.** Windows PowerShell
  writes a native process's stdin as ASCII by default, so every accented or CJK
  character in the manifest became `?` — itself illegal in a Windows filename.
- **Redirect handling and the LFS size probe were broken under PowerShell 7**, which
  returns a response object whose headers have no string indexer. Both silently read
  as absent, while CI stayed green because the suite mocks that layer.
- **One unusable filename killed the whole queue**, after the user had already
  chosen every file, with a message naming neither the file nor the reason. Unsafe
  names are now skipped and listed, and the rest download.
- **One filesystem error killed the rest of the queue** — a file open in LM Studio,
  a path over the Windows length limit, a denied rename. Each file's failure is now
  its own.
- **A resume of a mostly-finished repository was refused for lack of disk space.**
  The preflight summed every file rather than what was left to fetch.
- **Two files differing only in capitalisation** both entered the queue, and in a
  batch went into one manifest with the same output name — two workers writing one
  file. They are now detected and reported.
- **A commit pin was silently discarded** when the companion listing failed, falling
  back to the mutable branch name and defeating the guarantee printed a line later.
- **Quantization and companion detection failed on Turkish and Azerbaijani systems**,
  where `I` and `i` are different letters, so an ordinary repository reported no
  recognized quantizations.
- A failing progress listener could fail the download and orphan a running aria2
  process that then raced its own retry and survived app exit.
- Every lock failure was reported as "another download is already running", including
  a read-only folder, a denied ACL, and a full disk. A lock is also no longer trusted
  forever on a recycled process id.
- aria2's stderr was discarded, so any failure outside four mapped codes read as
  "aria2 code 1". Its own words are now included.
- A double-click on Download reported a settings error for a download that had in
  fact started.
- Progress showed a permanent 0.0% when the API reported no file sizes; it now shows
  how much has been downloaded.
- A saved job with a malformed entry surfaced as a raw TypeError on resume.
- A socket error part-way through an update download left the partial file behind.
- Resuming now reports that it is verifying existing files rather than sitting on
  "starting, 0.0%" for the minutes that takes on a large repository.
- A download folder containing `[` or `]` was never created, because `New-Item -Path`
  reads those as wildcards.
- TLS 1.2 was being assigned rather than added, removing TLS 1.3 from the enabled set.
- `HF Download.cmd` no longer closes instantly on an error, and names PowerShell
  absolutely rather than finding it on `PATH`. `Hugging Face Downloader.cmd` works
  from a UNC path, where `cd /d` silently fails and it reported missing dependencies
  on a fully installed copy.

### Added

- **An application icon.** The build previously logged "default Electron icon is
  used", so the installer, the shortcuts and the taskbar button all showed
  Electron's own logo. `scripts/icon.ps1` draws an arrow descending into a tray at
  seven sizes (16 through 256) and packs them into `assets/icon.ico`; below 24
  pixels it drops the tray and draws the arrow alone, because at that size the two
  merge into a smudge. The glyph is original and uses the app's own colours — it
  deliberately does not reproduce Hugging Face's logo or wordmark, which would sit
  badly beside the disclaimer this README opens with. Regenerate with `npm run icon`.

### Changed

- **CI never ran.** `test.yml` set `shell: ${{ matrix.shell }}`, but a `shell:` value
  is validated before the matrix expands, so the workflow failed at startup on every
  commit: no jobs, and it appeared in Actions under its file path instead of its name.
  The interpreter is now chosen inside `run`, which does take expressions. The suite
  still runs under both Windows PowerShell 5.1 and PowerShell 7.
- **`npm test` found no tests on the Node version this project claims to support.**
  The script globbed `tests/*.test.cjs`, but `node --test` only expands globs from
  Node 21 and cmd.exe never does, so on Node 20 the glob reached node as a literal
  path. The files are named explicitly now, and a test asserts the list matches
  what is on disk so a new file cannot be added and silently never run.

- The `repository` field now names `M007-Net/hugging-face-downloader`, so the
  in-app updater is armed rather than switched off. While the repository is
  private the check is answered with a 404 and fails silently — no banner, no
  download. Setting the field back to the `YOUR_GITHUB_USERNAME` placeholder
  switches update checks off entirely, which is what a fork should do.
- Repository listing failures now distinguish 401, 403, 404, 429, and 5xx instead of
  surfacing one raw .NET message for all of them.
- Every page rebuild preserves keyboard focus, the caret, and the file list's scroll
  position. Previously each checkbox click returned focus to the top of the page.
- The sidebar marks the current page with `aria-current`, and the
  Content-Security-Policy adds `form-action`, `frame-src`, and `frame-ancestors`.

### Documentation

- A new "Where your token goes" section states the guarantee precisely.
- The symbolic-link claim is corrected: it applies to both engines and to any link
  on the path, not only one pointing outside the folder.
- `CONTRIBUTING.md` no longer says aria2 is fetched on first use — nothing installs
  it for you, and only the terminal script offers to run winget.
- `THIRD_PARTY.md` lists the release-download host that actually appears in a proxy
  log, and scopes the winget offer to the terminal script.
- `npm ci` is used consistently, `npm run test:terminal` is documented, and the
  Releases step says why there is no canonical URL while the repository placeholder
  stands.
