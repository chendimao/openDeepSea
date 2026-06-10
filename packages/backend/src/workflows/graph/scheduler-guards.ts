export function scopeWritesConflict(left: string[], right: string[], projectPath: string): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const normalizedLeft = left.map((scope) => normalizeScopePath(scope, projectPath)).filter((scope): scope is string => scope !== null);
  const normalizedRight = right.map((scope) => normalizeScopePath(scope, projectPath)).filter((scope): scope is string => scope !== null);
  return normalizedLeft.some((leftScope) =>
    normalizedRight.some((rightScope) => scopePathConflicts(leftScope, rightScope))
  );
}

export function scopeWritesRequireSerial(writes: string[], projectPath: string): boolean {
  return writes
    .map((scope) => normalizeScopePath(scope, projectPath))
    .filter((scope): scope is string => scope !== null)
    .some((scope) => scopePathRequiresSerial(scope));
}

function scopePathRequiresSerial(scope: string): boolean {
  if (isBroadScopePath(scope)) return true;
  const segments = scope.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? scope;
  if ([
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
    'turbo.json',
    'nx.json',
    'lerna.json',
    'rush.json',
    'pnpm-workspace.yaml',
    'pnpm-workspace.yml',
    'workspace.json',
    '.gitlab-ci.yml',
    '.gitlab-ci.yaml',
    'azure-pipelines.yml',
    'Jenkinsfile',
    'Dockerfile',
    'docker-compose.yml',
    'compose.yml',
    'compose.yaml',
  ].includes(basename)) {
    return true;
  }
  if (/^(vite|eslint|postcss|tailwind|vitest|jest|playwright|webpack|rollup|tsup|babel|prettier|next|nuxt|astro|svelte|storybook|turbo|commitlint|lint-staged)\.config\./u.test(basename)) {
    return true;
  }
  return segments.some((segment) =>
    segment === '.github' ||
    segment === 'migrations' ||
    segment === 'schema' ||
    segment === 'shared' ||
    segment === 'contracts' ||
    segment === 'types'
  );
}

function normalizeScopePath(scope: string, projectPath: string): string | null {
  const trimmed = scope.trim();
  if (!trimmed) return null;
  const normalizedProjectPath = projectPath.replace(/\\/gu, '/').replace(/\/+$/u, '');
  let normalized = trimmed.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (normalizedProjectPath && normalized === normalizedProjectPath) return '.';
  if (normalizedProjectPath && normalized.startsWith(`${normalizedProjectPath}/`)) {
    normalized = normalized.slice(normalizedProjectPath.length + 1);
  }
  normalized = normalized.replace(/^\.\//u, '');
  return normalized || '.';
}

function scopePathConflicts(left: string, right: string): boolean {
  if (isBroadScopePath(left) || isBroadScopePath(right)) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isBroadScopePath(scope: string): boolean {
  return scope === '.' || scope === '/' || scope === '*';
}
