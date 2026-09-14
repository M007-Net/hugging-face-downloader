const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../desktop/core.cjs');

const B = String.fromCharCode(92); // backslash, kept out of literals

// A filename may legally contain bidirectional and zero-width formatting characters.
// They render as nothing, so "payload<RLO>gpj.exe" is displayed by this app, by Explorer
// and by every file dialog as "payloadexe.jpg" - a user who believes they picked an
// image runs a binary instead.
test('a filename cannot use text-direction characters to disguise its extension', () => {
  for (const name of ['payload\u202Egpj.exe', 'a\u200Bb.gguf', 'x\u2066y.gguf', '\uFEFFmodel.gguf', 'q\u200Fw.bin']) {
    assert.throws(() => core.safePath(name), /text-direction characters/, JSON.stringify(name));
    assert.equal(core.isSafePath(name), false);
  }
  // Ordinary non-ASCII names are not the problem and stay allowed.
  for (const name of ['mod\u00e8le-Q4.gguf', '\u6a21\u578b.gguf', '\u0645\u0646\u0648\u0630\u062c.gguf']) {
    assert.equal(core.safePath(name), name, name);
  }
});

// path.isAbsolute() says yes to a UNC share, and both mkdir and aria2's --dir would then
// reach out to it. Windows attempts NTLM against a remote share without asking, leaking
// the account name and a challenge response to whoever runs that host.
test('a download folder must be a local drive, not a UNC share', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
  const body = src.slice(src.indexOf('function localDirectory'), src.indexOf('function cleanSettings'));
  assert.ok(body, 'localDirectory must exist');
  const localDirectory = eval('(' + body.replace(/^function localDirectory/, 'function') + ')');

  assert.equal(localDirectory(`C:${B}Users${B}John Smith${B}Downloads`), true, 'a normal path with a space is fine');
  assert.equal(localDirectory('D:/Models'), true, 'forward slashes are fine');
  assert.equal(localDirectory(`${B}${B}attacker.example${B}share`), false, 'a UNC share is refused');
  assert.equal(localDirectory(`relative${B}path`), false, 'a relative path is refused');
  assert.equal(localDirectory(`C:${B}ok\u0001bad`), false, 'control characters are refused');
  assert.equal(localDirectory(''), false);
  assert.equal(localDirectory('C:'), false, 'a drive with no separator is not a folder');

  assert.ok(src.includes('localDirectory(next.outputDir)'), 'save-settings uses the same check');
});

// A listener writing last-download.json on every tick can fail for reasons unrelated to
// the transfer. That must not become a transfer failure, and it must never leave an aria2
// running with nothing referencing it.
test('a failing progress listener cannot fail the download or orphan aria2', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'transfer.cjs'), 'utf8');
  assert.match(src, /publish\(\)\s*\{\s*try\s*\{\s*this\.emit\('update'/, 'publish swallows listener errors');
  const perFile = src.slice(src.indexOf('} catch (error) {', src.indexOf('file.status = \'verifying\'')));
  assert.ok(perFile.includes('this.child.kill()'), 'the per-file catch kills the child before moving on');
});

// The repository owner and name become path segments of an api.github.com URL.
test('a repository name cannot contain dot segments', () => {
  const { parseRepository } = require('../desktop/updater.cjs');
  assert.equal(parseRepository('owner/..'), null);
  assert.equal(parseRepository('../repo'), null);
  assert.equal(parseRepository('./repo'), null);
  assert.deepEqual(parseRepository('owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseRepository('https://github.com/some.owner/some-repo.js'), { owner: 'some.owner', repo: 'some-repo.js' });
});

// Whatever the Settings field names is spawned. "Exists and ends in .exe" accepted a
// UNC path, so a pasted value could run a binary from another machine — and Windows
// would authenticate to that share on the way there.
test('the download engine must be a local executable, not a network one', () => {
  const { localExecutable, findAria } = require('../desktop/core.cjs');
  const B = String.fromCharCode(92);

  assert.equal(localExecutable(`C:${B}Tools${B}aria2${B}aria2c.exe`), true, 'an ordinary local path is fine');
  assert.equal(localExecutable('D:/tools/aria2c.exe'), true, 'forward slashes are fine');
  assert.equal(localExecutable(`C:${B}Program Files${B}aria2${B}aria2c.exe`), true, 'spaces are fine');

  assert.equal(localExecutable(`${B}${B}attacker.example${B}share${B}aria2c.exe`), false, 'UNC is refused');
  assert.equal(localExecutable('https://evil.example/aria2c.exe'), false, 'a URL is refused');
  assert.equal(localExecutable(`tools${B}aria2c.exe`), false, 'a relative path is refused');
  assert.equal(localExecutable(`C:${B}tools${B}..${B}..${B}aria2c.exe`), false, 'traversal is refused');
  assert.equal(localExecutable(`C:${B}tools${B}aria2c.bat`), false, 'only .exe is accepted');
  assert.equal(localExecutable(`C:${B}tools${B}a\u0001b.exe`), false, 'control characters are refused');
  assert.equal(localExecutable(''), false);

  // And the refusal happens before anything touches the filesystem or spawns.
  assert.throws(() => findAria(`${B}${B}attacker.example${B}share${B}aria2c.exe`, '.'), /local drive/);
});
