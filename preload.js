'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, arg) => ipcRenderer.invoke(ch, arg);
contextBridge.exposeInMainWorld('safe', {
  call,
  on: (channel, cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('safe:' + channel, fn);
    return () => ipcRenderer.removeListener('safe:' + channel, fn);
  },
});
