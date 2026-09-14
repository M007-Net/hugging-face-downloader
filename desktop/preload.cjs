const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('downloader', {
  status:() => ipcRenderer.invoke('status'), loadRepo:link => ipcRenderer.invoke('load-repo',link),
  chooseFolder:() => ipcRenderer.invoke('choose-folder'), chooseAria:() => ipcRenderer.invoke('choose-aria'), lmFolder:() => ipcRenderer.invoke('lm-folder'),
  saveSettings:value => ipcRenderer.invoke('save-settings',value), start:files => ipcRenderer.invoke('start-download',files),
  pause:() => ipcRenderer.invoke('pause-download'), resume:() => ipcRenderer.invoke('resume-download'),
  openFolder:() => ipcRenderer.invoke('open-folder'), openTerminal:() => ipcRenderer.invoke('open-terminal'), ariaHelp:() => ipcRenderer.invoke('aria-help'),
  checkUpdate:() => ipcRenderer.invoke('check-update'), downloadUpdate:() => ipcRenderer.invoke('download-update'),
  installUpdate:() => ipcRenderer.invoke('install-update'), openRelease:() => ipcRenderer.invoke('open-release'), revealUpdate:() => ipcRenderer.invoke('reveal-update'),
  onProgress:callback => { const listener = (_event,job) => callback(job); ipcRenderer.on('download-progress',listener); return () => ipcRenderer.removeListener('download-progress',listener); },
  onUpdateState:callback => { const listener = (_event,value) => callback(value); ipcRenderer.on('update-state',listener); return () => ipcRenderer.removeListener('update-state',listener); }
});
