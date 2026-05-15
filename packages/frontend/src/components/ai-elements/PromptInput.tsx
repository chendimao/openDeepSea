import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function PromptInputShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-shell', className)}>{children}</div>;
}

export function PromptInputAttachmentShelf({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-attachment-shelf', className)}>{children}</div>;
}

export function PromptInputToolbar({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-toolbar', className)}>{children}</div>;
}

export function PromptInputHint({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-hint', className)}>{children}</div>;
}

export function PromptInputActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-prompt-actions', className)}>{children}</div>;
}
