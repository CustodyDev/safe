'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, arg) => ipcRenderer.invoke(ch, arg);
contextBridge.exposeInMainWorld('safe', {
  call,
  control: (msg) => ipcRenderer.send('safe:control', msg),
  on: (channel, cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('safe:' + channel, fn);
    return () => ipcRenderer.removeListener('safe:' + channel, fn);
  },
});
