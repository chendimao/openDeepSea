import { ImagePlus, SendHorizontal } from 'lucide-react';
import React, { useState } from 'react';
import { ImageGenerationDialog } from '../image-generation/ImageGenerationDialog';
import type { SessionComposerSubmit } from './session-file-composer-model';

export function SessionComposer({
  projectId,
  sessionId,
  onSendMessage,
}: {
  projectId?: string;
  sessionId?: string;
  onSendMessage: (message: string | SessionComposerSubmit) => void;
}): JSX.Element {
  const [content, setContent] = useState('');
  const [imageDialogOpen, setImageDialogOpen] = useState(false);

  return (
    <>
      <form
        className="session-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const next = content.trim();
          if (!next) return;
          onSendMessage(next);
          setContent('');
        }}
      >
        <label className="session-label" htmlFor="session-composer-input">Message</label>
        <textarea
          id="session-composer-input"
          className="session-textarea"
          value={content}
          onChange={(event) => setContent(event.currentTarget.value)}
          placeholder="继续当前 session，或输入 /status、/compact、/new"
        />
        {projectId && sessionId && (
          <button
            type="button"
            className="session-command-button"
            aria-label="生成图片"
            onClick={() => setImageDialogOpen(true)}
          >
            <ImagePlus aria-hidden="true" />
          </button>
        )}
        <button type="submit" className="session-command-button" data-variant="primary">
          <SendHorizontal aria-hidden="true" />
          <span>Send</span>
        </button>
      </form>
      {projectId && sessionId && (
        <ImageGenerationDialog
          projectId={projectId}
          sessionId={sessionId}
          open={imageDialogOpen}
          onOpenChange={setImageDialogOpen}
        />
      )}
    </>
  );
}
