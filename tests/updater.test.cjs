const test = require('node:test');
const assert = require('node:assert');
const { parseRepository, parseVersion, compareVersions, digestFor, checkForUpdate, PLACEHOLDER_OWNER } = require('../desktop/updater.cjs');

const HASH = 'a'.repeat(64);
const release = (over = {}) => ({
  tag_name: 'v0.4.0', html_url: 'https://github.com/owner/repo/releases/tag/v0.4.0',
  body: `Setup.exe\n\nSHA-256: Hugging-Face-Downloader-Setup-0.4.0.exe  ${HASH}`,
  assets: [{ name: 'Hugging-Face-Downloader-Setup-0.4.0.exe', size: 90000000, browser_download_url: 'https://github.com/owner/repo/releases/download/v0.4.0/Hugging-Face-Downloader-Setup-0.4.0.exe' }],
  ...over
});
const check = (over, current = '0.3.0') => checkForUpdate({ repository: 'owner/repo', currentVersion: current, request: async () => release(over) });

test('the shipped placeholder repository leaves the updater switched off', async () => {
  assert.strictEqual(parseRepository({ url: `https://github.com/${PLACEHOLDER_OWNER}/hugging-face-downloader` }), null);
  assert.strictEqual(parseRepository(''), null);
  assert.strictEqual(parseRepository('not a repo'), null);
  assert.deepStrictEqual(parseRepository('git+https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepStrictEqual(parseRepository('owner/repo'), { owner: 'owner', repo: 'repo' });
  // An unconfigured build must not reach the network at all.
  const result = await checkForUpdate({ repository: undefined, currentVersion: '0.3.0', request: () => { throw new Error('should not be called'); } });
  assert.deepStrictEqual(result, { configured: false, available: false });
});

test('version comparison follows semver, including prereleases', () => {
  assert.ok(compareVersions('0.4.0', '0.3.0') > 0);
  assert.ok(compareVersions('v0.3.1', '0.3.0') > 0);
  assert.ok(compareVersions('0.3.0', '0.3.0') === 0);
  assert.ok(compareVersions('0.3.0', '0.4.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'numeric, not lexical');
  // A prerelease is older than its own release, so 0.4.0-beta.1 is not an
  // upgrade for someone already running 0.4.0.
  assert.ok(compareVersions('0.4.0-beta.1', '0.4.0') < 0);
  assert.ok(compareVersions('0.4.0', '0.4.0-beta.1') > 0);
  assert.ok(compareVersions('0.4.0-beta.2', '0.4.0-beta.1') > 0);
  assert.strictEqual(compareVersions('garbage', '0.3.0'), 0);
});

test('a digest is matched to its own filename in either published order', () => {
  assert.strictEqual(digestFor(`file.exe  ${HASH}`, 'file.exe'), HASH);
  assert.strictEqual(digestFor(`${HASH}  file.exe`, 'file.exe'), HASH);
  const b = 'b'.repeat(64);
  assert.strictEqual(digestFor(`other.exe ${HASH}\nfile.exe ${b}`, 'file.exe'), b, 'picks its own line, not the first hash present');
  assert.strictEqual(digestFor('no hash here', 'file.exe'), '');
});

test('an available release exposes a verifiable installer', async () => {
  const result = await check();
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.version, '0.4.0');
  assert.deepStrictEqual(result.asset, {
    name: 'Hugging-Face-Downloader-Setup-0.4.0.exe', size: 90000000,
    url: 'https://github.com/owner/repo/releases/download/v0.4.0/Hugging-Face-Downloader-Setup-0.4.0.exe', sha256: HASH
  });
});

test('the current version and older releases are not offered as updates', async () => {
  assert.strictEqual((await check({}, '0.4.0')).available, false);
  assert.strictEqual((await check({}, '0.5.0')).available, false);
  assert.strictEqual((await check({ draft: true })).available, false);
});

test('a release with no publishable digest offers the page, never a download', async () => {
  const result = await check({ body: 'Bug fixes.' });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.asset, null);
  assert.match(result.reason, /SHA-256/);
});

test('an installer hosted off GitHub is refused', async () => {
  const result = await check({ assets: [{ name: 'Setup.exe', size: 10, browser_download_url: 'https://evil.example.com/Setup.exe' }], body: `Setup.exe ${HASH}` });
  assert.strictEqual(result.asset, null);
  assert.match(result.reason, /will not download from/);
});

test('blockmaps and non-installer assets are never selected', async () => {
  const result = await check({
    assets: [
      { name: 'Setup.exe.blockmap', size: 10, browser_download_url: 'https://github.com/owner/repo/x.blockmap' },
      { name: 'notes.txt', size: 10, browser_download_url: 'https://github.com/owner/repo/notes.txt' }
    ]
  });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.asset, null);
  assert.match(result.reason, /no Windows installer/);
});

test('an unusable release listing is reported rather than trusted', async () => {
  await assert.rejects(() => checkForUpdate({ repository: 'owner/repo', currentVersion: '0.3.0', request: async () => [] }), /unexpected release listing/i);
  await assert.rejects(() => check({ tag_name: 'nightly', name: '' }), /recognizable version number/i);
});

// The version regex used to be unanchored, so a tag could carry path separators past a
// valid-looking "0.9.0-" prefix and steer the installer write out of the updates folder
// and into, for example, the per-user Startup folder. The SHA-256 gate does not help:
// an attacker who controls the release also controls the notes the digest is read from.
test('a release tag cannot smuggle a path into the version', () => {
  const traversal = '0.9.0-x/../../../Microsoft/Windows/Start Menu/Programs/Startup/payload';
  assert.strictEqual(parseVersion(traversal), null, 'a tag containing a path is not a version');
  for (const bad of ['1.0.0/../evil', '1.0.0\..\evil', '1.0.0-a/b', '1.0.0 rm -rf', '1.0.0:stream', '1.0.0\u0000']) {
    assert.strictEqual(parseVersion(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  // Ordinary versions still parse, including prereleases and a leading v.
  for (const good of ['1.0.0', 'v2.3.4', '0.3.0-rc.1', '10.20.30-beta.2']) {
    assert.ok(parseVersion(good), `accepted: ${good}`);
  }
  // And the download path builder refuses anything that is not filename-shaped.
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  assert.ok(main.includes('.test(version))'), 'main.cjs constrains the version before it becomes a filename');
  assert.ok(main.includes('Refusing an update filename that points outside'), 'main.cjs confirms the resolved path stays in the updates folder');
});

// The digest is taken as the bytes arrive; the user then reads a dialog and decides.
// The file sits at a predictable path in the meantime, so it is read again at launch.
test('the installer is re-hashed at the moment it is launched', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /updater\.hashFile\(update\.downloaded\)/, 'install-update re-reads the file');
  assert.match(main, /actual !== expected/, 'and compares it against the published digest');
  assert.ok(main.indexOf('choice.response !== 1') < main.indexOf('updater.hashFile'), 'the re-check happens after the user confirms');
});
