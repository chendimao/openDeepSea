import {
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Paperclip,
  SendHorizontal,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Dialog, DialogContent } from '../components/ui/Dialog';
import { MarkdownPreview } from '../components/MessageContent';
import type { PlatformSkill } from '../lib/types';
import {
  buildAttachmentPreviewKind,
  buildSessionComposerSubmitFromText,
  formatComposerAttachmentMeta,
  getComposerAttachmentInteractionState,
  type ComposerAttachmentPreviewKind,
  type SessionComposerSubmit,
} from './session-file-composer-model';

const MAX_SESSION_ATTACHMENTS = 5;
const MAX_SKILL_SUGGESTIONS = 8;

type PendingSessionAttachment = {
  id: string;
  file: File;
  previewKind: ComposerAttachmentPreviewKind;
  objectUrl?: string;
};

type PreviewState =
  | { attachment: PendingSessionAttachment; content?: string; loading?: boolean; error?: string }
  | null;

type ActiveSkillTrigger = {
  start: number;
  end: number;
  query: string;
};

export function SessionFileComposer({
  projectId,
  onSendMessage,
}: {
  projectId: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<PendingSessionAttachment[]>([]);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [dismissedSkillTriggerKey, setDismissedSkillTriggerKey] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsRef = useRef<PendingSessionAttachment[]>([]);
  const plannerSkillsQuery = useQuery({
    queryKey: ['platform-skills', 'session-planner', projectId],
    queryFn: () => api.listSessionPlannerPlatformSkills(projectId),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    }
  }, []);

  const canSubmit = !isUploading && (content.trim().length > 0 || attachments.length > 0);
  const platformSkills = plannerSkillsQuery.data?.skills ?? [];
  const rawActiveSkillTrigger = getActiveSkillTrigger(content, cursorPosition);
  const rawActiveSkillTriggerKey = rawActiveSkillTrigger ? formatSkillTriggerKey(rawActiveSkillTrigger) : null;
  const activeSkillTrigger = rawActiveSkillTriggerKey === dismissedSkillTriggerKey
    ? null
    : rawActiveSkillTrigger;
  const skillSuggestions = activeSkillTrigger
    ? filterSkillSuggestions(platformSkills, activeSkillTrigger.query)
    : [];
  const showSkillPicker = Boolean(activeSkillTrigger) && (
    plannerSkillsQuery.isLoading ||
    plannerSkillsQuery.isError ||
    skillSuggestions.length > 0 ||
    platformSkills.length === 0
  );

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [activeSkillTrigger?.query, plannerSkillsQuery.data?.provider]);

  useEffect(() => {
    if (selectedSkillIndex < skillSuggestions.length) return;
    setSelectedSkillIndex(Math.max(0, skillSuggestions.length - 1));
  }, [selectedSkillIndex, skillSuggestions.length]);

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    const availableSlots = Math.max(0, MAX_SESSION_ATTACHMENTS - attachments.length);
    if (availableSlots === 0) {
      setError(`最多只能附加 ${MAX_SESSION_ATTACHMENTS} 个文件`);
      return;
    }
    const acceptedFiles = files.slice(0, availableSlots);
    if (acceptedFiles.length < files.length) {
      setError(`最多只能附加 ${MAX_SESSION_ATTACHMENTS} 个文件`);
    }
    setAttachments((current) => [
      ...current,
      ...acceptedFiles.map(createPendingAttachment),
    ]);
  };

  const removeAttachment = (attachment: PendingSessionAttachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    setPreview((current) => current?.attachment.id === attachment.id ? null : current);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setIsUploading(true);
    try {
      const uploadedFiles = attachments.length > 0
        ? await api.uploadProjectFiles(projectId, attachments.map((attachment) => attachment.file))
        : [];
      const message = buildSessionComposerSubmitFromText({ content, uploadedFiles, platformSkills });
      if (!message) return;
      onSendMessage(message);
      clearComposer();
    } catch (err) {
      setError(err instanceof Error ? err.message : '附件上传失败');
    } finally {
      setIsUploading(false);
    }
  };

  const clearComposer = () => {
    for (const attachment of attachments) {
      if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    }
    setAttachments([]);
    setPreview(null);
    setContent('');
    textareaRef.current?.focus();
  };

  const updateCursorFromTextarea = () => {
    setCursorPosition(textareaRef.current?.selectionStart ?? 0);
  };

  const insertSkill = (skill: PlatformSkill) => {
    if (!activeSkillTrigger) return;
    const nextContent = `${content.slice(0, activeSkillTrigger.start)}$${skill.name} ${content.slice(activeSkillTrigger.end)}`;
    const nextCursor = activeSkillTrigger.start + skill.name.length + 2;
    setContent(nextContent);
    setCursorPosition(nextCursor);
    setDismissedSkillTriggerKey(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <form
      className="deepsea-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="deepsea-composer__field">
        {showSkillPicker && (
          <SkillPicker
            provider={plannerSkillsQuery.data?.provider ?? null}
            loading={plannerSkillsQuery.isLoading}
            error={plannerSkillsQuery.isError ? '读取 planner skills 失败' : null}
            skills={skillSuggestions}
            selectedIndex={selectedSkillIndex}
            onSelect={insertSkill}
          />
        )}
        {attachments.length > 0 && (
          <AttachmentStrip
            attachments={attachments}
            isUploading={isUploading}
            onPreview={setPreview}
            onRemove={removeAttachment}
          />
        )}
        <textarea
          ref={textareaRef}
          className="deepsea-composer__textarea"
          data-session-composer-textarea="true"
          value={content}
          rows={2}
          aria-label="命令输入"
          disabled={isUploading}
          placeholder="输入消息，粘贴文件会上传到项目文件库"
          onChange={(event) => {
            setContent(event.currentTarget.value);
            setCursorPosition(event.currentTarget.selectionStart);
          }}
          onClick={updateCursorFromTextarea}
          onSelect={updateCursorFromTextarea}
          onKeyUp={updateCursorFromTextarea}
          onPaste={(event) => {
            const files = filesFromClipboard(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(event) => {
            if (showSkillPicker) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (skillSuggestions.length > 0) {
                  setSelectedSkillIndex((index) => Math.min(skillSuggestions.length - 1, index + 1));
                }
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                if (skillSuggestions.length > 0) {
                  setSelectedSkillIndex((index) => Math.max(0, index - 1));
                }
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && skillSuggestions[selectedSkillIndex]) {
                event.preventDefault();
                insertSkill(skillSuggestions[selectedSkillIndex]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                if (rawActiveSkillTriggerKey) setDismissedSkillTriggerKey(rawActiveSkillTriggerKey);
                return;
              }
            }
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="deepsea-composer__tools">
          <Paperclip aria-hidden="true" />
          <span className="deepsea-composer__dollar" aria-hidden="true">$</span>
          <AlertTriangle aria-hidden="true" />
          <span className="deepsea-composer__upload-hint">
            {isUploading ? '上传中...' : '粘贴文件会上传到项目文件库'}
          </span>
          <button type="submit" className="deepsea-send-button" aria-label="发送" disabled={!canSubmit}>
            <SendHorizontal aria-hidden="true" />
          </button>
        </div>
        {error && <p className="deepsea-composer__error">{error}</p>}
      </div>
      <AttachmentPreviewDialog preview={preview} onPreviewChange={setPreview} />
    </form>
  );
}

function SkillPicker({
  provider,
  loading,
  error,
  skills,
  selectedIndex,
  onSelect,
}: {
  provider: string | null;
  loading: boolean;
  error: string | null;
  skills: PlatformSkill[];
  selectedIndex: number;
  onSelect: (skill: PlatformSkill) => void;
}): JSX.Element {
  return (
    <div className="deepsea-skill-picker" role="listbox" aria-label="Planner backend skills">
      <div className="deepsea-skill-picker__header">
        <span>Planner skills</span>
        {provider && <strong>{provider}</strong>}
      </div>
      {loading && <div className="deepsea-skill-picker__state">读取 skills...</div>}
      {!loading && error && <div className="deepsea-skill-picker__state">{error}</div>}
      {!loading && !error && skills.length === 0 && <div className="deepsea-skill-picker__state">当前 planner backend 没有可用 skills</div>}
      {!loading && !error && skills.map((skill, index) => (
        <button
          key={`${skill.provider}:${skill.name}`}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          className={index === selectedIndex ? 'deepsea-skill-picker__item is-active' : 'deepsea-skill-picker__item'}
          title={skill.description ?? skill.name}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(skill);
          }}
        >
          <span className="deepsea-skill-picker__name">${skill.name}</span>
          {skill.description && <span className="deepsea-skill-picker__description">{skill.description}</span>}
        </button>
      ))}
    </div>
  );
}

function AttachmentStrip({
  attachments,
  isUploading,
  onPreview,
  onRemove,
}: {
  attachments: PendingSessionAttachment[];
  isUploading: boolean;
  onPreview: (preview: PreviewState) => void;
  onRemove: (attachment: PendingSessionAttachment) => void;
}): JSX.Element {
  const interaction = getComposerAttachmentInteractionState({ isUploading });
  return (
    <div className="deepsea-composer-attachments" role="list" aria-label="待发送附件">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="deepsea-composer-attachment"
          role="listitem"
        >
          <button
            type="button"
            className="deepsea-composer-attachment__preview"
            disabled={!interaction.canPreview}
            onClick={() => onPreview({
              attachment,
              ...(attachment.previewKind === 'text' ? { loading: true } : {}),
            })}
          >
            <AttachmentThumb attachment={attachment} />
            <span className="deepsea-composer-attachment__body">
              <strong title={attachment.file.name}>{attachment.file.name}</strong>
              <small>{formatComposerAttachmentMeta(attachment.file)}</small>
            </span>
          </button>
          <button
            type="button"
            aria-label={`移除 ${attachment.file.name}`}
            className="deepsea-composer-attachment__remove"
            disabled={!interaction.canRemove}
            onClick={() => onRemove(attachment)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function AttachmentThumb({ attachment }: { attachment: PendingSessionAttachment }): JSX.Element {
  if (attachment.previewKind === 'image' && attachment.objectUrl) {
    return <img className="deepsea-composer-attachment__image" src={attachment.objectUrl} alt="" />;
  }
  const Icon = attachment.previewKind === 'text' ? FileText : ImageIcon;
  return (
    <span className="deepsea-composer-attachment__icon">
      <Icon aria-hidden="true" />
    </span>
  );
}

function AttachmentPreviewDialog({
  preview,
  onPreviewChange,
}: {
  preview: PreviewState;
  onPreviewChange: (preview: PreviewState) => void;
}): JSX.Element {
  const attachment = preview?.attachment;

  useEffect(() => {
    if (!attachment || attachment.previewKind !== 'text' || !preview?.loading || preview.content) return;
    let cancelled = false;
    attachment.file.text()
      .then((content) => {
        if (!cancelled) onPreviewChange({ attachment, content });
      })
      .catch((err) => {
        if (!cancelled) onPreviewChange({ attachment, error: err instanceof Error ? err.message : '文本预览失败' });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, onPreviewChange, preview?.content, preview?.loading]);

  return (
    <Dialog open={!!attachment} onOpenChange={(open) => !open && onPreviewChange(null)}>
      <DialogContent className="deepsea-attachment-preview" title={attachment?.file.name}>
        {attachment && <AttachmentPreviewBody preview={preview} attachment={attachment} />}
      </DialogContent>
    </Dialog>
  );
}

function AttachmentPreviewBody({
  preview,
  attachment,
}: {
  preview: PreviewState;
  attachment: PendingSessionAttachment;
}): JSX.Element {
  if (attachment.previewKind === 'image' && attachment.objectUrl) {
    return (
      <div className="deepsea-attachment-preview__stage">
        <img src={attachment.objectUrl} alt={attachment.file.name} />
      </div>
    );
  }
  if (attachment.previewKind === 'text') {
    if (preview?.loading) return <div className="deepsea-attachment-preview__state">读取文本...</div>;
    if (preview?.error) return <div className="deepsea-attachment-preview__state">{preview.error}</div>;
    const content = preview?.content ?? '';
    return (
      <div className="deepsea-attachment-preview__text">
        {attachment.file.name.toLowerCase().endsWith('.md') ? (
          <MarkdownPreview content={content} />
        ) : (
          <pre>{content}</pre>
        )}
      </div>
    );
  }
  return <div className="deepsea-attachment-preview__state">该文件类型暂不支持发送前预览。</div>;
}

function createPendingAttachment(file: File): PendingSessionAttachment {
  const previewKind = buildAttachmentPreviewKind(file);
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    file,
    previewKind,
    ...(previewKind === 'image' ? { objectUrl: URL.createObjectURL(file) } : {}),
  };
}

function filesFromClipboard(data: DataTransfer): File[] {
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function getActiveSkillTrigger(content: string, cursorPosition: number): ActiveSkillTrigger | null {
  const cursor = Math.max(0, Math.min(cursorPosition, content.length));
  const beforeCursor = content.slice(0, cursor);
  const match = /(^|[\s([{，。！？、])\$([A-Za-z0-9._:-]*)$/u.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? '';
  return {
    start: match.index + prefix.length,
    end: cursor,
    query: match[2] ?? '',
  };
}

function formatSkillTriggerKey(trigger: ActiveSkillTrigger): string {
  return `${trigger.start}:${trigger.end}:${trigger.query}`;
}

function filterSkillSuggestions(skills: PlatformSkill[], query: string): PlatformSkill[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (!skill.valid) return false;
      const key = `${skill.provider}:${skill.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (!needle) return true;
      return skill.name.toLowerCase().includes(needle) ||
        (skill.description ?? '').toLowerCase().includes(needle);
    })
    .sort((left, right) => compareSkillSuggestion(left, right, needle))
    .slice(0, MAX_SKILL_SUGGESTIONS);
}

function compareSkillSuggestion(left: PlatformSkill, right: PlatformSkill, needle: string): number {
  if (needle) {
    const leftStartsWith = left.name.toLowerCase().startsWith(needle);
    const rightStartsWith = right.name.toLowerCase().startsWith(needle);
    if (leftStartsWith !== rightStartsWith) return leftStartsWith ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}
