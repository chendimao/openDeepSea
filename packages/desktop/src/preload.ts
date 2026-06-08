const LOCAL_ACCESS_TOKEN_STORAGE_KEY = 'opendeepsea.localToken';
const RUNTIME_STORAGE_KEY = 'opendeepsea.runtime';
const TOKEN_ARG_PREFIX = '--opendeepsea-local-token=';

const tokenArg = process.argv.find((arg) => arg.startsWith(TOKEN_ARG_PREFIX));
const token = tokenArg?.slice(TOKEN_ARG_PREFIX.length).trim();

try {
  if (token) {
    window.localStorage.setItem(LOCAL_ACCESS_TOKEN_STORAGE_KEY, token);
    window.localStorage.setItem(RUNTIME_STORAGE_KEY, 'desktop-local');
  }
} catch {
  // localStorage can be unavailable before the renderer has a stable origin.
}
