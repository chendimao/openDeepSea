import type { ReactNode } from 'react';

export type StructuredJsonValue =
  | null
  | boolean
  | number
  | string
  | StructuredJsonValue[]
  | { [key: string]: StructuredJsonValue };

export type StructuredJsonObject = { [key: string]: StructuredJsonValue };

const jsonFieldLabels: Record<string, string> = {
  agent_id: '智能体',
  benefits: '收益',
  choice_options: '候选方案',
  command: '命令',
  confidence: '置信度',
  description: '描述',
  execution_intent: '执行意图',
  goal: '目标',
  id: 'ID',
  maturity: '成熟度',
  missing_questions: '缺失问题',
  next_steps: '下一步',
  passed: '是否通过',
  ready: '是否就绪',
  reason: '原因',
  recommended: '推荐',
  recommended_mode: '推荐模式',
  risks: '风险',
  stage: '阶段',
  state: '状态',
  status: '状态',
  summary: '摘要',
  superpowers: '超能力',
  task_execution: '任务执行',
  task_readiness: '任务准备状态',
  tddEvidence: 'TDD 证据',
  title: '标题',
};

export function StructuredJsonTree({ value }: { value: StructuredJsonValue }): JSX.Element {
  return <StructuredJsonNode value={value} depth={0} />;
}

function StructuredJsonNode({ value, depth }: { value: StructuredJsonValue; depth: number }): JSX.Element {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="json-empty">[]</span>;
    if (value.every(isJsonPrimitiveValue)) {
      return (
        <ul className="json-inline-list">
          {value.map((item, index) => (
            <li key={index}>
              <JsonPrimitive value={item} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div className="json-card-grid">
        {value.map((item, index) => (
          <JsonCard key={index} value={item} index={index} depth={depth + 1} />
        ))}
      </div>
    );
  }

  if (isStructuredJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="json-empty">{'{}'}</span>;
    if (depth > 0) return <JsonObjectFields entries={entries} depth={depth} />;
    return (
      <dl className="json-tree-list">
        {entries.map(([key, entryValue]) => (
          <div key={key} className={`json-tree-row ${getJsonTreeRowClass(entryValue)}`}>
            <dt>
              <span>{getStructuredJsonFieldLabel(key)}</span>
              {hasStructuredJsonFieldLabel(key) ? <small>{key}</small> : null}
            </dt>
            <dd><StructuredJsonNode value={entryValue} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }

  return <JsonPrimitive value={value} />;
}

export function getStructuredJsonFieldLabel(key: string): string {
  return jsonFieldLabels[key] ?? key;
}

export function hasStructuredJsonFieldLabel(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(jsonFieldLabels, key);
}

export function isStructuredJsonObject(value: StructuredJsonValue): value is StructuredJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toStructuredJsonValue(value: unknown): StructuredJsonValue {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => toStructuredJsonValue(item));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return {};
    return Object.fromEntries(
      entries
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, toStructuredJsonValue(entryValue)]),
    );
  }
  return String(value);
}

function getJsonTreeRowClass(value: StructuredJsonValue): string {
  if (Array.isArray(value) || isStructuredJsonObject(value)) return 'is-nested';
  if (typeof value === 'string' && getTextDisplayWidth(value) > 24) return 'is-long';
  return 'is-compact';
}

function getTextDisplayWidth(value: string): number {
  return Array.from(value).reduce((width, character) => (
    width + (character.charCodeAt(0) > 255 ? 2 : 1)
  ), 0);
}

function JsonCard({ value, index, depth }: { value: StructuredJsonValue; index: number; depth: number }): JSX.Element {
  const title = getJsonCardTitle(value, index);

  return (
    <article className="json-card">
      <div className="json-card-title">
        <span>{title}</span>
        <small>#{index + 1}</small>
      </div>
      {isStructuredJsonObject(value) ? (
        <JsonObjectFields entries={Object.entries(value)} depth={depth} />
      ) : Array.isArray(value) ? (
        <StructuredJsonNode value={value} depth={depth + 1} />
      ) : (
        <div className="json-card-value">
          <JsonPrimitive value={value} />
        </div>
      )}
    </article>
  );
}

function JsonObjectFields({
  entries,
  depth,
}: {
  entries: Array<[string, StructuredJsonValue]>;
  depth: number;
}): JSX.Element {
  return (
    <dl className="json-card-fields">
      {entries.map(([key, entryValue]) => (
        <div key={key} className={`json-card-field ${getJsonTreeRowClass(entryValue)}`}>
          <dt>
            <span>{getStructuredJsonFieldLabel(key)}</span>
            {hasStructuredJsonFieldLabel(key) ? <small>{key}</small> : null}
          </dt>
          <dd><StructuredJsonNode value={entryValue} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  );
}

function getJsonCardTitle(value: StructuredJsonValue, index: number): string {
  if (!isStructuredJsonObject(value)) return `项目 ${index + 1}`;
  const titleValue = value.title ?? value.stage ?? value.status ?? value.state ?? value.id ?? value.agent_id;
  if (typeof titleValue === 'string' && titleValue.trim()) return titleValue;
  if (typeof titleValue === 'number') return String(titleValue);
  if (typeof titleValue === 'boolean') return titleValue ? '是' : '否';
  return `项目 ${index + 1}`;
}

function isJsonPrimitiveValue(
  value: StructuredJsonValue,
): value is Exclude<StructuredJsonValue, StructuredJsonValue[] | StructuredJsonObject> {
  return !Array.isArray(value) && !isStructuredJsonObject(value);
}

function JsonPrimitive({ value }: { value: Exclude<StructuredJsonValue, StructuredJsonValue[] | StructuredJsonObject> }): ReactNode {
  if (value === null) return <span className="json-primitive is-null">null</span>;
  if (typeof value === 'boolean') {
    return <span className="json-primitive is-boolean">{value ? '是' : '否'}</span>;
  }
  if (typeof value === 'number') return <span className="json-primitive is-number">{String(value)}</span>;
  return <span className="json-primitive is-string">{value}</span>;
}
