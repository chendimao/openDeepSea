import { HumanMessage, SystemMessage } from '@langchain/core/messages';
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

interface ModelRoomSearchPayload {
  query: string;
  rooms: Array<{
    id: string;
    name: string;
    description: string | null;
    messages: string[];
    tasks: Array<{ title: string; description: string | null }>;
  }>;
}

interface ParsedModelResult {
  roomId: string;
  score: number;
  reason: string;
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

  if (input.forceKeywordOnly) {
    return buildResponse(query, 'keyword', false, null, keywordResults);
  }

  const invokeModel = input.invokeModel ?? invokeConfiguredModelText;
  const modelCandidates = selectModelCandidates(candidates, keywordResults);
  if (modelCandidates.length === 0) {
    return buildResponse(query, 'keyword', true, 'model_empty', keywordResults);
  }

  try {
    const raw = await invokeModel(buildModelMessages(buildModelPayload(query, modelCandidates)));
    const modelResults = parseModelResults(raw, modelCandidates, keywordResults);
    if (modelResults.length === 0) {
      return buildResponse(query, 'keyword', true, 'model_empty', keywordResults);
    }
    return buildResponse(query, 'semantic', false, null, modelResults);
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'model_invalid_response' : 'model_failed';
    return buildResponse(query, 'keyword', true, reason, keywordResults);
  }
}

function selectModelCandidates(candidates: RoomCandidate[], keywordResults: RoomSearchResult[]): RoomCandidate[] {
  if (keywordResults.length === 0) return candidates.slice(0, 30);
  const candidateByRoomId = new Map(candidates.map((candidate) => [candidate.room.id, candidate]));
  return keywordResults
    .slice(0, 30)
    .map((result) => candidateByRoomId.get(result.room.id))
    .filter((candidate): candidate is RoomCandidate => Boolean(candidate));
}

function buildModelPayload(query: string, candidates: RoomCandidate[]): ModelRoomSearchPayload {
  return {
    query,
    rooms: candidates.map((candidate) => ({
      id: candidate.room.id,
      name: candidate.room.name,
      description: candidate.room.description,
      messages: candidate.messages.slice(0, 8).map((message) => truncateForModel(message.content)),
      tasks: candidate.tasks.slice(0, 8).map((task) => ({
        title: truncateForModel(task.title),
        description: task.description ? truncateForModel(task.description) : null,
      })),
    })),
  };
}

function buildModelMessages(payload: ModelRoomSearchPayload): Array<SystemMessage | HumanMessage> {
  return [
    new SystemMessage([
      '你是 OpenDeepSea 的群聊搜索排序器。',
      '根据用户查询判断候选群聊是否相关，并按相关度返回 JSON。',
      '只输出 JSON，不要输出解释文本。',
      '输出格式：{"results":[{"roomId":"...","score":0.9,"reason":"..."}]}',
      'score 必须是 0 到 1。低于 0.2 的弱相关候选不要返回。',
      '只能返回输入候选中存在的 room id。',
    ].join('\n')),
    new HumanMessage(JSON.stringify(payload)),
  ];
}

function parseModelResults(
  raw: string,
  candidates: RoomCandidate[],
  keywordResults: RoomSearchResult[],
): RoomSearchResult[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new SyntaxError('model response missing results');
  }

  const candidateByRoomId = new Map(candidates.map((candidate) => [candidate.room.id, candidate]));
  const keywordByRoomId = new Map(keywordResults.map((result) => [result.room.id, result]));
  const results: RoomSearchResult[] = [];
  for (const item of (parsed as { results: unknown[] }).results) {
    const modelResult = normalizeModelResult(item);
    if (!modelResult) continue;
    const candidate = candidateByRoomId.get(modelResult.roomId);
    if (!candidate) continue;
    const keywordResult = keywordByRoomId.get(modelResult.roomId);
    results.push({
      room: candidate.room,
      score: modelResult.score,
      matchedFields: keywordResult?.matchedFields ?? inferMatchedFields(candidate),
      highlights: [modelResult.reason, ...(keywordResult?.highlights ?? [])].filter(Boolean).slice(0, 3),
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

function normalizeModelResult(value: unknown): ParsedModelResult | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['roomId'] !== 'string') return null;
  const rawScore = Number(record['score']);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.max(0, Math.min(1, rawScore));
  if (score < 0.2) return null;
  return {
    roomId: record['roomId'],
    score,
    reason: typeof record['reason'] === 'string' ? truncateText(record['reason']) : '',
  };
}

function inferMatchedFields(candidate: RoomCandidate): RoomSearchMatchedField[] {
  const fields: RoomSearchMatchedField[] = ['room_name'];
  if (candidate.room.description) fields.push('room_description');
  if (candidate.messages.length > 0) fields.push('message');
  if (candidate.tasks.some((task) => task.title)) fields.push('task_title');
  if (candidate.tasks.some((task) => task.description)) fields.push('task_description');
  return fields;
}

function truncateForModel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
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
    .prepare('SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC')
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
