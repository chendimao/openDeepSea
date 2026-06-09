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

interface Window {
  openDeepSeaDesktop?: {
    getDataDirectory: () => Promise<OpenDeepSeaDesktopDataDirectoryState>;
    chooseDataDirectory: () => Promise<OpenDeepSeaDesktopDataDirectoryPickResult>;
    resetDataDirectory: () => Promise<OpenDeepSeaDesktopDataDirectoryState>;
    clearData: () => Promise<{ ok: true }>;
    restartApp: () => Promise<{ ok: true }>;
  };
}
