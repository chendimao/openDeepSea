import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECENT_ROOMS_LIMIT,
  RECENT_ROOMS_STORAGE_KEY,
  readRecentRooms,
  recordRecentRoomVisit,
} from './recentRooms';
import type { Project, Room } from './types';

test('recent rooms ignore malformed localStorage data', () => {
  installMockWindow();
  window.localStorage.setItem(RECENT_ROOMS_STORAGE_KEY, '{"bad":true}');

  assert.deepEqual(readRecentRooms(), []);
});

test('recent rooms dedupe repeated visits and move latest visit to top', () => {
  installMockWindow();
  const project = createProject('project-1', '深海指挥中心');
  const roomA = createRoom('room-a', project.id, '功能开发');
  const roomB = createRoom('room-b', project.id, '代码审查');

  recordRecentRoomVisit({ project, room: roomA, visitedAt: 100 });
  recordRecentRoomVisit({ project, room: roomB, visitedAt: 200 });
  recordRecentRoomVisit({ project, room: roomA, visitedAt: 300 });

  assert.deepEqual(readRecentRooms().map((room) => room.roomId), ['room-a', 'room-b']);
  assert.equal(readRecentRooms()[0]?.visitedAt, 300);
});

test('recent rooms keep only the latest bounded history', () => {
  installMockWindow();
  const project = createProject('project-1', '深海指挥中心');

  for (let index = 0; index < RECENT_ROOMS_LIMIT + 2; index += 1) {
    recordRecentRoomVisit({
      project,
      room: createRoom(`room-${index}`, project.id, `群聊 ${index}`),
      visitedAt: index,
    });
  }

  const rooms = readRecentRooms();
  assert.equal(rooms.length, RECENT_ROOMS_LIMIT);
  assert.equal(rooms[0]?.roomId, `room-${RECENT_ROOMS_LIMIT + 1}`);
  assert.equal(rooms.at(-1)?.roomId, 'room-2');
});

function installMockWindow(): void {
  const storage = new Map<string, string>();
  const mockWindow = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    dispatchEvent: () => true,
  };

  Object.defineProperty(globalThis, 'window', {
    value: mockWindow,
    configurable: true,
  });
}

function createProject(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    description: null,
    message_routing_mode: 'mentions_only',
    fallback_agent_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

function createRoom(id: string, projectId: string, name: string): Room {
  return {
    id,
    project_id: projectId,
    name,
    description: null,
    created_at: 1,
  };
}
