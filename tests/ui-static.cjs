const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'desktop', name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const renderer = read('renderer.js');
const main = read('main.cjs');
const terminal = fs.readFileSync(path.join(root, 'hf-download.ps1'), 'utf8');
// Nothing shipped may carry the absolute path of whatever machine it was built on.
// Naming one developer's username caught only that person, and had to be split across
// an array so the check did not match its own source. This asserts the real invariant:
// no user-profile path from any platform, whoever did the build.
const personalPath = /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/"'\s]+|\/(?:home|Users)\/[A-Za-z0-9._-]+\//i;
for (const text of [html, css, renderer, main, terminal]) assert.equal(personalPath.test(text), false, 'A shipped file contains a developer machine path');
for (const required of [
  'New download', 'Downloads', 'Settings', 'Open terminal version', 'Download a model from Hugging Face',
  'A little guidance', 'Choose quantization', 'Choose specific files', 'Optional companions',
  'Review selected files', 'Download selected', 'download-progress', 'contextIsolation:true', 'sandbox:true', 'IPv4 only'
]) assert.ok((html + renderer + main).toLowerCase().includes(required.toLowerCase()), `Missing UI feature: ${required}`);

// The interface should describe what the app does, not sell it. These are the
// phrases that were removed; they should not drift back in.
for (const banned of [
  'made simple', 'effortless', 'seamless', 'powerful', 'blazing', 'supercharge',
  'unlock', 'game-changer', 'in seconds'
]) assert.equal((html + renderer + css).toLowerCase().includes(banned), false, `Marketing copy returned: ${banned}`);

// Toggle buttons must report their state, not just look pressed.
assert.ok(/aria-pressed=/.test(renderer), 'Selection-mode buttons need aria-pressed');
assert.ok(/aria-live/.test(renderer), 'Status updates need a live region');
assert.ok(/aria-label="Overall download progress"/.test(renderer), 'The progress bar needs a label');

// Companion files are matched on filename alone. The badge has to say so rather
// than implying the app checked that the companion actually fits the model.
assert.ok(/FILENAME MATCH/.test(renderer), 'Companion badge must say what was matched');
assert.ok(/not verified/i.test(renderer), 'Companion badge must disclaim verification');

// An unknown size is shown as unknown rather than as zero bytes.
assert.ok(/Unknown/.test(renderer), 'Unknown file sizes must be labelled');
for (const required of ['help-column', 'grid-template-columns:minmax(0,1fr) 235px', '@media(max-width:1150px)', '.review', '.companion']) assert.ok(css.includes(required), `Missing UI styling: ${required}`);
assert.ok(/data-help="repo"/.test(renderer) && /data-help="quant"/.test(renderer) && /data-help="companions"/.test(renderer) && /data-help="destination"/.test(renderer));
assert.ok(/onProgress\(job=>/.test(renderer));
assert.ok(/Content-Security-Policy/.test(html));
assert.ok(/--disable-ipv6=true/.test(terminal), 'Terminal must enforce IPv4-only transfers');

// The launcher's show-window style is load-bearing, not cosmetic: Windows hands
// it to Electron through STARTUPINFO, and SW_HIDE (0) starts the whole app with
// its window invisible - processes running, nothing on screen, no error.
const vbs = fs.readFileSync(path.join(root, 'Hugging Face Downloader.vbs'), 'utf8');
assert.ok(/SW_SHOWNORMAL\s*=\s*1/.test(vbs), 'The launcher must define SW_SHOWNORMAL');
assert.ok(/shell\.Run\s+.*,\s*SW_SHOWNORMAL\s*,/.test(vbs), 'The launcher must start Electron with a visible window');

// Updater wiring. An unsigned installer is only as trustworthy as the digest we
// can check it against, so none of these may quietly disappear.
const updater = read('updater.cjs');
const preload = read('preload.cjs');
assert.ok(/sha256/i.test(updater) && /failed its SHA-256 check/.test(updater), 'Updates must be SHA-256 verified');
assert.ok(/ASSET_HOSTS/.test(updater), 'Update downloads must be restricted to GitHub hosts');
assert.ok(/hostname !== 'api\.github\.com'/.test(updater), 'Update metadata must come only from api.github.com');
assert.ok(/PLACEHOLDER_OWNER/.test(updater) && /YOUR_GITHUB_USERNAME/.test(updater), 'An unconfigured build must not check for updates');
assert.ok(/install-update/.test(main) && /showMessageBox/.test(main), 'Installing an update must be confirmed');
assert.equal(/autoUpdater|autoInstall|quitAndInstall/.test(main + updater), false, 'Updates must never install themselves');
for (const required of ['checkUpdate', 'downloadUpdate', 'installUpdate', 'onUpdateState']) {
  assert.ok(preload.includes(required), `Preload is missing the ${required} bridge`);
}
assert.ok(/update-banner/.test(renderer) && /update-banner/.test(css), 'The update banner needs markup and styling');

console.log('PASS: desktop UI structure, guidance panel, responsive layout, launcher window style, download controls, updater safety, and security wiring.');
