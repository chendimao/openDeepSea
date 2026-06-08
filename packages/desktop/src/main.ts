import { app, BrowserWindow, dialog, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { WriteStream } from 'node:fs';

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
let mainWindow: BrowserWindow | null = null;
let backendRuntime: BackendRuntime | null = null;
let isQuitting = false;

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
    backendRuntime = await startBackend();
    mainWindow = createMainWindow(backendRuntime.localToken);
    await loadRenderer(mainWindow, backendRuntime.baseUrl);
  } catch (err) {
    dialog.showErrorBox('OpenDeepSea 启动失败', (err as Error).message);
    app.quit();
  }
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendRuntime) {
    mainWindow = createMainWindow(backendRuntime.localToken);
    void loadRenderer(mainWindow, backendRuntime.baseUrl);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function createMainWindow(localToken: string): BrowserWindow {
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
      additionalArguments: [`--opendeepsea-local-token=${localToken}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
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
  const launch = buildBackendLaunch(port, localToken);
  const logStream = createBackendLogStream();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => {
    logStream.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    logStream.write(chunk);
  });
  child.on('exit', (code, signal) => {
    logStream.write(`\n[desktop] backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    if (!isQuitting) {
      dialog.showErrorBox('OpenDeepSea 后端已退出', `后端进程已退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      app.quit();
    }
  });

  await waitForBackend(baseUrl, child);
  return { baseUrl, localToken, process: child, logStream };
}

function buildBackendLaunch(port: number, localToken: string): BackendLaunch {
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });

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
  env.OPENDEEPSEA_FRONTEND_DIST = join(app.getAppPath(), 'packages', 'frontend', 'dist');

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

async function waitForBackend(baseUrl: string, child: BackendProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited before health check completed with code ${child.exitCode}`);
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

function stopBackend(): void {
  const runtime = backendRuntime;
  backendRuntime = null;
  if (!runtime) return;
  runtime.process.kill();
  runtime.logStream.end();
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
