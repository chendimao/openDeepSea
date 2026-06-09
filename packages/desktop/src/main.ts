import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { WriteStream } from 'node:fs';
import {
  createDesktopDataManager,
  DESKTOP_DATA_CHANNELS,
  type DesktopDataManager,
  type DesktopDataDirectoryPickResult,
} from './desktop-data';

type BackendLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type BackendRuntime = {
  baseUrl: string;
  localToken: string;
  process: BackendProcess;
  logStream: WriteStream;
};

type BackendProcess = ChildProcessByStdio<null, Readable, Readable>;

const isDev = process.env.OPENDEEPSEA_DESKTOP_DEV === '1';
const LOCAL_TOKEN_CHANNEL = 'opendeepsea:get-local-token';
let mainWindow: BrowserWindow | null = null;
let backendRuntime: BackendRuntime | null = null;
let desktopDataManager: DesktopDataManager | null = null;
let isQuitting = false;
let suppressBackendExitDialog = false;

ipcMain.on(LOCAL_TOKEN_CHANNEL, (event) => {
  event.returnValue = backendRuntime?.localToken ?? '';
});
ipcMain.handle(DESKTOP_DATA_CHANNELS.getDataDirectory, async () => {
  return getDesktopDataManager().getState();
});
ipcMain.handle(DESKTOP_DATA_CHANNELS.chooseDataDirectory, async (): Promise<DesktopDataDirectoryPickResult> => {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, {
      title: '选择 OpenDeepSea 数据目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    : await dialog.showOpenDialog({
      title: '选择 OpenDeepSea 数据目录',
      properties: ['openDirectory', 'createDirectory'],
    });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, state: await getDesktopDataManager().getState() };
  }
  const selectedPath = result.filePaths[0];
  return {
    canceled: false,
    path: selectedPath,
    state: await getDesktopDataManager().setDataDirectory(selectedPath),
  };
});
ipcMain.handle(DESKTOP_DATA_CHANNELS.resetDataDirectory, async () => {
  return getDesktopDataManager().resetDataDirectory();
});
ipcMain.handle(DESKTOP_DATA_CHANNELS.clearData, async () => {
  await clearDesktopDataAndRelaunch();
  return { ok: true };
});
ipcMain.handle(DESKTOP_DATA_CHANNELS.restartApp, async () => {
  relaunchApp();
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void startDesktopApp();
}

async function startDesktopApp(): Promise<void> {
  try {
    await app.whenReady();
    desktopDataManager = createDesktopDataManager({ userDataDir: app.getPath('userData') });
    backendRuntime = await startBackend();
    mainWindow = createMainWindow();
    await loadRenderer(mainWindow, backendRuntime.baseUrl);
  } catch (err) {
    dialog.showErrorBox('OpenDeepSea 启动失败', (err as Error).message);
    app.quit();
  }
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendRuntime) {
    mainWindow = createMainWindow();
    void loadRenderer(mainWindow, backendRuntime.baseUrl);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  void stopBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    title: 'OpenDeepSea',
    show: false,
    backgroundColor: '#05070a',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

async function loadRenderer(win: BrowserWindow, backendBaseUrl: string): Promise<void> {
  const rendererUrl = isDev
    ? process.env.OPENDEEPSEA_DESKTOP_FRONTEND_URL?.trim() || 'http://localhost:5173'
    : backendBaseUrl;
  const attempts = isDev ? 80 : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await win.loadURL(rendererUrl);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      await delay(250);
    }
  }
}

async function startBackend(): Promise<BackendRuntime> {
  const port = isDev ? getDevBackendPort() : await findFreePort();
  const localToken = getDesktopLocalToken();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await getDesktopDataManager().ensureActiveDataDirectory();
  const launch = buildBackendLaunch(port, localToken, dataDir);
  const logStream = createBackendLogStream();
  let suppressExitDialog = false;
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const childError = new Promise<never>((_resolve, reject) => {
    child.once('error', (err) => {
      writeBackendLog(logStream, `\n[desktop] backend spawn error: ${(err as Error).message}\n`);
      reject(err);
    });
  });

  child.stdout.on('data', (chunk: Buffer) => {
    writeBackendLog(logStream, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    writeBackendLog(logStream, chunk);
  });
  child.on('exit', (code, signal) => {
    writeBackendLog(logStream, `\n[desktop] backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    if (!isQuitting && !suppressBackendExitDialog && !suppressExitDialog) {
      dialog.showErrorBox('OpenDeepSea 后端已退出', `后端进程已退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      app.quit();
    }
  });

  try {
    await Promise.race([waitForBackend(baseUrl, child), childError]);
  } catch (err) {
    suppressExitDialog = true;
    terminateBackendProcess(child);
    logStream.end();
    throw err;
  }
  return { baseUrl, localToken, process: child, logStream };
}

function buildBackendLaunch(port: number, localToken: string, dataDir: string): BackendLaunch {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    OPENDEEPSEA_HOST: '127.0.0.1',
    OPENDEEPSEA_LOCAL_TOKEN: localToken,
    OPENDEEPSEA_DATA_DIR: dataDir,
    OPENCLAW_ROOM_DB: join(dataDir, 'openclaw-room.db'),
  };

  if (isDev) {
    return {
      command: npmCommand(),
      args: ['run', 'dev', '-w', '@openclaw-room/backend'],
      cwd: repoRoot(),
      env,
    };
  }

  env.ELECTRON_RUN_AS_NODE = '1';
  env.NODE_ENV = 'production';
  env.OPENDEEPSEA_FRONTEND_DIST = join(process.resourcesPath, 'frontend-dist');

  return {
    command: process.execPath,
    args: [join(app.getAppPath(), 'packages', 'backend', 'dist', 'server.js')],
    cwd: dirname(app.getPath('exe')),
    env,
  };
}

