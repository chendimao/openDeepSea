import type { WebSocket } from 'ws';
import type { WsServerEvent } from './types.js';

class WsHub {
  private subscriptions = new Map<string, Set<WebSocket>>();

  subscribe(roomId: string, socket: WebSocket): void {
    if (!this.subscriptions.has(roomId)) this.subscriptions.set(roomId, new Set());
    this.subscriptions.get(roomId)!.add(socket);
  }

  unsubscribe(roomId: string, socket: WebSocket): void {
    this.subscriptions.get(roomId)?.delete(socket);
  }

  removeSocket(socket: WebSocket): void {
    for (const set of this.subscriptions.values()) set.delete(socket);
  }

  broadcast(roomId: string, event: WsServerEvent): void {
    const set = this.subscriptions.get(roomId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  broadcastAll(event: WsServerEvent): void {
    const payload = JSON.stringify(event);
    for (const set of this.subscriptions.values()) {
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  }
}

export const wsHub = new WsHub();
