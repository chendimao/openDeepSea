import { useEffect } from 'react';
import { roomSocket, type WsServerEvent } from '../lib/ws';

export type ImageGenerationWsEvent = Extract<WsServerEvent, {
  type:
    | 'image_job:created'
    | 'image_job:updated'
    | 'image_job:failed'
    | 'image_job:canceled'
    | 'image_job:output_added'
    | 'image_job:completed';
}>;

export function useImageGenerationEvents(
  projectId: string,
  onEvent: (event: ImageGenerationWsEvent) => void,
): void {
  useEffect(() => {
    roomSocket.subscribeProject(projectId);
    const off = roomSocket.on((event) => {
      if (isImageGenerationEvent(event) && event.projectId === projectId) {
        onEvent(event);
      }
    });
    return () => {
      off();
      roomSocket.unsubscribeProject(projectId);
    };
  }, [projectId, onEvent]);
}

function isImageGenerationEvent(event: WsServerEvent): event is ImageGenerationWsEvent {
  return event.type.startsWith('image_job:');
}
