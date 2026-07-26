/**
 * Strict IPC bridge exposed to the renderer as `window.edge`.
 *
 * Every method is a thin wrapper over an `ipcMain.handle` in `main.cjs`.
 * The renderer NEVER gets a `Node` handle, a filesystem handle, or a
 * child-process handle — the only surface it can reach is what we list here.
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  workstation: {
    read: () => ipcRenderer.invoke('workstation:read'),
    write: (payload) => ipcRenderer.invoke('workstation:write', payload),
    clear: () => ipcRenderer.invoke('workstation:clear'),
  },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    write: (next) => ipcRenderer.invoke('settings:write', next),
  },
  agent: {
    start: () => ipcRenderer.invoke('agent:start'),
    stop: () => ipcRenderer.invoke('agent:stop'),
    status: () => ipcRenderer.invoke('agent:status'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('edge', api);
