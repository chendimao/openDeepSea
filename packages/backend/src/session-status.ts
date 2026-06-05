import type {
  AcpPermissionMode,
  Session,
  SessionContextManifest,
  SessionEvidenceEvent,
  StatusSnapshot,
} from './types.js';

export function buildStatusSnapshot(input: {
  session: Session;
  context: SessionContextManifest | null;
  latestVerification: SessionEvidenceEvent | null;
  latestBlocker: SessionEvidenceEvent | null;
  changedFileCount: number;
  permissionMode: AcpPermissionMode | null;
}): StatusSnapshot {
  const totalTokenEstimate = input.context?.total_token_estimate ?? 0;
  return {
    goal: input.session.current_goal,
    mode: input.session.mode,
    phase: input.session.phase,
    status: input.session.status,
    context: {
      totalTokenEstimate,
      latestCompactionId: input.session.latest_compaction_id,
      retainedRecentMessages: 20,
      pressure: totalTokenEstimate > 90_000 ? 'high' : totalTokenEstimate > 45_000 ? 'medium' : 'low',
    },
    git: {
      branchName: input.session.branch_name,
      changedFileCount: input.changedFileCount,
      hasUncommittedDiff: input.changedFileCount > 0,
      conflictRisk: input.session.worktree_path ? 'low' : 'none',
    },
    verification: {
      lastCommand: readPayloadString(input.latestVerification, 'command'),
      status: readVerificationStatus(input.latestVerification),
      completedAt: input.latestVerification?.created_at ?? null,
    },
    blocker: input.latestBlocker ? {
      reason: input.latestBlocker.summary ?? input.latestBlocker.title,
      since: input.latestBlocker.created_at,
      requiredAction: readPayloadString(input.latestBlocker, 'required_action') ?? '等待用户或运行下一步命令',
    } : null,
    nextAction: {
      label: input.latestBlocker ? '处理阻塞' : '继续会话',
      command: input.latestBlocker ? '/status' : null,
      reason: input.latestBlocker ? '当前存在 blocker evidence' : '没有终态阻塞',
    },
    provider: {
      backend: input.session.provider,
      model: input.session.model,
      permissionMode: input.permissionMode,
    },
  };
}

function readPayloadString(event: SessionEvidenceEvent | null, key: string): string | null {
  const value = event?.payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readVerificationStatus(event: SessionEvidenceEvent | null): StatusSnapshot['verification']['status'] {
  const payloadStatus = event?.payload.status;
  if (payloadStatus === 'passed' || payloadStatus === 'failed') return payloadStatus;
  if (event?.severity === 'error' || event?.severity === 'critical') return 'failed';
  if (event?.event_type === 'test' || event?.event_type === 'build' || event?.event_type === 'browser_check') {
    return event.severity === 'warning' ? 'unknown' : 'passed';
  }
  return 'unknown';
}
