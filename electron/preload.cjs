'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('statusline', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('statusline:get-snapshot'),
  refresh: () => ipcRenderer.invoke('statusline:refresh'),
  subscribe: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('statusline:snapshot', listener);
    return () => ipcRenderer.removeListener('statusline:snapshot', listener);
  },
  getPreferences: () => ipcRenderer.invoke('statusline:get-preferences'),
  getCapabilities: () => ipcRenderer.invoke('statusline:get-capabilities'),
  getClaudeIntegration: () => ipcRenderer.invoke('statusline:get-claude-integration'),
  connectClaude: () => ipcRenderer.invoke('statusline:connect-claude'),
  disconnectClaude: () => ipcRenderer.invoke('statusline:disconnect-claude'),
  setCompact: (value) => ipcRenderer.invoke('statusline:set-compact', value),
  setLayout: (value) => ipcRenderer.invoke('statusline:set-layout', value),
  setDetailsOpen: (value) => ipcRenderer.invoke('statusline:set-details-open', value),
  setTaskContextOpen: (value) => ipcRenderer.invoke('statusline:set-task-context-open', value),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('statusline:set-always-on-top', value),
  openProvider: (providerId) => ipcRenderer.invoke('statusline:open-provider', providerId),
  minimize: () => ipcRenderer.invoke('statusline:minimize'),
  startWindowDrag: (point) => ipcRenderer.invoke('statusline:start-window-drag', point),
  moveWindowDrag: (point) => ipcRenderer.invoke('statusline:move-window-drag', point),
  endWindowDrag: () => ipcRenderer.invoke('statusline:end-window-drag'),
  close: () => ipcRenderer.invoke('statusline:close'),
}));
