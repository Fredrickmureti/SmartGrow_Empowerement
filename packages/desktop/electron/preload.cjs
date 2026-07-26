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
    logs: () => ipcRenderer.invoke('agent:logs'),
    // Loopback pairing material for browsers on this machine. Distinct from
    // the cloud workstation secret — see main.cjs for the rationale.
    pairing: () => ipcRenderer.invoke('agent:pairing'),
    rotateToken: () => ipcRenderer.invoke('agent:rotateToken'),
    // Phase 4.2.4 — signed probe dispatch. The renderer sends a probe
    // descriptor (deviceId/role/op/target); main injects the bearer token
    // from ~/.pos-agent-token so the raw secret never touches the DOM.
    probe: (payload) => ipcRenderer.invoke('agent:probe', payload),
  },
  supervisor: {
    status: () => ipcRenderer.invoke('supervisor:status'),
    ping: () => ipcRenderer.invoke('supervisor:ping'),
    reload: () => ipcRenderer.invoke('supervisor:reload'),
    shutdown: () => ipcRenderer.invoke('supervisor:shutdown'),
    install: () => ipcRenderer.invoke('supervisor:install'),
    uninstall: () => ipcRenderer.invoke('supervisor:uninstall'),
    start: () => ipcRenderer.invoke('supervisor:start'),
    stop: () => ipcRenderer.invoke('supervisor:stop'),
    // Reports whether a platform service is installed/running, and whether
    // the installer script shipped with this build at all.
    serviceStatus: () => ipcRenderer.invoke('supervisor:serviceStatus'),
    // Phase 4.2.7 — loopback certificate lifecycle. The renderer only ever
    // asks; the privileged trust-store commands run inside the agent.
    certStatus: () => ipcRenderer.invoke('supervisor:certStatus'),
    rotateCert: () => ipcRenderer.invoke('supervisor:rotateCert'),
    installCert: () => ipcRenderer.invoke('supervisor:installCert'),
    uninstallCert: () => ipcRenderer.invoke('supervisor:uninstallCert'),
  },
  updates: {
    // Read-only channel check (Phase 4.2.8). No download, no execution.
    check: (opts) => ipcRenderer.invoke('updates:check', opts ?? {}),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('edge', api);
