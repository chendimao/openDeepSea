import type { MessageKey } from './i18n';
import type { ProjectFile, ResourceDetail } from './types';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function getProjectFileTypeLabel(file: ProjectFile, t: Translate): string {
  return file.source_type === 'agent_document'
    ? t('files.source.agentDocument')
    : t('files.source.uploadedFile');
}

export function getProjectFileSourceSummary(file: ProjectFile, t: Translate): string {
  if (file.source_type === 'agent_document') {
    if (file.source_agent_id && file.source_task_id) {
      return t('files.sourceSummary.agentWithTask', {
        agent: file.source_agent_id,
        task: file.source_task_id,
      });
    }
    const roomSource = file.last_referenced_room_name ?? file.source_room_id;
    if (file.source_agent_id && roomSource) {
      return t('files.sourceSummary.agentWithRoom', {
        agent: file.source_agent_id,
        room: roomSource,
      });
    }
    if (file.source_agent_id) {
      return t('files.sourceSummary.agent', { agent: file.source_agent_id });
    }
    if (file.source_task_id) {
      return t('files.sourceSummary.task', { task: file.source_task_id });
    }
    if (roomSource) {
      return t('files.sourceSummary.room', { room: roomSource });
    }
    return t('files.sourceSummary.agentUnknown');
  }

  const roomSource = file.last_referenced_room_name ?? file.source_room_id;
  if (file.uploaded_by_name && roomSource) {
    return t('files.sourceSummary.uploadedByInRoom', {
      user: file.uploaded_by_name,
      room: roomSource,
    });
  }
  if (file.uploaded_by_name) {
    return t('files.sourceSummary.uploadedBy', { user: file.uploaded_by_name });
  }
  if (roomSource) {
    return t('files.sourceSummary.uploadedInRoom', { room: roomSource });
  }
  return t('files.sourceSummary.uploadedUnknown');
}

export function getResourceDetailSourceSummary(resource: ResourceDetail, t: Translate): string {
  if (resource.resource_type === 'agent_document') {
    const agent = resource.source.display_name ?? resource.source.agent_id ?? resource.source_agent_id;
    const context = resource.source.context;
    if (agent && context?.type === 'task') {
      return t('files.sourceSummary.agentWithTask', {
        agent,
        task: context.name ?? context.id,
      });
    }
    if (agent && context) {
      return t('files.sourceSummary.agentWithRoom', {
        agent,
        room: context.name ?? context.id,
      });
    }
    if (agent && resource.source_task_id) {
      return t('files.sourceSummary.agentWithTask', {
        agent,
        task: resource.source_task_id,
      });
    }
    if (agent && resource.source_room_id) {
      return t('files.sourceSummary.agentWithRoom', {
        agent,
        room: resource.source_room_id,
      });
    }
    if (agent) {
      return t('files.sourceSummary.agent', { agent });
    }
    if (context?.type === 'task') {
      return t('files.sourceSummary.task', { task: context.name ?? context.id });
    }
    if (context) {
      return t('files.sourceSummary.room', { room: context.name ?? context.id });
    }
    return t('files.sourceSummary.agentUnknown');
  }

  const uploader = resource.source.display_name ?? resource.source.user_id ?? resource.source_agent_id;
  const context = resource.source.context;
  if (uploader && context) {
    return t('files.sourceSummary.uploadedByInRoom', {
      user: uploader,
      room: context.name ?? context.id,
    });
  }
  if (uploader) {
    return t('files.sourceSummary.uploadedBy', { user: uploader });
  }
  if (context) {
    return t('files.sourceSummary.uploadedInRoom', { room: context.name ?? context.id });
  }
  return t('files.sourceSummary.uploadedUnknown');
}

export function projectFileMatchesKeyword(
  file: ProjectFile,
  keyword: string,
  t: Translate,
  extraValues: Array<string | null | undefined> = [],
): boolean {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return true;

  return [
    file.original_name,
    file.mime_type,
    file.source_type,
    getProjectFileTypeLabel(file, t),
    getProjectFileSourceSummary(file, t),
    file.uploaded_by_name,
    file.uploaded_by_id,
    file.source_agent_id,
    file.source_task_id,
    file.source_room_id,
    file.source_message_id,
    file.last_referenced_room_name,
    ...extraValues,
  ].some((value) => (value ?? '').toLocaleLowerCase().includes(needle));
}
