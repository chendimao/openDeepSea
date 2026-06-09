import { ipcRenderer } from 'electron';

const LOCAL_ACCESS_TOKEN_STORAGE_KEY = 'opendeepsea.localToken';
const RUNTIME_STORAGE_KEY = 'opendeepsea.runtime';
const TOKEN_CHANNEL = 'opendeepsea:get-local-token';

const token = readLocalToken();

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
