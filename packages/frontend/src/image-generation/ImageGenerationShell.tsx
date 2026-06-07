import { Image as ImageIcon, Layers, Settings2, Sparkles } from 'lucide-react';

export function ImageGenerationShell({ projectId }: { projectId: string }): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]" data-project-id={projectId}>
      <header className="workspace-toolbar">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-display text-[15px] font-semibold leading-tight">
            <ImageIcon className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <span>图片工作台</span>
          </h1>
          <div className="mt-1 hidden truncate font-mono text-[11px] text-[var(--color-fg-muted)] sm:block">
            project:{projectId} · image generation workspace
          </div>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1 text-[11px] text-[var(--color-fg-muted)] md:flex">
          <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
          <span>任务生成、进度追踪、输出沉淀</span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[320px_minmax(300px,420px)_minmax(0,1fr)]">
        <section
          aria-labelledby="image-generation-config-heading"
          className="min-h-[220px] overflow-hidden border border-[var(--color-border)] bg-[var(--color-panel)] p-4 lg:min-h-0"
        >
          <h2 id="image-generation-config-heading" className="flex items-center gap-2 text-[13px] font-semibold">
            <Settings2 className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <span>生成设置</span>
          </h2>
          <div className="mt-4 space-y-3 text-[12px] text-[var(--color-fg-muted)]">
            <PlaceholderRow label="Provider" value="等待配置" />
            <PlaceholderRow label="Workflow" value="文生图 / 图生图" />
            <PlaceholderRow label="Prompt" value="后续任务接入表单" />
          </div>
        </section>

        <section
          aria-labelledby="image-generation-jobs-heading"
          className="min-h-[220px] overflow-hidden border border-[var(--color-border)] bg-[var(--color-panel)] p-4 lg:min-h-0"
        >
          <h2 id="image-generation-jobs-heading" className="flex items-center gap-2 text-[13px] font-semibold">
            <Layers className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <span>任务队列</span>
          </h2>
          <div className="mt-4 rounded border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-[12px] text-[var(--color-fg-muted)]">
            图片任务会在这里按状态排列
          </div>
        </section>

        <section
          aria-labelledby="image-generation-gallery-heading"
          className="min-h-[260px] overflow-hidden border border-[var(--color-border)] bg-[var(--color-panel)] p-4 lg:min-h-0"
        >
          <h2 id="image-generation-gallery-heading" className="flex items-center gap-2 text-[13px] font-semibold">
            <ImageIcon className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
            <span>项目图库</span>
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <div
                key={index}
                className="aspect-square border border-dashed border-[var(--color-border)] bg-[var(--color-bg-soft)]"
                aria-hidden="true"
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function PlaceholderRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}
