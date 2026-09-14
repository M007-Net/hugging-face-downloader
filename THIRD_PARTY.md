# Third-party components

This project is released under the [MIT License](LICENSE). The components below
keep their own upstream licenses, which are unaffected by that.

## Not bundled — required at runtime

| Component | How it is obtained | License and source |
| --- | --- | --- |
| aria2 (`aria2c.exe`) | Not shipped with this project. The tool looks for it on `PATH` and in the usual install locations (winget, Chocolatey, Scoop, `Program Files`); if it is missing, it offers to install it through **winget** (`aria2.aria2`). No binary is downloaded directly by this project. | GPL-2.0-or-later, with an OpenSSL linking exception; https://github.com/aria2/aria2 |

aria2 does all of the actual transferring. This project only decides what to ask
for and checks what comes back, so aria2 is invoked as a separate process rather
than linked into anything here.

## Bundled in the desktop build

| Component | Version | License and source |
| --- | --- | --- |
| Electron | 44.3.0 | MIT for Electron itself; bundles Chromium (BSD-3-Clause and others) and Node.js (MIT). Upstream license notices are included in the packaged application. https://github.com/electron/electron |

The desktop application has **no runtime npm dependencies**. `package.json`
lists only development dependencies:

| Package | Version | Used for | License |
| --- | --- | --- | --- |
| electron | 44.3.0 | Running and packaging the desktop app | MIT |
| electron-builder | 26.15.3 | Building the Windows installer | MIT |
| playwright | ^1.55.0 | The optional `qa:electron` window smoke test | Apache-2.0 |

None of these are shipped inside the installer except Electron itself.

## Services contacted at runtime

| Service | When | What is sent |
| --- | --- | --- |
| `huggingface.co` | Listing a repository, probing file sizes, starting a download | A bearer token, if one is configured |
| Hugging Face CDN (`cdn-lfs*.huggingface.co` and similar) | Following a download redirect | The signed URL only. The authorization header is removed before the redirect is followed. |
| `api.github.com` | Update checks, if the build has a repository configured | Nothing but the request itself. No token, no identifier, no version reporting beyond what the URL implies. |
| `github.com` and `objects.githubusercontent.com` | Downloading an update installer, only after you click | Nothing but the request itself. |

Nothing else is contacted. There is no telemetry and no analytics. The update
check is the only outbound request not caused by something you asked for, it
runs once per launch, it is switched off unless a repository is configured in
`package.json`, and it never installs anything on its own.

## Reproducing the dependency set

Install with `npm ci` against the committed `package-lock.json`. If you
redistribute source or an installer, keep the bundled Electron license notices
in place.
