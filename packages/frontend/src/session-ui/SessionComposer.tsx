import { SendHorizontal } from 'lucide-react';
import React, { useState } from 'react';

export function SessionComposer({
  onSendMessage,
}: {
  onSendMessage: (content: string) => void;
}): JSX.Element {
  const [content, setContent] = useState('');

  return (
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
      <button type="submit" className="session-command-button" data-variant="primary">
        <SendHorizontal aria-hidden="true" />
        <span>Send</span>
      </button>
    </form>
  );
}
