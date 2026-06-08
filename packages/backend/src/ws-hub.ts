import type { WebSocket } from 'ws';
import type { WsServerEvent } from './types.js';

class WsHub {
  private subscriptions = new Map<string, Set<WebSocket>>();
  private sessionSubscriptions = new Map<string, Set<WebSocket>>();
  private projectSubscriptions = new Map<string, Set<WebSocket>>();
  private activeSessionSubscriptions = new Set<WebSocket>();

  subscribe(roomId: string, socket: WebSocket): void {
    this.add(this.subscriptions, roomId, socket);
  }

  unsubscribe(roomId: string, socket: WebSocket): void {
    this.delete(this.subscriptions, roomId, socket);
  }

  subscribeSession(sessionId: string, socket: WebSocket): void {
    this.add(this.sessionSubscriptions, sessionId, socket);
  }

  unsubscribeSession(sessionId: string, socket: WebSocket): void {
    this.delete(this.sessionSubscriptions, sessionId, socket);
  }

  subscribeProject(projectId: string, socket: WebSocket): void {
    this.add(this.projectSubscriptions, projectId, socket);
  }

  unsubscribeProject(projectId: string, socket: WebSocket): void {
    this.delete(this.projectSubscriptions, projectId, socket);
  }

  subscribeActiveSessions(socket: WebSocket): void {
    this.activeSessionSubscriptions.add(socket);
  }

  unsubscribeActiveSessions(socket: WebSocket): void {
    this.activeSessionSubscriptions.delete(socket);
  }

  removeSocket(socket: WebSocket): void {
    this.deleteFromAll(this.subscriptions, socket);
    this.deleteFromAll(this.sessionSubscriptions, socket);
    this.deleteFromAll(this.projectSubscriptions, socket);
    this.activeSessionSubscriptions.delete(socket);
  }

  broadcast(roomId: string, event: WsServerEvent): void {
    this.broadcastTo(this.subscriptions, roomId, event);
  }

  broadcastSession(sessionId: string, event: WsServerEvent): void {
    this.broadcastTo(this.sessionSubscriptions, sessionId, event);
  }

  broadcastProject(projectId: string, event: WsServerEvent): void {
    this.broadcastTo(this.projectSubscriptions, projectId, event);
  }

  broadcastScoped(input: {
    projectId?: string | null;
    sessionId?: string | null;
    roomId?: string | null;
    event: WsServerEvent;
  }): void {
    const targets = new Set<WebSocket>();
    if (input.projectId) this.collect(this.projectSubscriptions, input.projectId, targets);
    if (input.sessionId) this.collect(this.sessionSubscriptions, input.sessionId, targets);
    if (input.roomId) this.collect(this.subscriptions, input.roomId, targets);
    this.sendToSockets(targets, JSON.stringify(input.event));
  }

  broadcastActiveSessions(event: WsServerEvent): void {
    this.sendToSet(this.activeSessionSubscriptions, JSON.stringify(event));
  }

  broadcastAll(event: WsServerEvent): void {
    const payload = JSON.stringify(event);
    const targets = new Set<WebSocket>();
    for (const set of [
      ...this.subscriptions.values(),
      ...this.sessionSubscriptions.values(),
      ...this.projectSubscriptions.values(),
    ]) {
      for (const ws of set) targets.add(ws);
    }
    for (const ws of this.activeSessionSubscriptions) targets.add(ws);
    this.sendToSockets(targets, payload);
  }

  private add(subscriptions: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    if (!subscriptions.has(key)) subscriptions.set(key, new Set());
    subscriptions.get(key)!.add(socket);
  }

  private delete(subscriptions: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const set = subscriptions.get(key);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) subscriptions.delete(key);
  }

  private deleteFromAll(subscriptions: Map<string, Set<WebSocket>>, socket: WebSocket): void {
    for (const [key, set] of subscriptions) {
      set.delete(socket);
      if (set.size === 0) subscriptions.delete(key);
    }
  }

  private broadcastTo(subscriptions: Map<string, Set<WebSocket>>, key: string, event: WsServerEvent): void {
    const set = subscriptions.get(key);
    if (!set) return;
    const payload = JSON.stringify(event);
    this.sendToSet(set, payload);
  }

  private sendToSet(set: Set<WebSocket>, payload: string): void {
    this.sendToSockets(set, payload);
  }

  private collect(subscriptions: Map<string, Set<WebSocket>>, key: string, targets: Set<WebSocket>): void {
    const set = subscriptions.get(key);
    if (!set) return;
    for (const ws of set) {
      targets.add(ws);
    }
  }

  private sendToSockets(sockets: Iterable<WebSocket>, payload: string): void {
    for (const ws of sockets) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      } catch {
        // A single broken socket must not block delivery to other subscribers.
      }
    }
  }
}

export const wsHub = new WsHub();
