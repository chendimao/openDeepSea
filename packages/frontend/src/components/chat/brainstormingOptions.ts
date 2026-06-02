import type { BrainstormingOption, Message, MessageMetadata } from '../../lib/types';

export function getBrainstormingOptionsForMessage(
  message: Message,
  metadata: MessageMetadata,
): BrainstormingOption[] {
  if (message.sender_type !== 'agent') return [];
  if (metadata.choice_options && metadata.choice_options.length > 0) {
    return metadata.choice_options;
  }
  if (metadata.brainstorming_options && metadata.brainstorming_options.length > 0) {
    return metadata.brainstorming_options;
  }
  return [];
}
