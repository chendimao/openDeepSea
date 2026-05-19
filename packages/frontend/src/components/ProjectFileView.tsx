import {
  Code2,
  FilePenLine,
  FileArchive,
  FileText,
  Image as ImageIcon,
  Music,
  Presentation,
  Table2,
  Video,
} from 'lucide-react';
import { useState, type ElementType, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { getProjectFileTypeLabel } from '../lib/projectFileDisplay';
import type { ProjectFile } from '../lib/types';
import { cn } from '../lib/utils';

export type ProjectFileViewMode = 'list' | 'card';
export type ProjectFileVariant = 'library' | 'picker';

export interface ProjectFileAction {
  key: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  href?: string;
  download?: string;
  onClick?: () => void;
}

interface ProjectFileViewProps {
  files: ProjectFile[];
  mode: ProjectFileViewMode;
  variant: ProjectFileVariant;
  getMeta: (file: ProjectFile) => ReactNode;
  getSecondaryMeta?: (file: ProjectFile) => ReactNode;
  getActions?: (file: ProjectFile) => ProjectFileAction[];
  getState?: (file: ProjectFile) => ReactNode;
  isSelected?: (file: ProjectFile) => boolean;
  isDisabled?: (file: ProjectFile) => boolean;
  onToggle?: (file: ProjectFile) => void;
}

export function ProjectFileView({
  files,
  mode,
  variant,
  getMeta,
  getSecondaryMeta,
  getActions,
  getState,
  isSelected,
  isDisabled,
  onToggle,
}: ProjectFileViewProps): JSX.Element {
  return (
    <div className={cn('project-file-view', `is-${mode}`, `variant-${variant}`)}>
      {files.map((file) => {
        const selected = isSelected?.(file) ?? false;
        const disabled = isDisabled?.(file) ?? false;
        const actions = getActions?.(file) ?? [];
        const state = getState?.(file);
        const secondaryMeta = getSecondaryMeta?.(file);
        const itemClassName = cn(
          'project-file-item',
          `is-${mode}`,
          selected && 'is-selected',
          disabled && 'is-disabled',
        );
        const content = (
          <>
            <ProjectFileThumbnail file={file} />
            <span className="project-file-main">
              <span className="project-file-name" title={file.original_name}>
                {file.original_name}
              </span>
              <span className="project-file-meta">
                <ProjectFileSourceBadge file={file} />
                {getMeta(file)}
              </span>
            </span>
            {secondaryMeta ? <span className="project-file-secondary">{secondaryMeta}</span> : null}
            {state ? <span className="project-file-state">{state}</span> : null}
            {actions.length > 0 ? <ProjectFileActions actions={actions} /> : null}
          </>
        );

        if (onToggle) {
          return (
            <button
              type="button"
              key={file.id}
              className={itemClassName}
              disabled={disabled}
              aria-disabled={disabled}
              onClick={() => onToggle(file)}
            >
              {content}
            </button>
          );
        }

        return (
          <article key={file.id} className={itemClassName}>
            {content}
          </article>
        );
      })}
    </div>
  );
}

function ProjectFileActions({ actions }: { actions: ProjectFileAction[] }): JSX.Element {
  return (
    <span className="project-file-actions">
      {actions.map((action) => {
        const className = cn('icon-glass-button', action.danger && 'is-danger');
        if (action.href) {
          return (
            <a
              key={action.key}
              href={action.href}
              download={action.download}
              className={className}
              aria-label={action.label}
              title={action.label}
              onClick={(event) => event.stopPropagation()}
            >
              {action.icon}
            </a>
          );
        }

        return (
          <button
            type="button"
            key={action.key}
            className={className}
            aria-label={action.label}
            title={action.label}
            disabled={action.disabled}
            onClick={(event) => {
              event.stopPropagation();
              action.onClick?.();
            }}
          >
            {action.icon}
          </button>
        );
      })}
    </span>
  );
}

function ProjectFileThumbnail({ file }: { file: ProjectFile }): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const isImage = file.mime_type.startsWith('image/') && !imageFailed;

  if (isImage) {
    return (
      <span className="project-file-thumbnail is-image">
        <img
          src={file.url}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  const Icon = getFileTypeIcon(file);
  const label = getFileTypeLabel(file);
  return (
    <span className="project-file-thumbnail">
      <Icon className="h-5 w-5" strokeWidth={1.65} />
      <span className="project-file-type-label">{label}</span>
    </span>
  );
}

function getFileTypeIcon(file: ProjectFile): ElementType {
  if (file.source_type === 'agent_document') return FilePenLine;

  const mimeType = file.mime_type.toLocaleLowerCase();
  const extension = getFileExtension(file.original_name);

  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || ['zip', 'gz', 'tgz', 'rar', '7z'].includes(extension)) {
    return FileArchive;
  }
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv') || ['csv', 'xls', 'xlsx', 'tsv'].includes(extension)) {
    return Table2;
  }
  if (mimeType.includes('presentation') || ['ppt', 'pptx', 'key'].includes(extension)) return Presentation;
  if (mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml') || [
    'css',
    'go',
    'html',
    'js',
    'jsx',
    'json',
    'py',
    'rs',
    'tsx',
    'ts',
    'vue',
  ].includes(extension)) {
    return Code2;
  }
  return FileText;
}

function ProjectFileSourceBadge({ file }: { file: ProjectFile }): JSX.Element {
  const { t } = useI18n();
  const isAgentDocument = file.source_type === 'agent_document';

  return (
    <span className={cn('project-file-source-badge', isAgentDocument ? 'is-agent-document' : 'is-uploaded-file')}>
      {getProjectFileTypeLabel(file, t)}
    </span>
  );
}

function getFileTypeLabel(file: ProjectFile): string {
  const extension = getFileExtension(file.original_name);
  if (extension.length >= 2 && extension.length <= 6) return extension.toLocaleUpperCase();
  const primaryType = file.mime_type.split('/')[0];
  return primaryType ? primaryType.toLocaleUpperCase() : 'FILE';
}

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === name.length - 1) return '';
  return name.slice(dotIndex + 1).toLocaleLowerCase();
}
