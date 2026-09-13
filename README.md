# Hugging Face Downloader

A Windows terminal downloader for Hugging Face, powered by aria2. Choose individual files or select a GGUF quantization by bit level and exact variant.

## Desktop app

The project now includes a guided Electron desktop app as well as the original terminal workflow. Start it with `npm install` followed by `npm start`, or use the packaged Windows installer. The sidebar keeps **New download**, **Downloads**, and **Settings** separate, and the right-hand guidance panel explains the current step. The desktop app previews every selected file before starting, detects split shards, and offers separate vision/MTP choices when the repository exposes them.

The terminal launcher remains available as **HF Download.cmd**. Both versions use the same Hugging Face file rules and can be used independently.

## Features

- Quantization picker with a remembered preferred variant.
- Split GGUF shards selected together, with missing-shard checks.
- Optional vision and MTP companion selection based on repository filenames.
- Resumable downloads, configurable connection count, and live progress.
- Your choice of download folder; optional LM Studio library destination.
- Public, private, and gated repositories using your existing Hugging Face token.
- Repository URLs, file URLs, folder URLs, and `owner/repository` shorthand.

## Requirements

- Windows with Windows PowerShell 5.1 or PowerShell 7.
- [aria2](https://github.com/aria2/aria2/releases) (`aria2c.exe`). The downloader offers installation with WinGet if aria2 is missing. You can also put it on PATH, place it in `bin/` beside the script, or specify `-Aria2Path`.

No Python, Node.js, LM Studio, or administrator account is required by the script. Package installation permissions depend on your environment. Linux and macOS are not supported by this initial Windows release.

## Quick start

Download or clone this project, run `npm install` once, and double-click **Hugging Face Downloader.cmd** for the desktop app. Double-click **HF Download.cmd** for the terminal version. On first launch, choose a download folder. Enter `LM` to use the standard LM Studio library, or paste the path to a custom library. Paste a Hugging Face link and follow the menus.

The interface uses numbered keyboard choices. Press Enter to accept a highlighted default or `B` to return to the previous menu. The specific-files picker accepts numbers, ranges, `all`, or a filename substring; blank cancels.

```powershell
.\hf-download.ps1 -Url 'owner/repository' -OutputDir '.\downloads'
.\hf-download.ps1 -Connections 8
.\hf-download.ps1 -Aria2Path 'D:\Tools\aria2c.exe'
.\hf-download.ps1 -DisableIPv6  # retained for compatibility; IPv4-only is always enforced
```

If local execution policy blocks the script, use the included `.cmd` launcher, which sets a policy override for that process only. It does not change system policy.

## Configuration

| Option | Behavior |
| --- | --- |
| `-OutputDir` | Download root for this run; takes priority over other settings. |
| `HF_DOWNLOADER_OUTPUT` | Environment override for the download root. |
| Saved folder | Used when neither override is supplied. |
| First-run folder | Defaults to `Downloads\HuggingFace` under the current user's profile; you can choose another folder. |
| `-Connections` | Connections per file, from 1 to 16; default 16. |
| `-DisableIPv6` | Legacy compatibility switch. IPv4-only operation is always enforced. |
| `-Aria2Path` | Explicit executable path; otherwise checks `bin/`, PATH, and common Windows package locations. |
| `-SettingsPath` | Alternative settings JSON path, useful for a portable installation. |

Preferences live in `HuggingFaceDownloader\settings.json` under the current user's local application-data folder. They contain the chosen output directory and quantization, never authentication tokens. Remove the `outputDir` property to choose a new persistent folder on the next launch. Command-line and environment folder overrides are not saved.

For a portable settings file:

```powershell
.\hf-download.ps1 -SettingsPath '.\settings.local.json' -OutputDir '.\downloads'
```

Authentication checks `HF_TOKEN`, then legacy `HUGGING_FACE_HUB_TOKEN` / `HUGGINGFACE_TOKEN`, then the local token file. Token-file discovery respects `HF_TOKEN_PATH`, `HF_HOME`, and `XDG_CACHE_HOME`, with the standard user cache as fallback. Configure credentials locally; do not put them in the project. All aria2 requests explicitly disable IPv6; the desktop Settings page shows this as enforced.

## File selection and layout

Choose **Choose quantization**, select a bit level, then an exact variant such as `IQ3_XXS`, `IQ4_XS`, or `Q4_K_M`. Only recognized variants present in the listing appear. If multiple model bundles share a quantization, select the model too. Saving a preferred variant highlights it when available; it does not start a download automatically or silently substitute another quant.

The picker looks for separate vision (`mmproj`, `vision`, or `projector`) and MTP (`mtp`, `draft`, or `nextn`) files using prefixes and folder names. You can choose a companion variant when multiple exist. Folder links also check the repository root for companions. Review the filenames and final queue before starting.

Companion detection is a filename heuristic, not a compatibility check. Embedded MTP, companions hosted in other repositories, and unconventional names cannot be determined from the file listing. A main model with `-MTP-` in its name remains a main model. Use specific-file selection for other formats and naming conventions. Direct file links download that file without invoking the quantization picker.

Models retain the layout `download-root/owner/repository/path`. Datasets and Spaces use separate `datasets/` and `spaces/` directories. No destination depends on the project author's username or installed applications.

## Development

Run the offline test suite:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
npm test
npm run qa
```

Tests import function definitions without starting the downloader, mock user input and transfers, and use a checked-in repository listing fixture. They cover selection, split files, companions, preferences, output overrides, transfer options, and path validation. The UI smoke test checks the desktop structure, guidance panel, responsive layout, download controls, and security wiring without starting a GUI. `npm run qa:electron` is available for an interactive Playwright pass on machines with a working Electron inspector. No test downloads models. GitHub Actions runs the terminal tests under Windows PowerShell 5.1 and PowerShell 7.

Before publishing, choose a license and add a `LICENSE` file. No license is assigned by this scaffold.
