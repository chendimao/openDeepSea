import { cn } from '../../lib/utils';

interface ChatActivityMessageProps {
  content: string;
  loading: boolean;
}

export function ChatActivityMessage({
  content,
  loading,
}: ChatActivityMessageProps): JSX.Element {
  return (
    <span className={cn('chat-activity-message', loading && 'is-loading')}>
      <span className="chat-activity-pulse" aria-hidden="true" />
      <span className="chat-activity-copy">{content}</span>
    </span>
  );
}
