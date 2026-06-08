import { ExternalLink } from 'lucide-react';
import type { SessionEvidenceEvent } from '../lib/types';

type GeneratedImageArtifact = {
  key: string;
  fileId: string;
  url: string;
  slot: number;
};

export function GeneratedImageEvidencePanel({
  evidence,
}: {
  evidence: SessionEvidenceEvent[];
}): JSX.Element | null {
  const artifacts = generatedImageArtifacts(evidence);
  if (artifacts.length === 0) return null;

  return (
    <section className="deepsea-generated-artifacts" aria-label="图片生成结果">
      <div className="deepsea-generated-artifacts__header">
        <span>图片生成结果</span>
        <small>{artifacts.length} 张</small>
      </div>
      <div className="deepsea-generated-artifacts__grid">
        {artifacts.map((artifact) => (
          <a
            key={artifact.key}
            href={artifact.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`打开生成图片：${artifact.fileId}`}
          >
            <img src={artifact.url} alt={`生成图片 ${artifact.slot}`} />
            <span>
              <ExternalLink aria-hidden="true" />
              #{artifact.slot}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

function generatedImageArtifacts(evidence: SessionEvidenceEvent[]): GeneratedImageArtifact[] {
  const artifacts: GeneratedImageArtifact[] = [];
  for (const event of evidence) {
    if (event.event_type !== 'tool_result') continue;
    if (event.payload['tool_name'] !== 'generate_image') continue;
    const outputs = event.payload['outputs'];
    if (!Array.isArray(outputs)) continue;
    outputs.forEach((output, index) => {
      if (!isRecord(output)) return;
      const fileId = readString(output, 'file_id');
      const url = readString(output, 'url');
      if (!fileId || !url) return;
      const slotValue = output['slot'];
      const slot = typeof slotValue === 'number' && Number.isFinite(slotValue) ? slotValue : index + 1;
      artifacts.push({
        key: `${event.id}:${fileId}:${slot}`,
        fileId,
        url,
        slot,
      });
    });
  }
  return artifacts.sort((left, right) => left.slot - right.slot || left.fileId.localeCompare(right.fileId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
