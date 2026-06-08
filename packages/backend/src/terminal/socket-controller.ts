import type { WebSocket } from 'ws';
import { z } from 'zod';
import { terminalService } from './service.js';
import type { WsClientEvent } from '../types.js';

const terminalSocketEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal:subscribe'), sessionId: z.string().trim().min(1) }),
  z.object({ type: z.literal('terminal:unsubscribe'), sessionId: z.string().trim().min(1) }),
  z.object({ type: z.literal('terminal:input'), sessionId: z.string().trim().min(1), data: z.string() }),
  z.object({
    type: z.literal('terminal:resize'),
    sessionId: z.string().trim().min(1),
    cols: z.number().int().min(20).max(240),
    rows: z.number().int().min(8).max(80),
  }),
  z.object({ type: z.literal('terminal:kill'), sessionId: z.string().trim().min(1) }),
]);

export function handleTerminalSocketEvent(socket: WebSocket, event: WsClientEvent): boolean {
  const parsed = terminalSocketEventSchema.safeParse(event);
  if (!parsed.success) return false;
  try {
    if (parsed.data.type === 'terminal:subscribe') {
      terminalService.subscribe(parsed.data.sessionId, socket);
      return true;
    }
    if (parsed.data.type === 'terminal:unsubscribe') {
      terminalService.unsubscribe(parsed.data.sessionId, socket);
      return true;
    }
    if (parsed.data.type === 'terminal:input') {
      terminalService.input(parsed.data.sessionId, parsed.data.data);
      return true;
    }
    if (parsed.data.type === 'terminal:resize') {
      terminalService.resize(parsed.data.sessionId, parsed.data.cols, parsed.data.rows);
      return true;
    }
    if (parsed.data.type === 'terminal:kill') {
      terminalService.kill(parsed.data.sessionId);
      return true;
    }
    return false;
  } catch (err) {
    const sessionId = 'sessionId' in parsed.data ? parsed.data.sessionId : '';
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'terminal:output', sessionId, data: `\r\n${(err as Error).message}\r\n` }));
    }
    return true;
  }
}

export function removeTerminalSocket(socket: WebSocket): void {
  terminalService.removeSocket(socket);
}
