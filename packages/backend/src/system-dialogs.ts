import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DirectoryPickerResult =
  | { canceled: true; path?: undefined }
  | { canceled: false; path: string };

export async function pickDirectory(): Promise<DirectoryPickerResult> {
  const currentPlatform = platform();

  if (currentPlatform === 'darwin') return pickDirectoryWithAppleScript();
  if (currentPlatform === 'win32') return pickDirectoryWithPowerShell();
  return pickDirectoryWithZenity();
}

async function pickDirectoryWithAppleScript(): Promise<DirectoryPickerResult> {
  const script = [
    'try',
    '  set selectedFolder to choose folder with prompt "选择项目文件夹"',
    '  POSIX path of selectedFolder',
    'on error number -128',
    '  return ""',
    'end try',
  ].join('\n');

  const { stdout } = await execFileAsync('osascript', ['-e', script]);
  return parsePickerOutput(stdout);
}

async function pickDirectoryWithPowerShell(): Promise<DirectoryPickerResult> {
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
    '$dialog.Description = "选择项目文件夹";',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }',
  ].join(' ');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-Command',
    command,
  ]);
  return parsePickerOutput(stdout);
}

async function pickDirectoryWithZenity(): Promise<DirectoryPickerResult> {
  try {
    const { stdout } = await execFileAsync('zenity', [
      '--file-selection',
      '--directory',
      '--title=选择项目文件夹',
    ]);
    return parsePickerOutput(stdout);
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException;
    if (String(maybeError.code) === '1') return { canceled: true };
    throw error;
  }
}

export function parsePickerOutput(stdout: string): DirectoryPickerResult {
  const selectedPath = stdout.trim();
  if (!selectedPath) return { canceled: true };
  return { canceled: false, path: selectedPath };
}
