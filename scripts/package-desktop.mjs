import { spawn } from 'node:child_process';
import { copyFile, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const builderArgs = [...process.argv.slice(2), '--config', 'electron-builder.json'];
const electronVersion = await readElectronVersion();

const electronRebuildCode = await run(command('electron-rebuild'), [
  '--force',
  '--build-from-source',
  '--version',
  electronVersion,
  '--arch',
  process.arch,
  '--which-module',
  'better-sqlite3,node-pty',
]);
const builderCode = electronRebuildCode === 0
  ? await run(command('electron-builder'), builderArgs)
  : electronRebuildCode;
let detachCode = 0;
if (builderCode === 0) {
  try {
    await detachPackagedNativeModules();
  } catch (err) {
    detachCode = 1;
    console.error((err instanceof Error ? err.message : String(err)) || 'failed to detach packaged native modules');
  }
}
const rebuildCode = await run(command('npm'), ['rebuild', 'better-sqlite3', 'node-pty']);

if (builderCode !== 0) process.exit(builderCode);
if (detachCode !== 0) process.exit(detachCode);
if (rebuildCode !== 0) process.exit(rebuildCode);

function run(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', (err) => {
      console.error(err.message);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`${file} exited with signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

async function detachPackagedNativeModules() {
  const outputDir = join('release', 'desktop');
  if (!(await exists(outputDir))) return;

  for await (const filePath of walk(outputDir)) {
    if (!filePath.endsWith('.node')) continue;
    const tmpPath = join(dirname(filePath), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.node`);
    await copyFile(filePath, tmpPath);
    await rename(tmpPath, filePath).catch(async (err) => {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    });
  }
}

async function readElectronVersion() {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const version = packageJson?.devDependencies?.electron;
  if (typeof version !== 'string') throw new Error('electron devDependency is missing');
  return version.replace(/^[^\d]*/, '');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function* walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}
