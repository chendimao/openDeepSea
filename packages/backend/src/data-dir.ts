import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = join(__dirname, '..', 'data');

export function getOpenDeepSeaDataDir(): string {
  const configured = process.env.OPENDEEPSEA_DATA_DIR?.trim();
  return configured ? resolve(configured) : defaultDataDir;
}

export function ensureOpenDeepSeaDataDir(): string {
  const dataDir = getOpenDeepSeaDataDir();
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}
