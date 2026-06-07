import { ArrowRight, GitBranch, Image as ImageIcon } from 'lucide-react';
import type { ImageGenerationOutput, ImageJobDetailResponse } from '../lib/types';

interface ImageLineagePanelProps {
  details: ImageJobDetailResponse[];
}

interface ImageLineageItem {
  id: string;
  parentPrompt: string;
  parentName: string;
  parentUrl: string;
  childPrompt: string;
  childName: string;
  childUrl: string;
}

export function ImageLineagePanel({ details }: ImageLineagePanelProps): JSX.Element {
  const items = buildImageLineageItems(details);
  if (items.length === 0) return <></>;

  return (
    <section aria-label="图生图链路" className="mb-4 border-b border-[var(--color-border)] pb-4">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
        <GitBranch className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
        <span>图生图链路</span>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <article key={item.id} className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-center gap-2 border border-[var(--color-border)] bg-[var(--color-bg-soft)] p-2">
            <ImageNode
              title={item.parentName}
              subtitle={item.parentPrompt}
              url={item.parentUrl}
              alt={`源图 ${item.parentName}`}
            />
            <span className="flex h-7 w-7 items-center justify-center text-[var(--color-fg-subtle)]" aria-hidden="true">
              <ArrowRight className="h-4 w-4" />
            </span>
            <ImageNode
              title={item.childName}
              subtitle={item.childPrompt}
              url={item.childUrl}
              alt={`生成图 ${item.childName}`}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

export function buildImageLineageItems(details: ImageJobDetailResponse[]): ImageLineageItem[] {
  const detailsByJobId = new Map(details.map((detail) => [detail.job.id, detail]));
  const outputsById = new Map<string, ImageGenerationOutput>();
  for (const detail of details) {
    for (const output of detail.outputs) {
      outputsById.set(output.id, output);
    }
  }

  return details.flatMap((childDetail) =>
    childDetail.source_images
      .filter((source) => source.origin_job_id && source.origin_output_id)
      .flatMap((source) => {
        const parentDetail = source.origin_job_id ? detailsByJobId.get(source.origin_job_id) : undefined;
        const parentOutput = source.origin_output_id ? outputsById.get(source.origin_output_id) : undefined;
        const childOutputs = childDetail.outputs.length > 0 ? childDetail.outputs : [null];
        return childOutputs.map((childOutput) => ({
          id: `${source.id}:${childOutput?.id ?? 'pending'}`,
          parentPrompt: parentDetail?.job.prompt ?? '源图',
          parentName: parentOutput?.name ?? `源图 ${source.slot}`,
          parentUrl: parentOutput?.url ?? source.url,
          childPrompt: childDetail.job.prompt,
          childName: childOutput?.name ?? '等待输出',
          childUrl: childOutput?.url ?? '',
        }));
      }),
  );
}

function ImageNode(input: { title: string; subtitle: string; url: string; alt: string }): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-2">
      <span className="flex h-11 w-11 overflow-hidden border border-[var(--color-border)] bg-[var(--color-panel)]">
        {input.url ? (
          <img src={input.url} alt={input.alt} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[var(--color-fg-subtle)]">
            <ImageIcon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-semibold text-[var(--color-fg)]">{input.title}</span>
        <span className="mt-0.5 block line-clamp-2 text-[10px] leading-snug text-[var(--color-fg-muted)]">
          {input.subtitle}
        </span>
      </span>
    </div>
  );
}
