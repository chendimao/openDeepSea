import { AlertTriangle, AtSign, Hash, SendHorizontal } from 'lucide-react';
import React, { useMemo } from 'react';
import { api } from '../lib/api';
import { PromptArea } from '../components/prompt-area/PromptArea';
import { usePromptAreaState } from '../components/prompt-area/use-prompt-area-state';
import type { PromptAreaHandle, TriggerConfig } from '../components/prompt-area/types';
import {
  buildSessionComposerSubmit,
  buildSessionFileSuggestions,
  type SessionComposerSubmit,
} from './session-file-composer-model';

export function SessionFileComposer({
  projectId,
  onSendMessage,
}: {
  projectId: string;
  onSendMessage: (message: SessionComposerSubmit) => void;
}): JSX.Element {
  const composer = usePromptAreaState();
  const promptAreaRef = composer.bind.ref as React.RefObject<PromptAreaHandle>;
  const triggers = useMemo<TriggerConfig[]>(() => [{
    char: '@',
    position: 'any',
    mode: 'dropdown',
    chipStyle: 'pill',
    accessibilityLabel: 'file',
    emptyMessage: '没有匹配的文件',
    searchDebounceMs: 180,
    onSearch: async (query, { signal }) => {
      const trimmed = query.trim();
      if (!trimmed) {
        const library = await api.listProjectFiles(projectId, {});
        if (signal.aborted) return [];
        return buildSessionFileSuggestions({ workspace: [], library: library.slice(0, 6) });
      }
      const [workspace, library] = await Promise.all([
        api.searchWorkspaceFiles(projectId, trimmed),
        api.listProjectFiles(projectId, { q: trimmed }),
      ]);
      if (signal.aborted) return [];
      return buildSessionFileSuggestions({ workspace: workspace.entries, library });
    },
    onSelect: (suggestion) => suggestion.label,
  }], [projectId]);

  const submit = (segments = composer.bind.value) => {
    const message = buildSessionComposerSubmit(segments);
    if (!message) return;
    onSendMessage(message);
    composer.clear();
  };

  return (
    <form
      className="deepsea-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="deepsea-composer__field">
        <PromptArea
          ref={promptAreaRef}
          value={composer.bind.value}
          onChange={composer.bind.onChange}
          className="deepsea-composer__prompt"
          triggers={triggers}
          placeholder="输入命令或 / 选择命令，支持 @ 文件、# 历史、! 上下文"
          aria-label="命令输入"
          onSubmit={submit}
          minHeight={34}
          maxHeight={120}
        />
        <div className="deepsea-composer__tools">
          <AtSign aria-hidden="true" />
          <Hash aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <button type="submit" className="deepsea-send-button" aria-label="发送">
            <SendHorizontal aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  );
}
