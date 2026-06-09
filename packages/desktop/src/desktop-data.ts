import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR_MARKER_FILE = '.opendeepsea-data-dir.json';
export const DESKTOP_DATA_CHANNELS = {
  getDataDirectory: 'opendeepsea:get-data-directory',
  chooseDataDirectory: 'opendeepsea:choose-data-directory',
  resetDataDirectory: 'opendeepsea:reset-data-directory',
  clearData: 'opendeepsea:clear-data',
  restartApp: 'opendeepsea:restart-app',
} as const;

type DesktopSettingsFile = {
  dataDir?: string | null;
};

export type DesktopDataDirectoryState = {
  activeDataDir: string;
  defaultDataDir: string;
  pendingDataDir: string | null;
  requiresRestart: boolean;
  canClearData: boolean;
};

export type DesktopDataDirectoryPickResult =
  | { canceled: true; state: DesktopDataDirectoryState }
  | { canceled: false; path: string; state: DesktopDataDirectoryState };

export type DesktopDataManager = {
  getState(): Promise<DesktopDataDirectoryState>;
  setDataDirectory(path: string): Promise<DesktopDataDirectoryState>;
  resetDataDirectory(): Promise<DesktopDataDirectoryState>;
  ensureActiveDataDirectory(): Promise<string>;
  clearActiveDataDirectory(): Promise<void>;
};

export function createDesktopDataManager(options: {
  userDataDir: string;
  activeDataDir?: string;
}): DesktopDataManager {
  const userDataDir = resolve(options.userDataDir);
  const defaultDataDir = join(userDataDir, 'data');
  const settingsPath = join(userDataDir, 'desktop-settings.json');
  const initialConfiguredDataDir = readConfiguredDataDir(settingsPath, userDataDir);
  const activeDataDir = resolve(options.activeDataDir ?? initialConfiguredDataDir ?? defaultDataDir);

  async function getState(): Promise<DesktopDataDirectoryState> {
    const configuredDataDir = readConfiguredDataDir(settingsPath, userDataDir) ?? defaultDataDir;
    const pendingDataDir = configuredDataDir === activeDataDir ? null : configuredDataDir;
    return {
      activeDataDir,
      defaultDataDir,
      pendingDataDir,
      requiresRestart: pendingDataDir !== null,
      canClearData: await hasValidMarker(activeDataDir),
    };
  }

  async function setDataDirectory(path: string): Promise<DesktopDataDirectoryState> {
    const nextDataDir = normalizeDataDirectory(path, userDataDir);
    await ensureMarkedDataDirectory(nextDataDir, { allowMarkNonEmpty: nextDataDir === defaultDataDir });
    await writeSettings(settingsPath, { dataDir: nextDataDir === defaultDataDir ? null : nextDataDir });
    return getState();
  }

  async function resetDataDirectory(): Promise<DesktopDataDirectoryState> {
    await ensureMarkedDataDirectory(defaultDataDir, { allowMarkNonEmpty: true });
    await writeSettings(settingsPath, { dataDir: null });
    return getState();
  }

  async function ensureActiveDataDirectory(): Promise<string> {
    await ensureMarkedDataDirectory(activeDataDir, { allowMarkNonEmpty: activeDataDir === defaultDataDir });
    return activeDataDir;
  }

  async function clearActiveDataDirectory(): Promise<void> {
    if (!(await hasValidMarker(activeDataDir))) {
      throw new Error(`Refusing to clear data directory without ${DATA_DIR_MARKER_FILE} marker`);
    }
    const entries = await readdir(activeDataDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.name !== DATA_DIR_MARKER_FILE)
      .map((entry) => rm(join(activeDataDir, entry.name), { recursive: true, force: true })));
    await writeMarker(activeDataDir);
  }

  return {
    getState,
    setDataDirectory,
    resetDataDirectory,
    ensureActiveDataDirectory,
    clearActiveDataDirectory,
  };
}

export function isUnsafeDataDirectory(path: string, userDataDir: string): boolean {
  const candidate = resolve(path);
  const appDataDir = resolve(userDataDir);
  if (!isAbsolute(path)) return true;
  if (candidate === parse(candidate).root) return true;
  if (candidate === resolve(homedir())) return true;
  if (candidate === appDataDir) return true;
  return false;
}

function normalizeDataDirectory(path: string, userDataDir: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('data directory is required');
  if (isUnsafeDataDirectory(trimmed, userDataDir)) {
    throw new Error('unsafe data directory');
  }
  return resolve(trimmed);
}

function readConfiguredDataDir(settingsPath: string, userDataDir: string): string | null {
  if (!existsSync(settingsPath)) return null;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as DesktopSettingsFile;
    const configured = settings.dataDir?.trim();
    if (!configured) return null;
    if (isUnsafeDataDirectory(configured, userDataDir)) return null;
    return resolve(configured);
  } catch {
    return null;
  }
}

async function writeSettings(settingsPath: string, settings: DesktopSettingsFile): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function ensureMarkedDataDirectory(
  dataDir: string,
  options: { allowMarkNonEmpty: boolean },
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  if (await hasValidMarker(dataDir)) return;
  const entries = await readdir(dataDir);
  if (!options.allowMarkNonEmpty && entries.length > 0) {
    throw new Error('custom data directory must be empty or already contain an OpenDeepSea marker');
  }
  await writeMarker(dataDir);
}

async function hasValidMarker(dataDir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(dataDir, DATA_DIR_MARKER_FILE), 'utf8')) as {
      app?: unknown;
      marker?: unknown;
    };
    return marker.app === 'OpenDeepSea' && marker.marker === 'opendeepsea-data-directory';
  } catch {
    return false;
  }
}

async function writeMarker(dataDir: string): Promise<void> {
  await writeFile(join(dataDir, DATA_DIR_MARKER_FILE), `${JSON.stringify({
    app: 'OpenDeepSea',
    marker: 'opendeepsea-data-directory',
    version: 1,
  }, null, 2)}\n`, 'utf8');
}
