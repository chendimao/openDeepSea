import { useEffect } from 'react';
import { sessionSocket, type WsServerEvent } from '../lib/ws';

export type ImageGenerationWsEvent = Extract<WsServerEvent, {
  type:
    | 'image_job:created'
    | 'image_job:updated'
    | 'image_job:failed'
    | 'image_job:canceled'
    | 'image_job:output_added'
    | 'image_job:completed';
}>;

const projectSubscriptionRefs = new Map<string, number>();

export function useImageGenerationEvents(
  projectId: string,
  onEvent: (event: ImageGenerationWsEvent) => void,
): void {
  useEffect(() => {
    retainProjectSubscription(projectId);
    const off = sessionSocket.on((event) => {
      if (isImageGenerationEvent(event) && event.projectId === projectId) {
        onEvent(event);
      }
    });
    return () => {
      off();
      releaseProjectSubscription(projectId);
    };
  }, [projectId, onEvent]);
}

function retainProjectSubscription(projectId: string): void {
  const current = projectSubscriptionRefs.get(projectId) ?? 0;
  projectSubscriptionRefs.set(projectId, current + 1);
  if (current === 0) sessionSocket.subscribeProject(projectId);
}

function releaseProjectSubscription(projectId: string): void {
  const current = projectSubscriptionRefs.get(projectId) ?? 0;
  if (current <= 1) {
    projectSubscriptionRefs.delete(projectId);
    sessionSocket.unsubscribeProject(projectId);
    return;
  }
  projectSubscriptionRefs.set(projectId, current - 1);
}

function isImageGenerationEvent(event: WsServerEvent): event is ImageGenerationWsEvent {
  return event.type.startsWith('image_job:');
}
