import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type MessageVariant = 'user' | 'agent' | 'system' | 'event';

export function MessageRow({
  variant,
  className,
  children,
}: {
  variant: MessageVariant;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <article className={cn('ai-message-row', `ai-message-row--${variant}`, className)}>{children}</article>;
}

export function MessageHeader({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-header', className)}>{children}</div>;
}

export function MessageBody({
  stream,
  className,
  children,
}: {
  stream?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-body', stream && 'ai-message-body--stream', className)}>{children}</div>;
}

export function MessageMeta({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-meta', className)}>{children}</div>;
}

export function MessageBadge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <span className={cn('ai-message-badge', className)}>{children}</span>;
}

export function MessageActions({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-actions', className)}>{children}</div>;
}

export function MessageAttachments({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-attachments', className)}>{children}</div>;
}

export function MessageRunPanel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return <div className={cn('ai-message-run-panel', className)}>{children}</div>;
}
