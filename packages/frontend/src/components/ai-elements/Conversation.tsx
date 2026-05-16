import { ArrowDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps): JSX.Element {
  return (
    <StickToBottom
      className={cn('ai-conversation', className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export function ConversationContent({
  className,
  scrollClassName,
  children,
  ...props
}: ConversationContentProps): JSX.Element {
  const context = useStickToBottomContext();

  return (
    <div
      ref={context.scrollRef}
      className={cn('ai-conversation-scroll', scrollClassName)}
      data-testid="chat-scroll-container"
    >
      <div className={cn('ai-conversation-content', className)} ref={context.contentRef} {...props}>
        {typeof children === 'function'
          ? (children as (context: ReturnType<typeof useStickToBottomContext>) => ReactNode)(context)
          : children}
      </div>
    </div>
  );
}

export function ConversationEmptyState({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-conversation-empty', className)}>{children}</div>;
}

export function ConversationScrollButton({
  className,
  label,
}: {
  className?: string;
  label: string;
}): JSX.Element | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => scrollToBottom(), [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={cn('ai-scroll-button', className)}
      onClick={handleScrollToBottom}
      aria-label={label}
      title={label}
    >
      <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.9} />
    </Button>
  );
}
