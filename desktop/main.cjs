const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const core = require('./core.cjs');
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
if (!app.requestSingleInstanceLock()) app.quit();
let window, currentCatalog, sessionToken = '', settings, settingsFile, lastJobFile;
const engine = new Transfer();
const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const defaults = { outputDir: path.join(os.homedir(),'Downloads','HuggingFace'), quant:'', connections:16, disableIPv6:true, aria2Path:'' };
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); } catch { return fallback; } }
function saveJSON(file, value) { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value,null,2)); fs.renameSync(file + '.tmp',file); }
function status() {
  let aria = ''; let ariaError = '';
  try { aria = core.findAria(settings.aria2Path, root); } catch (e) { ariaError = e.message; }
  return { settings, aria, ariaError, tokenAvailable: !!(sessionToken || core.readToken()), job: engine.job, version:app.getVersion() };
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted request.');
    return fn(...args);
  });
}
app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'),'settings.json'); lastJobFile = path.join(app.getPath('userData'),'last-download.json');
  settings = { ...defaults, ...readJSON(settingsFile,{}) };
  settings.disableIPv6 = true;
  if (!fs.existsSync(settingsFile) && !testing) {
    const terminalSettings = readJSON(path.join(process.env.LOCALAPPDATA || os.homedir(),'HuggingFaceDownloader','settings.json'),{});
    settings.outputDir = terminalSettings.outputDir || defaults.outputDir; settings.quant = terminalSettings.quant || '';
  }
  engine.job = readJSON(lastJobFile,null);
  if (engine.job && engine.job.status !== 'complete') { engine.job.status = 'paused'; engine.job.files.forEach(f => { if (f.status !== 'complete') f.status = 'waiting'; }); }
  const uiFile = path.join(__dirname,'index.html');
  window = new BrowserWindow({ width:1360, height:950, minWidth:1000, minHeight:720, backgroundColor:'#101416', title:'Hugging Face Downloader', autoHideMenuBar:true, show:false,
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
    else currentCatalog = await core.listRepo(link, sessionToken || core.readToken());
    const { allFiles, ...visible } = currentCatalog; return visible;
  });
  handle('choose-folder', async () => { const result = await dialog.showOpenDialog(window,{ properties:['openDirectory','createDirectory'], defaultPath:settings.outputDir }); return result.canceled ? '' : result.filePaths[0]; });
  handle('choose-aria', async () => { const result = await dialog.showOpenDialog(window,{ properties:['openFile'], filters:[{ name:'aria2 executable', extensions:['exe'] }] }); return result.canceled ? '' : result.filePaths[0]; });
  handle('lm-folder', () => path.join(os.homedir(),'.lmstudio','models'));
  handle('save-settings', value => {
    if (engine.busy) throw new Error('Pause the download before changing settings.');
    const next = { outputDir:String(value.outputDir || settings.outputDir), quant:String(value.quant ?? settings.quant), connections:Number(value.connections ?? settings.connections), disableIPv6:true, aria2Path:String(value.aria2Path ?? settings.aria2Path) };
    if (!path.isAbsolute(next.outputDir)) throw new Error('Choose an absolute download folder.');
    if (!Number.isInteger(next.connections) || next.connections < 1 || next.connections > 16) throw new Error('Connections must be between 1 and 16.');
    if (next.aria2Path) core.findAria(next.aria2Path,root);
    if (typeof value.token === 'string') { if (/[\r\n]/.test(value.token)) throw new Error('Invalid token.'); sessionToken = value.token.trim(); }
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
    return engine.start({ info, files, destination }, executable,settings,sessionToken || core.readToken());
  });
  handle('pause-download', () => engine.pause());
  handle('resume-download', () => {
    if (testing) throw new Error('Downloads are disabled in UI tests.');
    if (!engine.job) throw new Error('No download to resume.');
    const executable = core.findAria(settings.aria2Path,root); if (!executable) throw new Error('Choose aria2 in Settings first.');
    return engine.start(engine.job,executable,settings,sessionToken || core.readToken());
  });
  handle('open-folder', async () => { const folder = engine.job?.destination || settings.outputDir; fs.mkdirSync(folder,{recursive:true}); const error = await shell.openPath(folder); if (error) throw new Error(error); });
  handle('open-terminal', async () => { const file = path.join(app.isPackaged ? path.join(root,'terminal') : root,'HF Download.cmd'); const error = await shell.openPath(file); if (error) throw new Error(error); });
  handle('aria-help', () => shell.openExternal('https://github.com/aria2/aria2/releases'));
});
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
