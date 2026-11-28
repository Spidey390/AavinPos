const { contextBridge, ipcRenderer } = require('electron');
// No generic IPC, filesystem, shell or network access reaches the renderer.
contextBridge.exposeInMainWorld('counter', Object.freeze(Object.fromEntries(
  ['view', 'configure', 'signIn', 'unlock', 'lock', 'checkout', 'acknowledge', 'retry', 'print', 'onlineWorkspace', 'backup'].map(name => [name, data => ipcRenderer.invoke(`counter:${name}`, data)])
)));
