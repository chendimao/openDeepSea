export interface ComposerReplyTarget {
  messageId: string;
  senderName: string;
  excerpt: string;
  explicit: boolean;
}

export function getExplicitReplyToMessageId(replyTarget?: ComposerReplyTarget | null): string | undefined {
  return replyTarget?.explicit ? replyTarget.messageId : undefined;
}
