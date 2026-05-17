import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WORKSPACE_DIRECTORY_LIMIT,
  WORKSPACE_PREVIEW_TEXT_LIMIT,
  normalizeWorkspacePath,
  isIgnoredWorkspacePath,
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
  resolveWorkspacePath,
  searchWorkspaceFiles,
} from './workspace-files.js';

function createWorkspaceRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupWorkspaceRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('workspace path resolution rejects escapes and symlinks', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-path-');
  const outsideRoot = createWorkspaceRoot('openclaw-workspace-outside-');

  try {
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(join(projectRoot, 'docs', 'readme.md'), '# hello\n');
    writeFileSync(join(outsideRoot, 'secret.txt'), 'outside\n');
    symlinkSync(outsideRoot, join(projectRoot, 'linked-dir'), 'dir');
    symlinkSync(join(outsideRoot, 'secret.txt'), join(projectRoot, 'leak.txt'));

    assert.equal(normalizeWorkspacePath('./docs/../docs/readme.md'), 'docs/readme.md');
    const resolved = await resolveWorkspacePath(projectRoot, './docs/../docs/readme.md');
    assert.equal(resolved.relativePath, 'docs/readme.md');
    assert.equal(resolved.absolutePath, join(resolved.projectRealPath, 'docs', 'readme.md'));

    await assert.rejects(() => resolveWorkspacePath(projectRoot, '../secret.txt'), /WORKSPACE_PATH_TRAVERSAL/);
    await assert.rejects(() => resolveWorkspacePath(projectRoot, join(projectRoot, 'docs', 'readme.md')), /WORKSPACE_PATH_ABSOLUTE/);
    await assert.rejects(() => resolveWorkspacePath(projectRoot, 'linked-dir/readme.md'), /WORKSPACE_PATH_SYMLINK/);
    await assert.rejects(() => resolveWorkspacePath(projectRoot, 'leak.txt'), /WORKSPACE_PATH_OUTSIDE_PROJECT/);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
    cleanupWorkspaceRoot(outsideRoot);
  }
});

test('workspace ignore rules cover protected directories and sensitive file names', () => {
  assert.equal(isIgnoredWorkspacePath('.git/config'), true);
  assert.equal(isIgnoredWorkspacePath('.env'), true);
  assert.equal(isIgnoredWorkspacePath('.env.local'), true);
  assert.equal(isIgnoredWorkspacePath('node_modules/pkg/index.js'), true);
  assert.equal(isIgnoredWorkspacePath('dist/main.js'), true);
  assert.equal(isIgnoredWorkspacePath('build/output.js'), true);
  assert.equal(isIgnoredWorkspacePath('coverage/index.html'), true);
  assert.equal(isIgnoredWorkspacePath('secrets/key.pem'), true);
  assert.equal(isIgnoredWorkspacePath('secrets/private.key'), true);
  assert.equal(isIgnoredWorkspacePath('data/app.sqlite'), true);
  assert.equal(isIgnoredWorkspacePath('docs/readme.md'), false);
});

