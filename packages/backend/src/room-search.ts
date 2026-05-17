import { invokeConfiguredModelText } from './chat-model.js';
import { db } from './db.js';
import { projectRepo } from './repos/projects.js';
import type {
  Message,
  Room,
  RoomSearchMatchedField,
  RoomSearchMode,
  RoomSearchResponse,
  RoomSearchResult,
  Task,
} from './types.js';

export interface SearchProjectRoomsInput {
  projectId: string;
  query: string;
  invokeModel?: typeof invokeConfiguredModelText;
  forceKeywordOnly?: boolean;
}

interface RoomCandidate {
  room: Room;
  messages: Message[];
  tasks: Task[];
}

const STOP_WORDS = new Set([
  '的',
  '了',
  '和',
  '与',
  '或',
  '群聊',
  '搜索',
  '找到',
  '找出',
  '修复',
]);

const FIELD_WEIGHTS: Record<RoomSearchMatchedField, number> = {
  room_name: 50,
  room_description: 35,
  task_title: 30,
  task_description: 20,
  message: 15,
};

export async function searchProjectRooms(input: SearchProjectRoomsInput): Promise<RoomSearchResponse> {
  const query = input.query.trim();
  if (!query) throw new Error('query is required');
  if (!projectRepo.get(input.projectId)) throw new Error('project not found');

  const candidates = listRoomCandidates(input.projectId);
  const keywordResults = keywordSearch(candidates, query);

  return buildResponse(query, 'keyword', false, null, keywordResults);
}

function listRoomCandidates(projectId: string): RoomCandidate[] {
  const rooms = db
    .prepare('SELECT * FROM rooms WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as Room[];
  if (rooms.length === 0) return [];

  const messages = db
    .prepare(
      `SELECT messages.*
       FROM messages
       INNER JOIN rooms ON rooms.id = messages.room_id
       WHERE rooms.project_id = ?
       ORDER BY messages.created_at DESC`,
    )
    .all(projectId) as Message[];
  const tasks = db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as Task[];

  const messagesByRoom = groupByRoomId(messages);
  const tasksByRoom = groupByRoomId(tasks);
  return rooms.map((room) => ({
    room,
    messages: messagesByRoom.get(room.id) ?? [],
    tasks: tasksByRoom.get(room.id) ?? [],
  }));
}

function groupByRoomId<T extends { room_id: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.room_id) ?? [];
    list.push(item);
    grouped.set(item.room_id, list);
  }
  return grouped;
}

function keywordSearch(candidates: RoomCandidate[], query: string): RoomSearchResult[] {
  const terms = extractSearchTerms(query);
  return candidates
    .map((candidate) => scoreCandidate(candidate, terms))
    .filter((result): result is RoomSearchResult => Boolean(result))
    .sort((a, b) => b.score - a.score || b.room.created_at - a.room.created_at);
}

function scoreCandidate(candidate: RoomCandidate, terms: string[]): RoomSearchResult | null {
  const matchedFields = new Set<RoomSearchMatchedField>();
  const highlights: string[] = [];
  let score = 0;

  const applyMatch = (field: RoomSearchMatchedField, text: string | null | undefined) => {
    const value = normalizeText(text);
    if (!value) return;
    const matchedCount = terms.filter((term) => value.includes(term)).length;
    if (matchedCount === 0) return;
    matchedFields.add(field);
    score += FIELD_WEIGHTS[field] * matchedCount;
    if (highlights.length < 3 && text) highlights.push(truncateText(text));
  };

  applyMatch('room_name', candidate.room.name);
  applyMatch('room_description', candidate.room.description);
  for (const task of candidate.tasks) {
    applyMatch('task_title', task.title);
    applyMatch('task_description', task.description);
  }
  for (const message of candidate.messages) {
    applyMatch('message', message.content);
  }

  if (score === 0) return null;
  return {
    room: candidate.room,
    score,
    matchedFields: Array.from(matchedFields),
    highlights,
  };
}

function extractSearchTerms(query: string): string[] {
  const normalized = normalizeText(query);
  const terms = new Set<string>();

  for (const token of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (!STOP_WORDS.has(token)) terms.add(token);
  }

  const chineseParts = normalized
    .replace(/[a-z0-9]+/g, ' ')
    .split(/[\s，。！？、,.!?;:：；"'“”‘’()[\]{}<>《》/\\|_-]+/)
    .flatMap(splitChinesePhrase);
  for (const part of chineseParts) {
    if (part.length > 1 && !STOP_WORDS.has(part)) terms.add(part);
  }

  if (terms.size === 0 && normalized) terms.add(normalized);
  return Array.from(terms);
}

function splitChinesePhrase(value: string): string[] {
  let remaining = value.trim();
  if (!remaining) return [];
  for (const word of STOP_WORDS) {
    remaining = remaining.split(word).join(' ');
  }

  const parts = remaining.split(/\s+/).filter(Boolean);
  const expanded: string[] = [];
  for (const part of parts) {
    expanded.push(part);
    if (part.includes('页面')) expanded.push('页面');
    if (part.includes('显示')) expanded.push('显示');
    if (part.includes('不完整')) expanded.push('不完整');
  }
  return expanded;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function truncateText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed;
}

function buildResponse(
  query: string,
  mode: RoomSearchMode,
  degraded: boolean,
  degradationReason: string | null,
  results: RoomSearchResult[],
): RoomSearchResponse {
  return {
    query,
    mode,
    degraded,
    degradationReason,
    total: results.length,
    results,
  };
}
