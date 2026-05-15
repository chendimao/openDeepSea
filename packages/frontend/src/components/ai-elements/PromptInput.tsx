import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

type PromptInputPartProps = ComponentProps<'div'> & {
  children: ReactNode;
};

export function PromptInputShell({
  className,
  children,
  ...props
}: PromptInputPartProps): JSX.Element {
  return <div className={cn('ai-prompt-shell', className)} {...props}>{children}</div>;
}

export function PromptInputAttachmentShelf({
  className,
  children,
  ...props
}: PromptInputPartProps): JSX.Element {
  return <div className={cn('ai-prompt-attachment-shelf', className)} {...props}>{children}</div>;
}

export function PromptInputToolbar({
  className,
  children,
  ...props
}: PromptInputPartProps): JSX.Element {
  return <div className={cn('ai-prompt-toolbar', className)} {...props}>{children}</div>;
}

export function PromptInputHint({
  className,
  children,
  ...props
}: PromptInputPartProps): JSX.Element {
  return <div className={cn('ai-prompt-hint', className)} {...props}>{children}</div>;
}

export function PromptInputActions({
  className,
  children,
  ...props
}: PromptInputPartProps): JSX.Element {
  return <div className={cn('ai-prompt-actions', className)} {...props}>{children}</div>;
}
