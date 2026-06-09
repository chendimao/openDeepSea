/// <reference types="vite/client" />

declare module '*.css';

type OpenDeepSeaDesktopDataDirectoryState = {
  activeDataDir: string;
  defaultDataDir: string;
  pendingDataDir: string | null;
  requiresRestart: boolean;
  canClearData: boolean;
};

type OpenDeepSeaDesktopDataDirectoryPickResult =
  | { canceled: true; state: OpenDeepSeaDesktopDataDirectoryState }
  | { canceled: false; path: string; state: OpenDeepSeaDesktopDataDirectoryState };

type OpenDeepSeaDesktopPlatform = 'darwin' | 'win32' | 'linux' | string;

type OpenDeepSeaDesktopWindowState = {
  isMaximized: boolean;
  isFullScreen: boolean;
};

interface Window {
  openDeepSeaDesktop?: {
    platform?: OpenDeepSeaDesktopPlatform;
    getWindowState?: () => Promise<OpenDeepSeaDesktopWindowState>;
    minimizeWindow?: () => Promise<OpenDeepSeaDesktopWindowState>;
    toggleMaximizeWindow?: () => Promise<OpenDeepSeaDesktopWindowState>;
    closeWindow?: () => Promise<{ ok: true }>;
    onWindowStateChanged?: (listener: (state: OpenDeepSeaDesktopWindowState) => void) => () => void;
    getDataDirectory: () => Promise<OpenDeepSeaDesktopDataDirectoryState>;
    chooseDataDirectory: () => Promise<OpenDeepSeaDesktopDataDirectoryPickResult>;
    resetDataDirectory: () => Promise<OpenDeepSeaDesktopDataDirectoryState>;
    clearData: () => Promise<{ ok: true }>;
    restartApp: () => Promise<{ ok: true }>;
  };
}
