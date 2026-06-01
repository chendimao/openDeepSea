import { lstat } from 'node:fs/promises';
import { normalizeWorkspacePath, readWorkspaceFilePreview, resolveWorkspacePath } from './workspace-files.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export interface WorkspaceFileRefContext {
  promptAddition: string;
  imagePaths: string[];
}

export async function buildWorkspaceFileRefContext(
  projectPath: string,
  fileRefs: string[],
): Promise<WorkspaceFileRefContext> {
  const blocks: string[] = [];
  const imagePaths: string[] = [];

  for (const ref of fileRefs) {
    let safePath: string;
    try {
      safePath = normalizeWorkspacePath(ref);
    } catch {
      continue;
    }
    if (!safePath) continue;

    if (isImagePath(safePath)) {
      try {
        const resolved = await resolveWorkspacePath(projectPath, safePath);
        const stats = await lstat(resolved.absolutePath);
        if (stats.isFile()) {
          imagePaths.push(resolved.absolutePath);
        }
      } catch {
        continue;
      }
      continue;
    }

    try {
      const preview = await readWorkspaceFilePreview(projectPath, safePath);
      const truncatedNote = preview.truncated ? '\n…(truncated)' : '';
      blocks.push(`引用文件 ${safePath}:\n\`\`\`\n${preview.content}${truncatedNote}\n\`\`\``);
    } catch {
      continue;
    }
  }

  return {
    promptAddition: blocks.join('\n\n'),
    imagePaths,
  };
}
