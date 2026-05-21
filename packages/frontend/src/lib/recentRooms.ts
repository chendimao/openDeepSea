import type { Project, Room } from './types';

export const RECENT_ROOMS_STORAGE_KEY = 'opendeepsea.recentRooms.v1';
export const RECENT_ROOMS_UPDATED_EVENT = 'opendeepsea:recent-rooms-updated';
export const RECENT_ROOMS_LIMIT = 8;

export interface RecentRoom {
  roomId: string;
  projectId: string;
  roomName: string;
  projectName: string;
  visitedAt: number;
}

export function readRecentRooms(): RecentRoom[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(RECENT_ROOMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentRoom)
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, RECENT_ROOMS_LIMIT);
  } catch {
    return [];
  }
}

export function recordRecentRoomVisit(input: { project: Project; room: Room; visitedAt?: number }): RecentRoom[] {
  if (typeof window === 'undefined') return [];

  const visitedAt = input.visitedAt ?? Date.now();
  const nextRoom: RecentRoom = {
    roomId: input.room.id,
    projectId: input.project.id,
    roomName: input.room.name,
    projectName: input.project.name,
    visitedAt,
  };
  const next = [nextRoom, ...readRecentRooms().filter((item) => (
    item.roomId !== input.room.id || item.projectId !== input.project.id
  ))]
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, RECENT_ROOMS_LIMIT);

  try {
    window.localStorage.setItem(RECENT_ROOMS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(RECENT_ROOMS_UPDATED_EVENT));
  } catch {
    // localStorage can be unavailable or full; navigation should still work.
  }

  return next;
}

function isRecentRoom(value: unknown): value is RecentRoom {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Record<keyof RecentRoom, unknown>>;
  return (
    typeof item.roomId === 'string' &&
    item.roomId.trim().length > 0 &&
    typeof item.projectId === 'string' &&
    item.projectId.trim().length > 0 &&
    typeof item.roomName === 'string' &&
    item.roomName.trim().length > 0 &&
    typeof item.projectName === 'string' &&
    item.projectName.trim().length > 0 &&
    typeof item.visitedAt === 'number' &&
    Number.isFinite(item.visitedAt)
  );
}
