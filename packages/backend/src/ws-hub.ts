import type { WebSocket } from 'ws';
import type { WsServerEvent } from './types.js';

class WsHub {
  private subscriptions = new Map<string, Set<WebSocket>>();
  private sessionSubscriptions = new Map<string, Set<WebSocket>>();

  subscribe(roomId: string, socket: WebSocket): void {
    this.add(this.subscriptions, roomId, socket);
  }

  unsubscribe(roomId: string, socket: WebSocket): void {
    this.subscriptions.get(roomId)?.delete(socket);
  }

  subscribeSession(sessionId: string, socket: WebSocket): void {
    this.add(this.sessionSubscriptions, sessionId, socket);
  }

  unsubscribeSession(sessionId: string, socket: WebSocket): void {
    this.sessionSubscriptions.get(sessionId)?.delete(socket);
  }

  removeSocket(socket: WebSocket): void {
    for (const set of this.subscriptions.values()) set.delete(socket);
    for (const set of this.sessionSubscriptions.values()) set.delete(socket);
  }

  broadcast(roomId: string, event: WsServerEvent): void {
    this.broadcastTo(this.subscriptions, roomId, event);
  }

  broadcastSession(sessionId: string, event: WsServerEvent): void {
    this.broadcastTo(this.sessionSubscriptions, sessionId, event);
  }

  broadcastAll(event: WsServerEvent): void {
    const payload = JSON.stringify(event);
    for (const set of [...this.subscriptions.values(), ...this.sessionSubscriptions.values()]) {
      this.sendToSet(set, payload);
    }
  }

  private add(subscriptions: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    if (!subscriptions.has(key)) subscriptions.set(key, new Set());
    subscriptions.get(key)!.add(socket);
  }

  private broadcastTo(subscriptions: Map<string, Set<WebSocket>>, key: string, event: WsServerEvent): void {
    const set = subscriptions.get(key);
    if (!set) return;
    const payload = JSON.stringify(event);
    this.sendToSet(set, payload);
  }

  private sendToSet(set: Set<WebSocket>, payload: string): void {
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

export const wsHub = new WsHub();