test('workspace directory listing sorts entries and enforces the entry limit', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-list-');

  try {
    mkdirSync(join(projectRoot, 'a-dir'));
    mkdirSync(join(projectRoot, 'b-dir'));
    writeFileSync(join(projectRoot, 'a.txt'), 'a\n');
    writeFileSync(join(projectRoot, 'b.txt'), 'b\n');
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'config'), 'ignored\n');
    writeFileSync(join(projectRoot, '.env'), 'SECRET=1\n');
    mkdirSync(join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'pkg', 'index.js'), 'ignored\n');

    for (let index = 0; index < WORKSPACE_DIRECTORY_LIMIT + 20; index += 1) {
      writeFileSync(join(projectRoot, `z-${String(index).padStart(3, '0')}.txt`), 'x\n');
    }

    const entries = await listWorkspaceDirectory(projectRoot);
    assert.equal(entries.length, WORKSPACE_DIRECTORY_LIMIT);
    assert.deepEqual(
      entries.slice(0, 4).map((entry) => entry.name),
      ['a-dir', 'b-dir', 'a.txt', 'b.txt'],
    );
    assert.equal(entries.some((entry) => entry.name === '.env'), false);
    assert.equal(entries.some((entry) => entry.name === '.git'), false);
    assert.equal(entries.some((entry) => entry.name === 'node_modules'), false);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace directory listing skips directory symlinks', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-symlink-');
  const outsideRoot = createWorkspaceRoot('openclaw-workspace-symlink-outside-');

  try {
    mkdirSync(join(outsideRoot, 'nested'), { recursive: true });
    symlinkSync(outsideRoot, join(projectRoot, 'linked-dir'), 'dir');
    writeFileSync(join(projectRoot, 'visible.txt'), 'visible\n');

    const entries = await listWorkspaceDirectory(projectRoot);
    assert.equal(entries.some((entry) => entry.name === 'linked-dir'), false);
    assert.equal(entries.some((entry) => entry.name === 'visible.txt'), true);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
    cleanupWorkspaceRoot(outsideRoot);
  }
});

test('workspace previews return text content and language, and reject binary files', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-preview-');

  try {
    writeFileSync(join(projectRoot, 'example.ts'), 'export const value = 1;\n');
    writeFileSync(join(projectRoot, 'binary.bin'), Buffer.from([0, 255, 4, 8, 13]));

    const preview = await readWorkspaceFilePreview(projectRoot, 'example.ts');
    assert.equal(preview.content, 'export const value = 1;\n');
    assert.equal(preview.language, 'typescript');
    assert.equal(preview.truncated, false);

    const hugeText = 'a'.repeat(WORKSPACE_PREVIEW_TEXT_LIMIT + 16);
    writeFileSync(join(projectRoot, 'huge.md'), hugeText);
    const truncated = await readWorkspaceFilePreview(projectRoot, 'huge.md');
    assert.equal(truncated.language, 'markdown');
    assert.equal(truncated.content.length, WORKSPACE_PREVIEW_TEXT_LIMIT);
    assert.equal(truncated.truncated, true);

    await assert.rejects(() => readWorkspaceFilePreview(projectRoot, 'binary.bin'), /WORKSPACE_FILE_BINARY/);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace search is filename-only, caps results, and skips inaccessible branches', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-search-');

  try {
    mkdirSync(join(projectRoot, 'src', 'deep', 'nest', 'level', 'more', 'again', 'and-again', 'too-deep'), {
      recursive: true,
    });
    writeFileSync(join(projectRoot, 'src', 'match-01.txt'), '1\n');
    writeFileSync(join(projectRoot, 'src', 'match-02.txt'), '2\n');
    writeFileSync(join(projectRoot, 'src', 'nope.txt'), '3\n');

    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(projectRoot, 'src', `needle-${String(index).padStart(2, '0')}.txt`), 'needle\n');
    }

    writeFileSync(
      join(projectRoot, 'src', 'deep', 'nest', 'level', 'more', 'again', 'and-again', 'too-deep', 'needle.txt'),
      'deep\n',
    );

    const blockedDir = join(projectRoot, 'blocked');
    mkdirSync(blockedDir);
    writeFileSync(join(blockedDir, 'needle-hidden.txt'), 'hidden\n');
    chmodSync(blockedDir, 0);

    const results = await searchWorkspaceFiles(projectRoot, 'needle');
    assert.equal(results.length, 50);
    assert.equal(results.every((entry) => entry.name.toLowerCase().includes('needle')), true);
    assert.equal(results.some((entry) => entry.path.includes('too-deep')), false);
    assert.equal(results.some((entry) => entry.path.includes('needle-hidden.txt')), false);
    assert.equal(results.some((entry) => entry.path.includes('nope.txt')), false);
  } finally {
    chmodSync(join(projectRoot, 'blocked'), 0o700);
    cleanupWorkspaceRoot(projectRoot);
  }
});
