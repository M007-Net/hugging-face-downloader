# Security

## Reporting a problem

Report suspected security problems privately through this repository's
**Security** tab → **Report a vulnerability**. That opens a private advisory
visible only to the maintainers; please use it instead of a public issue, a pull
request, or a discussion thread.

Useful things to include: the version you were running, the steps that trigger
the problem, and what you expected to happen instead. If you have a link or a
repository that reproduces it, that helps a lot.

**Never include a Hugging Face token in a report.** If you think a token was
exposed, revoke it at https://huggingface.co/settings/tokens first, then tell us
how it was exposed.

Expect an acknowledgement within about a week. This is a small project without a
paid on-call rotation, so please do not expect an immediate response.

## What this tool does with your credentials

- A token is read from `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`,
  `HUGGINGFACE_TOKEN`, or the Hugging Face CLI token cache. The tool does not
  store its own copy.
- The token is sent to aria2 on **stdin**, never as a command-line argument and
  never through a temporary file. Command lines are readable by any other
  process on the machine; stdin is not.
- The token is attached only to requests to `huggingface.co`. Hugging Face
  answers a download with a redirect to a CDN, and the redirect is followed
  deliberately, with the authorization header dropped, so the CDN receives only
  the signed URL.
- Tokens containing control characters, or longer than 4096 characters, are
  rejected rather than escaped.

## What the tool checks before writing to disk

- Repository paths are validated against Windows naming rules before anything is
  created: no absolute paths, no `..`, no reserved device names (including
  `CONIN$`, `CONOUT$`, and the superscript `COM`/`LPT` forms), no trailing dots
  or spaces, and no path component over 255 characters.
- Files that would collide on Windows — by letter case, or by Unicode
  normalization — are skipped rather than silently overwriting one another.
- Downloads are written to a `.part` file and renamed only after the size and,
  where Hugging Face publishes one, the SHA-256 match. An existing file is
  reused only if it hashes to the expected digest.
- A listing is pinned to the commit it came from (`x-repo-commit`), so a branch
  that moves mid-download cannot swap the bytes underneath you.
- Metadata requests are pinned to IPv4 to match aria2's transfer settings.

## What the tool checks before offering an update

The installer is not code-signed, so an update is only as trustworthy as the
bytes that can be verified. The update path is built around that:

- Update metadata is fetched only from `api.github.com`, over HTTPS, with
  certificate validation on. No token or identifier is sent.
- An installer is only offered if the release notes publish its SHA-256. A
  release without a digest is never downloaded — the app links to the release
  page instead so you can check it yourself.
- A downloaded file is kept only if both its size and its SHA-256 match what the
  release published. Otherwise it is deleted immediately and the failure is
  reported.
- Downloads are accepted only from GitHub's own release hosts, and redirects are
  re-checked against that same list at every hop.
- **Nothing installs itself.** Checking, downloading, and running the installer
  are three separate user actions, and the last one is behind a confirmation
  dialog that names the version.
- A build with no repository configured in `package.json` never contacts the
  network at all.

## Scope

In scope: anything that lets a repository, a redirect, or a crafted link cause
this tool to write outside the destination folder, leak a token, or accept
unverified bytes as a finished download.

Out of scope: the contents of models you download, aria2 itself, Electron
itself, and the absence of an Authenticode signature on the Windows installer —
that last one is a known limitation, documented in the README.

## Known limitations

The Windows installer is **not** code-signed. SmartScreen will warn about it.
Verify the SHA-256 checksum published alongside a release before running it.
