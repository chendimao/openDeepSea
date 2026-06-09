import { contextBridge, ipcRenderer } from 'electron';
import { DESKTOP_DATA_CHANNELS, type DesktopDataDirectoryPickResult, type DesktopDataDirectoryState } from './desktop-data';

const LOCAL_ACCESS_TOKEN_STORAGE_KEY = 'opendeepsea.localToken';
const RUNTIME_STORAGE_KEY = 'opendeepsea.runtime';
const TOKEN_CHANNEL = 'opendeepsea:get-local-token';
const DESKTOP_WINDOW_CHANNELS = {
  getWindowState: 'opendeepsea:get-window-state',
  minimizeWindow: 'opendeepsea:minimize-window',
  toggleMaximizeWindow: 'opendeepsea:toggle-maximize-window',
  closeWindow: 'opendeepsea:close-window',
  windowStateChanged: 'opendeepsea:window-state-changed',
} as const;

type DesktopWindowState = {
  isMaximized: boolean;
  isFullScreen: boolean;
};

const token = readLocalToken();

contextBridge.exposeInMainWorld('openDeepSeaDesktop', {
  platform: process.platform,
  getWindowState: () =>
    ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.getWindowState) as Promise<DesktopWindowState>,
  minimizeWindow: () =>
    ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.minimizeWindow) as Promise<DesktopWindowState>,
  toggleMaximizeWindow: () =>
    ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.toggleMaximizeWindow) as Promise<DesktopWindowState>,
  closeWindow: () =>
    ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.closeWindow) as Promise<{ ok: true }>,
  onWindowStateChanged: (listener: (state: DesktopWindowState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopWindowState) => listener(state);
    ipcRenderer.on(DESKTOP_WINDOW_CHANNELS.windowStateChanged, handler);
    return () => ipcRenderer.removeListener(DESKTOP_WINDOW_CHANNELS.windowStateChanged, handler);
  },
  getDataDirectory: () =>
    ipcRenderer.invoke(DESKTOP_DATA_CHANNELS.getDataDirectory) as Promise<DesktopDataDirectoryState>,
  chooseDataDirectory: () =>
    ipcRenderer.invoke(DESKTOP_DATA_CHANNELS.chooseDataDirectory) as Promise<DesktopDataDirectoryPickResult>,
  resetDataDirectory: () =>
    ipcRenderer.invoke(DESKTOP_DATA_CHANNELS.resetDataDirectory) as Promise<DesktopDataDirectoryState>,
  clearData: () =>
    ipcRenderer.invoke(DESKTOP_DATA_CHANNELS.clearData) as Promise<{ ok: true }>,
  restartApp: () =>
    ipcRenderer.invoke(DESKTOP_DATA_CHANNELS.restartApp) as Promise<{ ok: true }>,
});

try {
  if (token) {
    window.localStorage.setItem(LOCAL_ACCESS_TOKEN_STORAGE_KEY, token);
    window.localStorage.setItem(RUNTIME_STORAGE_KEY, 'desktop-local');
  }
} catch {
  // localStorage can be unavailable before the renderer has a stable origin.
}

function readLocalToken(): string | null {
  const value = ipcRenderer.sendSync(TOKEN_CHANNEL) as unknown;
  return typeof value === 'string' ? value.trim() || null : null;
}
