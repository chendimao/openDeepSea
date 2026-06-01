import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
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
  WORKSPACE_REFERENCE_SIZE_LIMIT,
  WORKSPACE_SEARCH_MAX_DEPTH,
  WORKSPACE_SEARCH_MAX_DIRECTORIES,
  WORKSPACE_SEARCH_MAX_FILES,
  WORKSPACE_SEARCH_TIMEOUT_MS,
  normalizeWorkspacePath,
  isIgnoredWorkspacePath,
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
  readWorkspaceFileReference,
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

test('workspace directory listing collects before sort/slice so directories stay ahead of files', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-list-sort-slice-');

  try {
    for (let index = 0; index < WORKSPACE_DIRECTORY_LIMIT; index += 1) {
      writeFileSync(join(projectRoot, `a-file-${String(index).padStart(3, '0')}.txt`), 'x\n');
    }
    mkdirSync(join(projectRoot, 'z-dir-1'));
    mkdirSync(join(projectRoot, 'z-dir-2'));
    mkdirSync(join(projectRoot, 'z-dir-3'));

    const entries = await listWorkspaceDirectory(projectRoot);
    assert.equal(entries.length, WORKSPACE_DIRECTORY_LIMIT);
    assert.deepEqual(
      entries.slice(0, 3).map((entry) => entry.name),
      ['z-dir-1', 'z-dir-2', 'z-dir-3'],
    );
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
    writeFileSync(join(projectRoot, 'binary.ts'), Buffer.from([0, 1, 2, 3, 4]));

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
    await assert.rejects(() => readWorkspaceFilePreview(projectRoot, 'binary.ts'), /WORKSPACE_FILE_BINARY/);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace preview and reference reject ignored direct paths', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-ignored-');

  try {
    writeFileSync(join(projectRoot, '.env.local'), 'OPENAI_API_KEY=secret\n');
    writeFileSync(join(projectRoot, 'private.pem'), '-----BEGIN PRIVATE KEY-----\n');

    await assert.rejects(() => readWorkspaceFilePreview(projectRoot, '.env.local'), /WORKSPACE_PATH_IGNORED/);
    await assert.rejects(() => readWorkspaceFileReference(projectRoot, '.env.local'), /WORKSPACE_PATH_IGNORED/);
    await assert.rejects(() => readWorkspaceFilePreview(projectRoot, 'private.pem'), /WORKSPACE_PATH_IGNORED/);
    await assert.rejects(() => readWorkspaceFileReference(projectRoot, 'private.pem'), /WORKSPACE_PATH_IGNORED/);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace preview and reference reject safe symlink that points to ignored target', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-ignored-symlink-');

  try {
    writeFileSync(join(projectRoot, '.env.local'), 'OPENAI_API_KEY=secret\n');
    symlinkSync(join(projectRoot, '.env.local'), join(projectRoot, 'safe.txt'));

    await assert.rejects(() => readWorkspaceFilePreview(projectRoot, 'safe.txt'), /WORKSPACE_PATH_IGNORED/);
    await assert.rejects(() => readWorkspaceFileReference(projectRoot, 'safe.txt'), /WORKSPACE_PATH_IGNORED/);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace reference allows binary file under size limit', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-reference-binary-');

  try {
    const binary = Buffer.from([0, 255, 1, 2, 3, 4, 5]);
    writeFileSync(join(projectRoot, 'sample.bin'), binary);

    const reference = await readWorkspaceFileReference(projectRoot, 'sample.bin');
    assert.equal(reference.size, binary.length);
    assert.equal(reference.bytes.equals(binary), true);
    assert.equal(reference.isBinary, true);
    assert.equal(reference.content, null);
    assert.equal(reference.truncated, false);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace reference returns text content for text file', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-reference-text-');

  try {
    writeFileSync(join(projectRoot, 'sample.ts'), 'export const answer = 42;\n');
    const reference = await readWorkspaceFileReference(projectRoot, 'sample.ts');

    assert.equal(reference.isBinary, false);
    assert.equal(reference.content, 'export const answer = 42;\n');
    assert.equal(reference.language, 'typescript');
    assert.equal(reference.bytes.length > 0, true);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace reference rejects files over size limit', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-reference-too-large-');

  try {
    writeFileSync(join(projectRoot, 'oversize.bin'), Buffer.alloc(WORKSPACE_REFERENCE_SIZE_LIMIT + 1, 1));
    await assert.rejects(() => readWorkspaceFileReference(projectRoot, 'oversize.bin'), /WORKSPACE_FILE_TOO_LARGE/);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace search constants match design limits', () => {
  assert.equal(WORKSPACE_SEARCH_MAX_DEPTH, 12);
  assert.equal(WORKSPACE_SEARCH_MAX_DIRECTORIES, 1000);
  assert.equal(WORKSPACE_SEARCH_MAX_FILES, 10000);
  assert.equal(WORKSPACE_SEARCH_TIMEOUT_MS, 1500);
});

