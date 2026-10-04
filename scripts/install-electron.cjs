// Fetches the Electron runtime after `npm install`.
//
// Electron 44 ships no `postinstall` script of its own - it exposes an
// `install-electron` bin and expects to be asked. So `npm install` unpacks the
// package (a few MB of JavaScript and type definitions) and stops there:
// `node_modules/electron/dist` never appears, and every launcher in this repo
// reports "Desktop dependencies are not installed yet" on a tree where
// `npm install` had just succeeded. The advice in that message - run
// `npm install` - was then the one thing that could not fix it.
//
// This also restores the meaning of ELECTRON_SKIP_BINARY_DOWNLOAD. Electron's
// own install.js does not read that variable, and CI sets it precisely to stay
// off the ~250MB download, because the suites that run there never open a
// window. Honouring it here keeps CI fast while a developer machine still ends
// up with an app that actually starts.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const skip = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
if (skip && skip !== '0' && skip !== 'false') {
  console.log('ELECTRON_SKIP_BINARY_DOWNLOAD is set: leaving the Electron runtime out.');
  process.exit(0);
}

// `npm install --omit=dev` on this project installs nothing at all, since every
// dependency here is a development one. That is a valid state, not a failure.
const installer = path.join(__dirname, '..', 'node_modules', 'electron', 'install.js');
if (!fs.existsSync(installer)) {
  console.log('Electron is not installed in this tree: nothing to fetch.');
  process.exit(0);
}

// install.js is written to be run, not imported: it exits 0 by itself when the
// dist already matches the requested version, so repeat installs cost nothing.
require(installer);
