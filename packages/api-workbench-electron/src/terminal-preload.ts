import { contextBridge, ipcRenderer } from 'electron';
import type {
  TerminalEvent,
  TerminalHostBridge,
  TerminalBridge,
} from '@techieutils/api-workbench-common/types';

/**
 * The terminal window's bridge: its shells, and nothing else of the app's. The main process
 * answers these channels only for this window (`handleTerminal` in main.ts).
 */
const terminal: TerminalBridge = {
  start: (size, shell) => ipcRenderer.invoke('terminal:start', size, shell),
  shells: () => ipcRenderer.invoke('terminal:shells'),
  write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  stop: (id) => ipcRenderer.invoke('terminal:stop', id),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, update: TerminalEvent) => callback(update);
    ipcRenderer.on('terminal:event', listener);
    return () => ipcRenderer.removeListener('terminal:event', listener);
  },
};
const terminalHost: TerminalHostBridge = {
  preferences: () => ipcRenderer.invoke('terminal:preferences'),
  setDefaultShell: (shell) => ipcRenderer.invoke('terminal:set-default-shell', shell),
  takeStaged: () => ipcRenderer.invoke('terminal:take-staged'),
  expand: () => ipcRenderer.invoke('terminal:expand-self'),
  return: () => ipcRenderer.invoke('terminal:return-self'),
  onPlacement: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, where: 'panel' | 'window') =>
      callback(where);
    ipcRenderer.on('terminal:placement', listener);
    return () => ipcRenderer.removeListener('terminal:placement', listener);
  },
  onStaged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('terminal:staged', listener);
    return () => ipcRenderer.removeListener('terminal:staged', listener);
  },
  onTheme: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark') =>
      callback(theme);
    ipcRenderer.on('terminal:theme', listener);
    return () => ipcRenderer.removeListener('terminal:theme', listener);
  },
};
contextBridge.exposeInMainWorld('workbench', { terminal, terminalHost });