test('workspace search is filename-only, caps results, and respects depth/inaccessible branches', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-search-');

  try {
    const depth12 = join(
      projectRoot,
      'd01',
      'd02',
      'd03',
      'd04',
      'd05',
      'd06',
      'd07',
      'd08',
      'd09',
      'd10',
      'd11',
      'd12',
    );
    const depth13 = join(depth12, 'd13');
    mkdirSync(depth13, { recursive: true });
    writeFileSync(join(projectRoot, 'match-01.txt'), '1\n');
    writeFileSync(join(projectRoot, 'match-02.txt'), '2\n');
    writeFileSync(join(projectRoot, 'nope.txt'), '3\n');
    mkdirSync(join(projectRoot, 'z-bulk'), { recursive: true });

    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(projectRoot, 'z-bulk', `needle-${String(index).padStart(2, '0')}.txt`), 'needle\n');
    }

    writeFileSync(join(depth12, 'needle-depth-12.txt'), 'depth12\n');
    writeFileSync(join(depth13, 'needle-depth-13.txt'), 'depth13\n');

    const cappedResults = await searchWorkspaceFiles(projectRoot, 'needle');
    assert.equal(cappedResults.entries.length, 50);
    assert.equal(cappedResults.truncated, true);
    assert.equal(cappedResults.entries.every((entry) => entry.name.toLowerCase().includes('needle')), true);
    assert.equal(cappedResults.entries.some((entry) => entry.path.includes('nope.txt')), false);

    const depthResults = await searchWorkspaceFiles(projectRoot, 'depth-');
    assert.equal(depthResults.truncated, true);
    assert.equal(depthResults.entries.some((entry) => entry.path.endsWith('needle-depth-12.txt')), true);
    assert.equal(depthResults.entries.some((entry) => entry.path.endsWith('needle-depth-13.txt')), false);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace list/search skip safe symlink that points to ignored target', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-symlink-ignored-target-');

  try {
    writeFileSync(join(projectRoot, '.env.local'), 'SECRET=1\n');
    symlinkSync(join(projectRoot, '.env.local'), join(projectRoot, 'safe-link.txt'));
    writeFileSync(join(projectRoot, 'safe-real.txt'), 'visible\n');

    const listed = await listWorkspaceDirectory(projectRoot);
    assert.equal(listed.some((entry) => entry.name === 'safe-link.txt'), false);
    assert.equal(listed.some((entry) => entry.name === 'safe-real.txt'), true);

    const searchResults = await searchWorkspaceFiles(projectRoot, 'safe');
    assert.equal(searchResults.entries.some((entry) => entry.path === 'safe-link.txt'), false);
    assert.equal(searchResults.entries.some((entry) => entry.path === 'safe-real.txt'), true);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace search result cap uses deterministic lexicographic traversal', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-search-order-');

  try {
    mkdirSync(join(projectRoot, 'a-dir'), { recursive: true });
    mkdirSync(join(projectRoot, 'z-dir'), { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      const fileName = `needle-${String(index).padStart(3, '0')}.txt`;
      writeFileSync(join(projectRoot, 'a-dir', fileName), 'a\n');
      writeFileSync(join(projectRoot, 'z-dir', fileName), 'z\n');
    }

    const results = await searchWorkspaceFiles(projectRoot, 'needle');
    assert.equal(results.entries.length, 50);
    assert.equal(results.truncated, true);
    assert.equal(results.entries.every((entry) => entry.path.startsWith('a-dir/')), true);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('workspace search reports exact complete cap-sized result set as not truncated', async () => {
  const projectRoot = createWorkspaceRoot('openclaw-workspace-search-exact-');

  try {
    mkdirSync(join(projectRoot, 'exact'), { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(projectRoot, 'exact', `match-${String(index).padStart(2, '0')}.txt`), 'x\n');
    }

    const results = await searchWorkspaceFiles(projectRoot, 'match-');
    assert.equal(results.entries.length, 50);
    assert.equal(results.truncated, false);
  } finally {
    cleanupWorkspaceRoot(projectRoot);
  }
});

test('searchWorkspaceFiles excludes extra ignored dirs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-room-ws-exclude-'));
  mkdirSync(join(root, 'vendor'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'target.txt'), 'hit');
  writeFileSync(join(root, 'target.txt'), 'hit');

  const withExtra = await searchWorkspaceFiles(root, 'target', '', ['vendor']);
  assert.ok(withExtra.entries.every((entry) => !entry.path.startsWith('vendor/')));

  const withoutExtra = await searchWorkspaceFiles(root, 'target', '', []);
  assert.ok(withoutExtra.entries.some((entry) => entry.path.startsWith('vendor/')));
});
