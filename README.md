# Hugging Face Downloader

Downloads AI models from Hugging Face onto your Windows PC, quickly and without
you having to work out which of the forty files in a folder you actually need.

**In plain words:** Hugging Face is a website where AI models are published. One
model is usually offered in several sizes — smaller ones are faster and use less
memory, larger ones tend to answer better. Those sizes have names like `Q4_K_M`
and `IQ3_XXS`, which mean nothing until someone explains them. This app lists what
is available, tells you what each option costs in disk space, and downloads only
the pieces that belong together. Large models are often split across several files;
it keeps those together for you.

It comes as a point-and-click app and, for anyone who prefers typing, a terminal
script that follows exactly the same rules.

> **This is an unofficial community project.** It is not affiliated with,
> endorsed by, or supported by Hugging Face. It talks to the public Hugging Face
> API the same way a browser does.

**Version 0.3.0. Windows only.**

---

## Contents

- [Setting up from scratch](#setting-up-from-scratch) — start here if you have nothing installed
  - [Step 1: Install aria2 (required)](#step-1-install-aria2-required)
  - [Step 2: Install LM Studio (optional)](#step-2-install-lm-studio-optional)
  - [Step 3: Install the downloader](#step-3-install-the-downloader)
  - [Step 4: First run](#step-4-first-run)
  - [Step 5: Download your first model](#step-5-download-your-first-model)
- [Private and gated models](#private-and-gated-models)
- [The terminal version](#the-terminal-version)
- [Updates](#updates)
- [Configuration](#configuration)
- [How downloads are verified](#how-downloads-are-verified)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Changelog](CHANGELOG.md)
- [License](#license)

---

## Setting up from scratch

This section assumes a clean Windows machine with nothing set up. Work through
it in order; the whole thing takes about ten minutes, most of which is waiting
for downloads.

**What you need:** Windows 10 or 11, and an internet connection. You do **not**
need Python, an administrator account, or a Hugging Face account (unless you
want gated models — see [Private and gated models](#private-and-gated-models)).

### Step 1: Install aria2 (required)

aria2 is the program that actually moves the bytes. It downloads a file over
several connections at once and can resume where it left off. **The app will not
download anything without it.**

Pick whichever of these suits you.

#### Option A — WinGet (easiest)

WinGet ships with Windows 11 and recent Windows 10. Open **Terminal** or
**PowerShell** from the Start menu and run:

```powershell
winget install aria2.aria2
```

Close and reopen your terminal afterwards so the new `PATH` takes effect. Check
it worked:

```powershell
aria2c --version
```

You should see `aria2 version 1.x.x`. If you instead see "not recognized", your
`PATH` has not refreshed — reopen the terminal, or sign out and back in.

#### Option B — Download it yourself (no package manager)

1. Go to <https://github.com/aria2/aria2/releases>.
2. Under the newest release, expand **Assets** and download the file ending in
   **`-win-64bit-build1.zip`** (or `-win-32bit-` on a 32-bit machine).
3. Right-click the `.zip` → **Extract All**. Extract it anywhere you like, for
   example `C:\Tools\aria2`.
4. Inside the extracted folder is **`aria2c.exe`**. Remember where it is.
5. You do not need to add it to `PATH`. In the desktop app, open **Settings →
   Download engine → Choose executable** and point it at that `aria2c.exe`.

> Alternatively, create a folder named `bin` next to this project's files and
> drop `aria2c.exe` in it. The app looks there automatically.

#### Option C — Scoop or Chocolatey

```powershell
scoop install aria2
choco install aria2
```

Both locations are searched automatically.

#### How the app finds aria2

In order: the path you set in Settings, then `bin\aria2c.exe` beside the
project, then everything on `PATH`, then the usual WinGet, Program Files,
Chocolatey, and Scoop locations. The pill in the top-right of the app window
reads **● aria2 found** once it locates it. If it reads **Set up aria2**, click
it to jump straight to Settings.

### Step 2: Install LM Studio (optional)

**Skip this step if you do not use LM Studio.** Nothing in this app requires it,
and downloads work perfectly well without it.

LM Studio is a desktop app for running GGUF models locally. If you use it, this
downloader can save models directly into LM Studio's own library folder so they
appear in its model list without any copying.

1. Get it from <https://lmstudio.ai> and install it.
2. Launch it once. That creates the library folder at
   `C:\Users\<you>\.lmstudio\models`.
3. In this downloader, click **Use LM Studio folder** (on the **New download**
   page under *Choose a home*, or in **Settings**). The path fills in for you.

Models are saved as `.lmstudio\models\owner\repository\file.gguf`, which is the
layout LM Studio expects. It usually picks them up on its next scan; if not, use
its own refresh control.

> If you have moved LM Studio's models directory somewhere else, use **Browse
> folders** and select your actual library folder instead. The button only fills
> in the default location.

### Step 3: Install the downloader

There are two ways. **Option A is the easy one.**

#### Option A — Run the installer

1. Go to the project's **Releases** page:
   <https://github.com/M007-Net/hugging-face-downloader/releases>. While the
   repository is private that page is visible only to accounts with access, and
   there may be no release published yet — in either case use Option B and build
   it yourself.
2. Download `Hugging-Face-Downloader-Setup-<version>.exe`.

   > If that page is empty or you cannot open it, no release has been published
   > yet. Until one is, use **Option B — Run from source** below, or wait for a
   > release. Nothing is lost by waiting.
3. **Before running it, check the hash.** The installer is not code-signed, so
   this is the only way to confirm you got the file the release actually
   published:

   ```powershell
   Get-FileHash -Algorithm SHA256 '.\Hugging-Face-Downloader-Setup-0.3.0.exe'
   ```

   Compare the result with the SHA-256 listed on the release page. **If it does
   not match, delete the file and do not run it.**
4. Run the installer. Windows SmartScreen will say *"Windows protected your
   PC"* because the file is unsigned. Click **More info**, then **Run anyway**.
   There is no way around this short of an Authenticode certificate, which this
   project does not have.
5. Choose an install folder. The installer creates Start menu and desktop
   shortcuts.

#### Option B — Run from source

You need [Node.js](https://nodejs.org) 20 or newer (the LTS installer is fine).

```powershell
git clone https://github.com/M007-Net/hugging-face-downloader.git
cd hugging-face-downloader
npm ci
```

`npm ci` downloads Electron, which is roughly 100 MB, so give it a minute. It
installs exactly what `package-lock.json` pins; use `npm install` only if you are
deliberately updating a dependency.

Then start it with **any** of these:

| Launch with | What it does |
| --- | --- |
| Double-click **`Hugging Face Downloader.vbs`** | Normal way to start it. No console window. |
| Double-click **`Hugging Face Downloader.cmd`** | Same app, but keeps a console open so you can read startup errors. Use this if something goes wrong. |
| `npm start` | Same thing from a terminal you already have open. |

To put it on your desktop, right-click `Hugging Face Downloader.vbs` → **Send to
→ Desktop (create shortcut)**.

> **If you are making your own shortcut by hand:** point it at the `.vbs` file,
> and leave the shortcut's **Run:** setting on **Normal window**. Setting it to
> *Minimized* makes Windows start the app with its window hidden and nothing
> appears on screen. See [Troubleshooting](#troubleshooting).

### Step 4: First run

Open the app. You should see a three-item sidebar — **New download**,
**Downloads**, **Settings** — and a guidance panel on the right that explains
whatever you are currently looking at.

Two things to check before your first download:

1. **Top right of the window.** It should read **● aria2 found**. If it reads
   **Set up aria2**, click it and either pick `aria2c.exe` (Step 1, Option B) or
   go back and install aria2.
2. **Where files go.** On the **New download** page, under *Choose a home*, the
   download folder defaults to `Downloads\HuggingFace` in your user profile.
   Change it with **Browse folders**, or click **Use LM Studio folder** if you
   did Step 2. Your choice is remembered.

### Step 5: Download your first model

1. **Find your model.** Paste a Hugging Face link into the box and click **Load
   model**. All of these work:

   - `https://huggingface.co/owner/model-GGUF`
   - `owner/model-GGUF`
   - A link to a folder inside a repository
   - A link to one specific file

   Nothing is downloaded at this point — the app only lists what is there.

2. **Choose what to download.** For GGUF repositories, leave it on **Choose
   quantization** and pick a *bit level*, then an *exact quantization*.

   Quantization shrinks a model. Fewer bits means a smaller file and less
   memory, usually at some cost to quality. **If you have no idea what to pick,
   start with a 4-bit option such as `Q4_K_M`** — it is the usual balance. The
   size shown is the download size, not the memory needed to run the model.

   Models split across several files are selected together automatically, and
   the app tells you if parts are missing.

   Switch to **Choose specific files** to tick files individually instead.

3. **Optional companions.** If the repository has separate *vision* files
   (image support) or *MTP* files (a speed helper for some runtimes), they are
   offered here. They are detected by filename only, and the app says so —
   whether one actually fits your model and runtime is for you to judge. Leave
   them unticked if you are not sure.

4. **Choose a home.** Confirm the download folder.

5. **Review and download.** The bottom panel shows the total size and the exact
   file list — expand **Review selected files** to read it. Click **Download
   selected** when it looks right.

6. **Watch it.** The **Downloads** page shows overall progress, speed, and
   per-file status. You can **Pause** and close the app; partial files stay on
   disk and **Resume / retry** picks up where it stopped. Pausing only affects
   downloads started by this app.

When it finishes, **Open download folder** takes you straight to the files.

---

## Private and gated models

Public models need no account. You need a token for private repositories and for
gated ones (models where you must accept a license first, such as some Llama and
Gemma releases).

1. Create an account at <https://huggingface.co>.
2. For a gated model, open its page and accept the terms. Approval is sometimes
   instant and sometimes takes a while.
3. Go to **Settings → Access Tokens** on Hugging Face and create a token with
   the **Read** role. Copy it.
4. In this app: **Settings → Hugging Face access → Read token**, paste, and
   **Save settings**.

**The token is kept in memory for that session only.** It is never written to
the settings file or anywhere else in the project. You will re-enter it next
time you open the app.

To avoid retyping it, set it in your environment instead — the app picks it up
automatically:

```powershell
[Environment]::SetEnvironmentVariable('HF_TOKEN', 'hf_your_token_here', 'User')
```

Reopen the app afterwards. A token stored by the official `huggingface-cli
login` is also detected.

The token is sent only to `huggingface.co`. When Hugging Face redirects a
download to its CDN, the authorization header is deliberately dropped before the
CDN request, so the CDN only ever sees a signed URL. The token is never passed
as a command-line argument, because process arguments are readable by other
processes on the machine.

---

## The terminal version

`HF Download.cmd` runs the same logic as a guided PowerShell script — same
selection rules, same verification, same IPv4 enforcement. It keeps its own
settings, separate from the desktop app's. Double-click it, or drive the script
directly:

```powershell
.\hf-download.ps1 -Url 'owner/repository' -OutputDir '.\downloads'
.\hf-download.ps1 -Connections 8
.\hf-download.ps1 -Aria2Path 'D:\Tools\aria2c.exe'
```

Menus are numbered. Press Enter to take the highlighted default, or `B` to go
back. The file picker accepts numbers, ranges (`2-6`), `all`, or part of a
filename; blank cancels.

The `.cmd` launcher sets an execution-policy override for that one process, so
it works even where script execution is otherwise blocked. It does not change
any system setting.

---

## Updates

The app can check GitHub for a newer release. On launch it asks once, quietly;
you can also check on demand from **Settings → Updates**.

When a newer version exists, a banner appears. **Download update** fetches the
installer; **Install now** is a second, separate click that runs it. Nothing is
downloaded or installed on its own.

A downloaded installer is kept only if its SHA-256 matches the hash published in
the release notes. If it does not match, the file is deleted and you are told.
If a release publishes no hash at all, the app refuses to download it and points
you at the release page instead — the installer is unsigned, so a verified hash
is the only real check available.

### Turning on the updater

`desktop/updater.cjs` reads one field, and nothing else decides whether update
checks happen:

```jsonc
// package.json
"repository": { "type": "git", "url": "https://github.com/M007-Net/hugging-face-downloader" }
```

Set to the literal owner `YOUR_GITHUB_USERNAME`, that field switches update
checks off completely and the app makes no outbound request at all. A fork should
either point it at its own repository or restore the placeholder.

While this repository is private, the check asks `api.github.com` about once per
launch and is answered with a 404, because an unauthenticated client cannot see a
private repository. That failure is silent by design: no banner appears and
nothing is downloaded. Checks start returning real results once the repository is
public and has a published release. **Settings → Updates** says which state the
current build is in.

### Publishing a release the updater can use

1. Bump `version` in `package.json`.
2. Build the installer: `npm run package`.
3. Hash it:

   ```powershell
   Get-FileHash -Algorithm SHA256 '.\release\Hugging-Face-Downloader-Setup-0.4.0.exe'
   ```

4. Create a GitHub release whose **tag** is the version (`v0.4.0` or `0.4.0`).
5. Attach the `.exe`.
6. **Put the hash in the release notes, next to the filename.** Either order
   works:

   ```text
   Hugging-Face-Downloader-Setup-0.4.0.exe  9f2a...c31b
   ```

   Without this line the updater will not offer the download.

Prereleases are handled correctly: `0.4.0-beta.1` is *not* offered to someone
already running `0.4.0`.

---

## Configuration

Desktop settings live under your local application-data folder and hold the
download folder, preferred quantization, connection count, and aria2 path.
**Tokens are never saved.**

The terminal version reads these:

| Option | Behavior |
| --- | --- |
| `-OutputDir` | Download root for this run; wins over everything else. |
| `HF_DOWNLOADER_OUTPUT` | Environment override for the download root. |
| Saved folder | Used when neither override is supplied. |
| First-run folder | Defaults to `Downloads\HuggingFace`; you can choose another. |
| `-Connections` | Connections per file, 1 to 16. Default 16. Lower it if your network struggles. |
| `-Aria2Path` | Explicit executable path; otherwise `bin\`, `PATH`, and the usual package locations. |
| `-SettingsPath` | Alternative settings JSON, useful for a portable install. |
| `-DisableIPv6` | Accepted for compatibility. IPv4-only is always enforced regardless. |

Authentication checks `HF_TOKEN`, then `HUGGING_FACE_HUB_TOKEN` and
`HUGGINGFACE_TOKEN`, then the local token file. Token-file discovery respects
`HF_TOKEN_PATH`, `HF_HOME`, and `XDG_CACHE_HOME`.

**Transfers are IPv4-only and cannot be switched.** Every aria2 invocation
passes `--disable-ipv6=true`. Listings and size probes do not go through aria2,
so they are pinned separately: the terminal version rejects IPv6 candidates in
its bind callback, and the desktop version requests `family: 4` directly.

Models are saved as `download-root\owner\repository\path`. Datasets and Spaces
go under `datasets\` and `spaces\`. No destination depends on the author's
username or on which applications you have installed.

---

## How downloads are verified

- Every file downloads to a `.part` file and is renamed to its real name only
  after the size matches and, where Hugging Face publishes a SHA-256, the hash
  matches too.
- A `.part` file that fails verification is **kept**, so you can inspect it and
  so a later run resumes rather than restarting.
- A file already on disk is reused only if it hashes to the expected digest.
  Where Hugging Face publishes no digest — typically small non-LFS files — a
  size match is accepted.
- Each listing is pinned to the commit it came from, so a branch that moves
  between listing and download cannot quietly swap the bytes.
- Repository paths are checked against Windows naming rules, including reserved
  device names and case-insensitive collisions. A file that cannot be named
  safely is skipped and reported rather than making the whole repository
  unusable.
- Both the desktop app and the terminal script confirm the resolved target really
  sits inside the destination folder, and refuse to write through any symbolic
  link or junction on the way there - whatever it points at.
- Nothing is promoted out of `.part` unless there is something to check it
  against. If Hugging Face reports neither a size nor a digest for a file, the
  download is refused rather than finished on trust.
- A folder being written to is locked, so two copies of the app cannot fight
  over the same files.
- The download engine and the destination folder must both be on a local drive.
  A network location is refused, so neither can pull a program from, or write to,
  another machine.

### Where your token goes

Your Hugging Face token reaches exactly one host: `huggingface.co`.

Every large file on Hugging Face is stored with Git LFS, and a `/resolve/` URL for
one answers with a redirect to a content delivery network on a different domain
(`cas-bridge.xethub.hf.co` and similar). Those CDN addresses are already signed and
need no credential. Both engines therefore walk the redirect themselves and hand
aria2 the final signed address with **no** `Authorization` header. When Hugging Face
serves a file directly instead, aria2 does get the header — and that download is
given `max-redirect=0`, so it cannot forward it anywhere.

The token is never put on a command line (where any other account on the machine
could read it), never written to the settings file, and never printed. It reaches
aria2 only through the manifest on its standard input.

[SECURITY.md](SECURITY.md) covers what is and is not checked, and how to report
a vulnerability.

---

## Troubleshooting

**Nothing happens when I launch it. No window, no error.**
Check Task Manager for `electron.exe` (or `Hugging Face Downloader.exe`)
processes. If they are running but no window is visible, something started the
app with a hidden window:

- If you made your own shortcut, open its **Properties** and set **Run:** back
  to **Normal window**. Windows passes that setting to the app, and Chromium
  applies it to the first window — *Minimized* means nothing appears.
- If you edited `Hugging Face Downloader.vbs`, the final `shell.Run` must pass
  `SW_SHOWNORMAL` (1). Passing `0` hides the window for the life of the app.

End the stray processes in Task Manager before trying again: the app allows only
one copy at a time, so a hidden instance makes every later launch exit silently.

**It opens, then closes immediately.**
Launch `Hugging Face Downloader.cmd` instead. It keeps a console open and shows
the error.

**"Desktop dependencies are not installed yet."**
Run `npm ci` in the project folder once.

**The pill says "Set up aria2".**
Go back to [Step 1](#step-1-install-aria2-required). If aria2 is installed but
not found, point Settings at `aria2c.exe` directly.

**"Access denied" when loading a repository.**
The model is private or gated. See
[Private and gated models](#private-and-gated-models). For a gated model, also
confirm you accepted its terms on the Hugging Face website.

**Downloads are slow or keep failing.**
Lower **Connections per file** in Settings. Some networks and some mirrors
object to 16 parallel connections.

**A download failed partway through.**
Press **Resume / retry**. Completed files are skipped, and partial files
continue from where they stopped.

**SmartScreen blocks the installer.**
Expected — it is unsigned. Verify the SHA-256 against the release page first,
then **More info → Run anyway**.

---

## Development

```powershell
npm ci                  # the exact locked dependency set, the same one CI installs
npm test                # Node unit tests: selection, paths, transfers, updater
npm run qa              # Static UI, launcher, and security-wiring checks
npm run test:terminal   # the PowerShell engine's offline suite
npm run package         # Build the Windows installer into release\
```

`npm ci` installs from the committed `package-lock.json` and reproduces the versions
listed in [THIRD_PARTY.md](THIRD_PARTY.md); `npm install` may resolve newer ones.

As of 0.3.0 that is **33 Node tests**, **146 PowerShell checks**, and the static
UI pass. Tests import function definitions without starting the downloader, mock
user input and transfers, and use a checked-in listing fixture. **No test
downloads a model, and no test reaches the network.**

`npm run qa:electron` runs an interactive Playwright pass on machines with a
working Electron inspector.

GitHub Actions runs the terminal tests under both Windows PowerShell 5.1 and
PowerShell 7, the desktop suites under Node 20, and CodeQL weekly.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and
[THIRD_PARTY.md](THIRD_PARTY.md) for what this project depends on.

---

## License

[MIT](LICENSE). aria2, Electron, and LM Studio are separate projects under their
own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
