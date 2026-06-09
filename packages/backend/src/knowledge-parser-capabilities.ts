import type { KnowledgeParserStatus } from './knowledge-types.js';

const OFFICE_MIME_MARKERS = [
  'officedocument',
  'msword',
  'ms-excel',
  'ms-powerpoint',
  'vnd.ms-',
  'vnd.oasis.opendocument',
];

const OFFICE_EXTENSIONS = [
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.pages',
  '.numbers',
  '.key',
];

export interface ParserMetadataInput {
  title: string;
  mimeType: string | null;
  parser: string;
  status: KnowledgeParserStatus;
  capabilities: string[];
  warnings?: string[];
  requiresSidecar?: boolean;
  extras?: Record<string, unknown>;
}

export interface CsvTableMetadata {
  table: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface StructuredTextMetadata {
  layout: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export function buildParserMetadata(input: ParserMetadataInput): Record<string, unknown> {
  return {
    parser_status: input.status,
    parser_capabilities: [...new Set(input.capabilities)],
    parser_warnings: input.warnings ?? [],
    requires_sidecar: input.requiresSidecar ?? false,
    source_mime_type: input.mimeType,
    source_title: input.title,
    ...input.extras,
  };
}

export function extractCsvTableMetadata(content: string, sampleLimit = 3): CsvTableMetadata {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const columns = splitCsvLine(lines[0] ?? '')
    .map((column) => column.trim())
    .filter(Boolean);
  const sampleRows = lines.slice(1, sampleLimit + 1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']));
  });
  const rowCount = Math.max(0, lines.length - 1);

  return {
    table: {
      kind: 'csv',
      columns,
      row_count: rowCount,
      sample_rows: sampleRows,
    },
    metadata: {
      table_kind: 'csv',
      table_columns: columns,
      table_row_count: rowCount,
      table_sample_rows: sampleRows,
    },
  };
}

export function extractStructuredTextMetadata(input: {
  title: string;
  mimeType: string;
  content: string;
}): StructuredTextMetadata | null {
  const lowerTitle = input.title.toLowerCase();
  if (input.mimeType.includes('json') || lowerTitle.endsWith('.json')) {
    return extractJsonMetadata(input.content);
  }
  if (input.mimeType.includes('yaml') || input.mimeType.includes('yml') || /\.(ya?ml)$/i.test(input.title)) {
    return extractYamlMetadata(input.content);
  }
  return null;
}

export function isSidecarDocument(title: string, mimeType: string): boolean {
  const lowerTitle = title.toLowerCase();
  if (mimeType.includes('pdf') || lowerTitle.endsWith('.pdf')) return true;
  return OFFICE_MIME_MARKERS.some((marker) => mimeType.includes(marker)) ||
    OFFICE_EXTENSIONS.some((extension) => lowerTitle.endsWith(extension));
}

function extractJsonMetadata(content: string): StructuredTextMetadata {
  try {
    const parsed = JSON.parse(content) as unknown;
    const keys = topLevelKeys(parsed);
    const nodeCount = countNodes(parsed);
    return {
      layout: {
        kind: 'json',
        top_level_keys: keys,
        node_count: nodeCount,
      },
      metadata: {
        structured_kind: 'json',
        structured_keys: keys,
        structured_node_count: nodeCount,
      },
    };
  } catch {
    return {
      layout: {
        kind: 'json',
        top_level_keys: [],
        node_count: 0,
      },
      metadata: {
        structured_kind: 'json',
        structured_keys: [],
        structured_node_count: 0,
        parser_warnings: ['JSON structure could not be parsed; indexed as plain text'],
      },
    };
  }
}

function extractYamlMetadata(content: string): StructuredTextMetadata {
  const keys = [...new Set(
    content
      .split('\n')
      .map((line) => line.match(/^([A-Za-z0-9_.-]+)\s*:/)?.[1])
      .filter((key): key is string => Boolean(key)),
  )].slice(0, 50);

  return {
    layout: {
      kind: 'yaml',
      top_level_keys: keys,
      node_count: keys.length,
    },
    metadata: {
      structured_kind: 'yaml',
      structured_keys: keys,
      structured_node_count: keys.length,
    },
  };
}

function topLevelKeys(value: unknown): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).slice(0, 50);
  }
  return [];
}

function countNodes(value: unknown, limit = 1000): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (count >= limit) return;
    count += 1;
    if (!node || typeof node !== 'object') return;
    const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of values) visit(child);
  };
  visit(value);
  return count;
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}
