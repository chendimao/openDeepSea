import { Activity, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ChatActivityMessageProps {
  content: string;
  loading: boolean;
}

export function ChatActivityMessage({
  content,
  loading,
}: ChatActivityMessageProps): JSX.Element {
  const Icon = loading ? Loader2 : Activity;

  return (
    <span className={cn('chat-activity-message', loading && 'is-loading')}>
      <span className="chat-activity-icon" aria-hidden="true">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
      </span>
      <span className="chat-activity-copy">{content}</span>
    </span>
  );
}
