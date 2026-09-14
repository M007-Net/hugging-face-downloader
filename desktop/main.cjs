const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const core = require('./core.cjs');
const updater = require('./updater.cjs');
const manifest = require('../package.json');
const { Transfer } = require('./transfer.cjs');
const testing = !app.isPackaged && process.env.HFD_QA === '1';
if (testing) {
  // CI and restricted desktop sessions may not expose a usable GPU process.
  // Set this before ready so Chromium never starts the failing GPU subprocess.
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.setPath('userData', path.join(os.tmpdir(), `hfd-qa-${process.pid}`));
  app.disableHardwareAcceleration();
}
// app.quit() is asynchronous, so without this guard the rest of the module keeps
// running in the losing instance and can still put a second window on screen.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let window, currentCatalog, sessionToken = '', settings, settingsFile, lastJobFile;
// null until a check has run. `downloaded` holds the verified installer path, so
// installing is a second, separate click rather than something a check can cause.
let update = { state: 'idle', configured: !!updater.parseRepository(manifest.repository), error: '', result: null, downloaded: '', received: 0 };
const engine = new Transfer();
const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const defaults = { outputDir: path.join(os.homedir(),'Downloads','HuggingFace'), quant:'', connections:16, disableIPv6:true, aria2Path:'' };
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); } catch { return fallback; } }
function saveJSON(file, value) { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value,null,2)); fs.renameSync(file + '.tmp',file); }
// path.isAbsolute() alone says yes to "\\\\attacker.example\\share". Both mkdirSync and
// aria2's --dir would then touch that remote share, and Windows attempts NTLM against it
// without asking, handing the user's account name and a challenge response to whoever
// runs it. A download folder is a local drive.
function localDirectory(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  return /^[A-Za-z]:[\\/]/.test(value);
}
function cleanSettings(value = {}) {
  const outputDir = typeof value.outputDir === 'string' && localDirectory(value.outputDir) ? value.outputDir : defaults.outputDir;
  const connections = Number.isInteger(Number(value.connections)) && Number(value.connections) >= 1 && Number(value.connections) <= 16 ? Number(value.connections) : defaults.connections;
  return { outputDir, quant:typeof value.quant === 'string' ? value.quant.slice(0,128) : '', connections, disableIPv6:true, aria2Path:typeof value.aria2Path === 'string' ? value.aria2Path : '' };
}
function availableToken() { return core.validToken(sessionToken || core.readToken()); }
function status() {
  let aria = ''; let ariaError = ''; let tokenAvailable = false; let tokenError = '';
  try { aria = core.findAria(settings.aria2Path, root); } catch (e) { ariaError = e.message; }
  try { tokenAvailable = !!availableToken(); } catch (e) { tokenError = e.message; }
  return { settings, aria, ariaError, tokenAvailable, tokenError, job: engine.job, version:app.getVersion(), update };
}
function publishUpdate() { if (window && !window.isDestroyed()) window.webContents.send('update-state', update); }
async function runUpdateCheck() {
  if (!update.configured || update.state === 'checking' || update.state === 'downloading') return update;
  update = { ...update, state:'checking', error:'' }; publishUpdate();
  try {
    const result = await updater.checkForUpdate({ repository:manifest.repository, currentVersion:app.getVersion() });
    update = { ...update, state:'idle', result, error:'' };
  } catch (error) { update = { ...update, state:'idle', error:error.message }; }
  publishUpdate();
  return update;
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted request.');
    return fn(...args);
  });
}
if (primaryInstance) app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'),'settings.json'); lastJobFile = path.join(app.getPath('userData'),'last-download.json');
  settings = cleanSettings(readJSON(settingsFile,{}));
  if (!fs.existsSync(settingsFile) && !testing) {
    const terminalSettings = readJSON(path.join(process.env.LOCALAPPDATA || os.homedir(),'HuggingFaceDownloader','settings.json'),{});
    settings.outputDir = terminalSettings.outputDir || defaults.outputDir; settings.quant = terminalSettings.quant || '';
  }
  // readJSON only guards against an unparseable file. A job saved by a different
  // version can parse fine and still be the wrong shape, and anything thrown here
  // aborts the rest of this callback, leaving the app with no window at all. The
  // check used to look only at the top level, so a files array holding a null or a
  // {} passed it and then threw inside safePath on resume as a raw TypeError.
  const saved = readJSON(lastJobFile,null);
  const wellFormed = saved && Array.isArray(saved.files) && saved.files.length
    && typeof saved.destination === 'string' && saved.info && typeof saved.info === 'object'
    && saved.files.every(f => f && typeof f.path === 'string' && f.path && Number.isFinite(Number(f.size)));
  engine.job = wellFormed ? saved : null;
  if (engine.job && engine.job.status !== 'complete') { engine.job.status = 'paused'; engine.job.files.forEach(f => { if (f && f.status !== 'complete') f.status = 'waiting'; }); }
  const uiFile = path.join(__dirname,'index.html');
  // The .ico in build.win covers the installed executable and its shortcuts; this
  // covers the window and the taskbar button while the app is actually running, which
  // would otherwise show Electron's default. Missing in development is harmless.
  // Resolved from __dirname, not from `root`: build.files packs assets/ inside
  // app.asar, whereas `root` is the resources directory beside it, so joining from
  // there finds nothing once the app is packaged - and the guard below would hide it.
  const windowIcon = path.join(__dirname, '..', 'assets', 'icon.png');
  window = new BrowserWindow({ width:1360, height:950, minWidth:1000, minHeight:720, backgroundColor:'#101416', title:'Hugging Face Downloader', autoHideMenuBar:true, show:false,
    ...(fs.existsSync(windowIcon) ? { icon: windowIcon } : {}),
    webPreferences:{ preload:path.join(__dirname,'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true } });
  window.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(uiFile).href) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  window.loadFile(uiFile); window.once('ready-to-show', () => window.show());
  let closing = false;
  window.on('close', async event => {
    if (engine.busy && !closing) {
      event.preventDefault();
      const choice = await dialog.showMessageBox(window,{ type:'question', message:'Pause this app’s download and close?', detail:'Partial files stay on disk so you can resume later. Other downloaders are unaffected.', buttons:['Keep downloading','Pause and close'], defaultId:0, cancelId:0 });
      if (choice.response === 1) { closing = true; await engine.pause(); window.destroy(); }
    }
  });
  let lastSaved = 0;
  engine.on('update', job => {
    if (Date.now() - lastSaved > 2000 || !engine.busy) { saveJSON(lastJobFile, job); lastSaved = Date.now(); }
    if (!window.isDestroyed()) window.webContents.send('download-progress',job);
  });
  handle('status', () => status());
  handle('load-repo', async link => {
    if (engine.busy) throw new Error('Pause the current download before loading another repository.');
    currentCatalog = null;
    if (testing) { const info = core.parseLink(link); const files = readJSON(path.join(root,'tests','repository-fixture.json'),[]).filter(f => f.type === 'file'); currentCatalog = { ...core.catalog(info,files), allFiles:files }; }
    else currentCatalog = await core.listRepo(link, availableToken());
    const { allFiles, ...visible } = currentCatalog; return visible;
  });
  handle('choose-folder', async () => { const result = await dialog.showOpenDialog(window,{ properties:['openDirectory','createDirectory'], defaultPath:settings.outputDir }); return result.canceled ? '' : result.filePaths[0]; });
  handle('choose-aria', async () => { const result = await dialog.showOpenDialog(window,{ properties:['openFile'], filters:[{ name:'aria2 executable', extensions:['exe'] }] }); return result.canceled ? '' : result.filePaths[0]; });
  handle('lm-folder', () => path.join(os.homedir(),'.lmstudio','models'));
  handle('save-settings', value => {
    if (engine.busy) throw new Error('Pause the download before changing settings.');
    const next = { outputDir:String(value.outputDir || settings.outputDir), quant:String(value.quant ?? settings.quant).slice(0,128), connections:Number(value.connections ?? settings.connections), disableIPv6:true, aria2Path:String(value.aria2Path ?? settings.aria2Path) };
    if (!localDirectory(next.outputDir)) throw new Error('Choose a download folder on a local drive, starting with a drive letter such as C:\\.');
    if (!Number.isInteger(next.connections) || next.connections < 1 || next.connections > 16) throw new Error('Connections must be between 1 and 16.');
    if (next.aria2Path) core.findAria(next.aria2Path,root);
    if (typeof value.token === 'string') sessionToken = core.validToken(value.token);
    settings = next; saveJSON(settingsFile, settings); return status();
  });
  handle('start-download', selection => {
    if (testing) throw new Error('Downloads are disabled in UI tests.');
    if (!currentCatalog) throw new Error('Load a repository first.');
    const files = [...new Set(selection)].map(p => currentCatalog.allFiles.find(f => f.path === p));
    if (files.some(f => !f)) throw new Error('The file selection is no longer valid. Reload the repository.');
    const executable = core.findAria(settings.aria2Path,root); if (!executable) throw new Error('aria2 is not installed. Open Settings to choose it or view setup instructions.');
    const info = currentCatalog.info;
    const destination = path.join(settings.outputDir, ...(info.kind === 'models' ? [] : [info.kind]), ...info.repo.split('/'));
    return engine.start({ info, files, destination }, executable,settings,availableToken());
  });
  handle('pause-download', () => engine.pause());
  handle('resume-download', () => {
    if (testing) throw new Error('Downloads are disabled in UI tests.');
    if (!engine.job) throw new Error('No download to resume.');
    const executable = core.findAria(settings.aria2Path,root); if (!executable) throw new Error('Choose aria2 in Settings first.');
    return engine.start(engine.job,executable,settings,availableToken());
  });
  handle('open-folder', async () => { const folder = engine.job?.destination || settings.outputDir; fs.mkdirSync(folder,{recursive:true}); const error = await shell.openPath(folder); if (error) throw new Error(error); });
  handle('open-terminal', async () => { const file = path.join(app.isPackaged ? path.join(root,'terminal') : root,'HF Download.cmd'); const error = await shell.openPath(file); if (error) throw new Error(error); });
  handle('aria-help', () => shell.openExternal('https://github.com/aria2/aria2/releases'));
  handle('check-update', () => runUpdateCheck());
  handle('download-update', async () => {
    const asset = update.result?.asset;
    if (!asset) throw new Error('There is no verifiable installer to download for this release.');
    if (update.state === 'downloading') throw new Error('The update is already downloading.');
    update = { ...update, state:'downloading', error:'', received:0, downloaded:'' }; publishUpdate();
    try {
      const folder = path.join(app.getPath('userData'), 'updates');
      // Installers are ~90MB each. Keep only the one being fetched rather than
      // growing a pile of them in the user's profile.
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* in use; the download still works */ }
      // The asset name comes from GitHub, so it never becomes part of a path. Neither
      // does the version: it is server data too, and it is checked here as well as at
      // the parser, so a tag can never steer the write out of this folder.
      const version = String(update.result.version || '');
      if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new Error('That release advertises a version number this app will not turn into a filename.');
      const target = path.join(folder, `Hugging-Face-Downloader-Setup-${version}.exe`);
      if (path.dirname(path.resolve(target)) !== path.resolve(folder)) throw new Error('Refusing an update filename that points outside the updates folder.');
      let lastSent = 0;
      const saved = await updater.downloadAsset(asset, target, { onProgress: received => {
        if (Date.now() - lastSent < 250) return;
        lastSent = Date.now(); update = { ...update, received }; publishUpdate();
      } });
      update = { ...update, state:'ready', received:saved.size, downloaded:saved.path };
    } catch (error) { update = { ...update, state:'idle', received:0, downloaded:'', error:error.message }; publishUpdate(); throw error; }
    publishUpdate();
    return update;
  });
  handle('install-update', async () => {
    if (!update.downloaded) throw new Error('Download the update first.');
    if (engine.busy) throw new Error('Pause the current download before installing an update.');
    const choice = await dialog.showMessageBox(window, {
      type:'warning', message:'Install this update now?',
      detail:`The installer was verified against the SHA-256 published with release ${update.result?.version}. It is not code-signed, so Windows SmartScreen will still warn about it. This app will close so the installer can replace it.`,
      buttons:['Cancel','Run the installer'], defaultId:0, cancelId:0
    });
    if (choice.response !== 1) return update;
    // Checked again here, after the user has read the dialog and decided. Between the
    // download and this moment the file has been sitting at a predictable path.
    const expected = update.result?.asset?.sha256;
    const actual = await updater.hashFile(update.downloaded).catch(() => '');
    if (!expected || actual !== expected) {
      try { fs.rmSync(update.downloaded, { force: true }); } catch { /* already gone */ }
      update = { ...update, state:'idle', received:0, downloaded:'', error:'The downloaded installer changed after it was verified, so it was deleted. Check for the update again.' };
      publishUpdate();
      throw new Error('The downloaded installer no longer matches the published SHA-256. It was deleted rather than run.');
    }
    const error = await shell.openPath(update.downloaded);
    if (error) throw new Error(error);
    // The dialog above says this app closes, and NSIS cannot replace files that
    // are still open, so actually close. The delay lets the installer get far
    // enough to show its own window first.
    setTimeout(() => app.quit(), 1500);
    return update;
  });
  handle('open-release', async () => {
    const target = update.result?.releaseUrl;
    if (!target) throw new Error('No release page is known yet.');
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw new Error('Refusing to open an unexpected release address.');
    return shell.openExternal(parsed.toString());
  });
  handle('reveal-update', () => { if (update.downloaded) shell.showItemInFolder(update.downloaded); });
  // A failed startup check must never be fatal: it is reported in the UI
  // through `update.error` and the user can retry from Settings.
  if (update.configured && !testing) setTimeout(() => { runUpdateCheck().catch(() => {}); }, 2500);
}).catch(error => {
  // Without this the app would sit running with no window and no explanation.
  dialog.showErrorBox('Hugging Face Downloader could not start', String(error && error.stack || error));
  app.exit(1);
});
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
// Only the window-close dialog pauses the engine. Every other exit path - the
// last window closing, a session logout, Alt+F4 while idle - would otherwise
// leave the current aria2c child running in the background with a half-written
// .part file and no one watching it.
app.on('before-quit', () => { if (engine.child) { try { engine.child.kill(); } catch { /* already gone */ } } });
app.on('window-all-closed', () => app.quit());