function createBackendLogStream(): WriteStream {
  const logDir = app.getPath('logs');
  mkdirSync(logDir, { recursive: true });
  return createWriteStream(join(logDir, 'backend.log'), { flags: 'a' });
}

function writeBackendLog(stream: WriteStream, chunk: string | Buffer): void {
  if (stream.destroyed || stream.writableEnded) return;
  stream.write(chunk);
}

async function waitForBackend(baseUrl: string, child: BackendProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (hasBackendProcessExited(child)) {
      throw new Error(
        `backend exited before health check completed with code ${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(250);
  }

  throw new Error(`backend did not become ready: ${(lastError as Error | null)?.message ?? 'timeout'}`);
}

async function stopBackend(): Promise<void> {
  const runtime = backendRuntime;
  backendRuntime = null;
  if (!runtime) return;
  terminateBackendProcess(runtime.process);
  await waitForBackendProcessExit(runtime.process, 5000);
  if (!hasBackendProcessExited(runtime.process)) {
    forceKillBackendProcess(runtime.process);
    await waitForBackendProcessExit(runtime.process, 2000);
  }
  runtime.logStream.end();
}

function terminateBackendProcess(child: BackendProcess): void {
  if (hasBackendProcessExited(child) || child.killed) return;
  const pid = child.pid;
  if (!pid) {
    child.kill('SIGTERM');
    return;
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      child.kill('SIGTERM');
    });
    killer.unref();
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
    return;
  }

  const forceKillTimer = setTimeout(() => {
    forceKillBackendProcess(child);
  }, 5000);
  forceKillTimer.unref();
}

function hasBackendProcessExited(child: BackendProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function forceKillBackendProcess(child: BackendProcess): void {
  if (hasBackendProcessExited(child)) return;
  const pid = child.pid;
  if (!pid) {
    child.kill('SIGKILL');
    return;
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      child.kill('SIGKILL');
    });
    killer.unref();
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function waitForBackendProcessExit(child: BackendProcess, timeoutMs: number): Promise<void> {
  if (hasBackendProcessExited(child)) return;
  await Promise.race([
    new Promise<void>((resolveExit) => {
      child.once('exit', () => resolveExit());
    }),
    delay(timeoutMs),
  ]);
}

async function clearDesktopDataAndRelaunch(): Promise<void> {
  suppressBackendExitDialog = true;
  try {
    await stopBackend();
    await getDesktopDataManager().clearActiveDataDirectory();
    relaunchApp();
  } catch (err) {
    suppressBackendExitDialog = false;
    if (!backendRuntime && !isQuitting) {
      backendRuntime = await startBackend();
      if (mainWindow) await loadRenderer(mainWindow, backendRuntime.baseUrl);
    }
    throw err;
  }
}

function relaunchApp(): void {
  isQuitting = true;
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
}

function getDesktopDataManager(): DesktopDataManager {
  if (!desktopDataManager) {
    desktopDataManager = createDesktopDataManager({ userDataDir: app.getPath('userData') });
  }
  return desktopDataManager;
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function repoRoot(): string {
  const configured = process.env.OPENDEEPSEA_REPO_ROOT?.trim();
  return configured ? resolve(configured) : resolve(__dirname, '..', '..', '..');
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getDesktopLocalToken(): string {
  return process.env.OPENDEEPSEA_LOCAL_TOKEN?.trim() || randomBytes(24).toString('base64url');
}

function getDevBackendPort(): number {
  const configured = process.env.OPENDEEPSEA_DESKTOP_BACKEND_PORT?.trim()
    || process.env.PORT?.trim()
    || parsePortFromBackendUrl(process.env.VITE_BACKEND_URL?.trim())
    || '7330';
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid desktop backend port: ${configured}`);
  }
  return port;
}

function parsePortFromBackendUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.port) return parsed.port;
    if (parsed.protocol === 'http:') return '80';
    if (parsed.protocol === 'https:') return '443';
  } catch {
    return null;
  }
  return null;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a local port')));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
