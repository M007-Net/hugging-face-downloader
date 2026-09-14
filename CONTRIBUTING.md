# Contributing

Thanks for taking a look. This is a small Windows tool with two front ends over
the same idea: a PowerShell script (`hf-download.ps1`) and an Electron app
(`desktop/`). Both hand the actual transfer to aria2.

## Getting set up

You need Node 20 or newer and Windows PowerShell 5.1 (which ships with Windows).
aria2 is fetched on first use if it is not already on `PATH`.

```
npm ci
```

## Running the tests

There are three suites, and all of them run offline — nothing in the test suite
touches the network or starts a download.

```
npm test
npm run test:terminal
npm run qa
```

- `npm test` covers `desktop/core.cjs` and `desktop/transfer.cjs`: link parsing,
  path safety, redirect handling, hash verification, and the transfer queue.
- `npm run test:terminal` runs the PowerShell suite against a stub that stands in
  for aria2c, so the transfer logic is exercised without downloading anything.
- `npm run qa` is a static check over the desktop UI: structure, security
  wiring, accessibility attributes, and the wording rules below.

`npm run qa:electron` additionally launches the packaged window through
Playwright. It needs the Electron binary, so it is not part of the default run.

## Things worth knowing before you change the transfer path

A few behaviours look like details and are not:

- **The token goes to aria2 on stdin.** Not on the command line (every process
  on the machine can read that) and not through a temp file (a killed run would
  leave it on disk). If you add an aria2 option, add it to the manifest.
- **Downloads land on `.part` first.** A file only gets its real name after its
  size and SHA-256 check out. If you make aria2 write straight to the final
  name, an interrupted run leaves something that later looks complete.
- **Every URL that comes back from the server gets re-checked.** Pagination
  links and redirects are attacker-influenced input; `Assert-HFUrl` and the
  origin check in `core.cjs` exist for that reason.
- **Windows filename rules are stricter than they look.** Reserved device names,
  trailing dots, case-insensitive collisions, and Unicode normalization
  collisions all have tests. Please keep them passing rather than loosening them.

## Wording

The UI should say what the app is doing. `npm run qa` fails the build on a list
of marketing words ("effortless", "seamless", "powerful", "in seconds", and so
on). Companion-file badges must keep saying that the match is on **filename
only** and that compatibility is not verified, because the app genuinely does not
check it.

## Pull requests

- One change per pull request, please.
- Add or update a test for anything that changes behaviour.
- Run all three suites before opening it, and say in the description what you
  ran and what the results were.
- No new runtime dependencies without a reason in the description. The desktop
  app ships with none.

## Reporting bugs

Use the issue templates. For anything with a security angle, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
