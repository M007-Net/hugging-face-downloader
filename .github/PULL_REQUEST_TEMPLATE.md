## What this changes

<!-- One or two sentences. What was wrong, or what is new. -->

## Why

<!-- If it fixes an issue, link it: Fixes #123 -->

## Tests

Which suites did you run, and what did they say?

- [ ] `npm test`
- [ ] `npm run test:terminal`
- [ ] `npm run qa`

<!-- Paste the counts, e.g. "18 passing / 134 checks / PASS". -->

## If this touches the transfer path

- [ ] The Hugging Face token still reaches aria2 only through the stdin manifest
- [ ] Downloads still land on `.part` and are renamed only after verification
- [ ] URLs that come back from the server are still re-validated before use
- [ ] Windows filename rules are unchanged, or the new rule has a test

## If this touches the interface

- [ ] Copy describes what the app does rather than selling it
- [ ] Companion badges still say the match is on filename only and unverified
- [ ] Interactive controls still report their state (`aria-pressed` and friends)

## Anything reviewers should look at closely

<!-- Trade-offs, things you were unsure about, things you deliberately left out. -->
