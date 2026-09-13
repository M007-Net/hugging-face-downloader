const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('downloader', {
  status:() => ipcRenderer.invoke('status'), loadRepo:link => ipcRenderer.invoke('load-repo',link),
  chooseFolder:() => ipcRenderer.invoke('choose-folder'), chooseAria:() => ipcRenderer.invoke('choose-aria'), lmFolder:() => ipcRenderer.invoke('lm-folder'),
  saveSettings:value => ipcRenderer.invoke('save-settings',value), start:files => ipcRenderer.invoke('start-download',files),
  pause:() => ipcRenderer.invoke('pause-download'), resume:() => ipcRenderer.invoke('resume-download'),
  openFolder:() => ipcRenderer.invoke('open-folder'), openTerminal:() => ipcRenderer.invoke('open-terminal'), ariaHelp:() => ipcRenderer.invoke('aria-help'),
  onProgress:callback => { const listener = (_event,job) => callback(job); ipcRenderer.on('download-progress',listener); return () => ipcRenderer.removeListener('download-progress',listener); }
});
