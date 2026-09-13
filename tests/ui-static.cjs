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
const personalPath = new RegExp([['mw','wood'].join(''), ['local','-ai'].join(''), ['be','-a-fool'].join('')].join('|'), 'i');
for (const text of [html, css, renderer, main, terminal]) assert.equal(personalPath.test(text), false, 'UI contains a personal path');
for (const required of [
  'New download', 'Downloads', 'Settings', 'Open terminal version', 'Your next model, made simple.',
  'A little guidance', 'Choose quantization', 'Choose specific files', 'Optional companions',
  'Review selected files', 'Download selected', 'download-progress', 'contextIsolation:true', 'sandbox:true', 'IPv4 only'
]) assert.ok((html + renderer + main).toLowerCase().includes(required.toLowerCase()), `Missing UI feature: ${required}`);
for (const required of ['help-column', 'grid-template-columns:minmax(0,1fr) 235px', '@media(max-width:1150px)', '.review', '.companion']) assert.ok(css.includes(required), `Missing UI styling: ${required}`);
assert.ok(/data-help="repo"/.test(renderer) && /data-help="quant"/.test(renderer) && /data-help="companions"/.test(renderer) && /data-help="destination"/.test(renderer));
assert.ok(/onProgress\(job=>/.test(renderer));
assert.ok(/Content-Security-Policy/.test(html));
assert.ok(/--disable-ipv6=true/.test(terminal), 'Terminal must enforce IPv4-only transfers');
console.log('PASS: desktop UI structure, guidance panel, responsive layout, download controls, and security wiring.');
