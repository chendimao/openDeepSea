import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  Download,
  Image as ImageIcon,
  ListFilter,
  Loader2,
  Maximize2,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  SlidersHorizontal,
  Square,
  Trash2,
  Wand2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import type {
  ImageGenerationJob,
  ImageGenerationOutput,
  ImageGenerationWorkflow,
  ImageJobCreateInput,
  ImageJobDetailResponse,
  ImageJobListResponse,
  ImageProviderProfile,
  ProjectFile,
} from '../lib/types';
import { ProviderProfilePanel } from './ProviderProfilePanel';
import { SourceImagePicker } from './SourceImagePicker';
import { useImageGenerationEvents, type ImageGenerationWsEvent } from './useImageGenerationEvents';

export type FormState = {
  workflow: ImageGenerationWorkflow;
  sourceFiles: ProjectFile[];
  count: number;
  quality: string;
  size: string;
  style: string;
  prompt: string;
  negativePrompt: string;
};

export type ResultAsset = {
  id: string;
  outputId: string | null;
  label: string;
  url?: string;
  gradient: string;
  aspect: '16:9' | '4:3';
  video?: boolean;
};

export type ResultGroup = {
  id: string;
  createdAt: number;
  prompt: string;
  model: string;
  size: string;
  quality: string;
  count: number;
  assets: ResultAsset[];
};

const DEFAULT_PROMPT = '一座未来感的海上城市，日落时分，天空橙紫色，飞行器在城市上空穿梭，数字艺术风格，高细节，电影级光影。';

const demoJobs: ImageGenerationJob[] = [
  {
    id: 'demo-running',
    project_id: 'demo',
    room_id: null,
    session_id: null,
    source_message_id: null,
    source_agent_id: null,
    source_task_id: null,
    provider_profile_id: 'demo-profile',
    workflow: 'generate',
    prompt: DEFAULT_PROMPT,
    count: 2,
    quality: 'high',
    size: '1792x1024',
    status: 'running',
    message: null,
    error: null,
    created_at: 1717838625000,
    started_at: 1717838627000,
    completed_at: null,
    updated_at: 1717838642000,
  },
];

const demoResults: ResultGroup[] = [
  {
    id: 'demo-result-city',
    createdAt: 1717838625000,
    prompt: DEFAULT_PROMPT,
    model: 'gpt-image-2',
    size: '16:9',
    quality: '高清',
    count: 2,
    assets: [
      {
        id: 'city-1',
        outputId: null,
        label: 'future-city-a.png',
        aspect: '16:9',
        gradient: 'linear-gradient(135deg, #dbeafe 0%, #f59e0b 34%, #312e81 100%)',
      },
      {
        id: 'city-2',
        outputId: null,
        label: 'future-city-b.png',
        aspect: '16:9',
        gradient: 'linear-gradient(135deg, #0f172a 0%, #2563eb 44%, #f97316 100%)',
      },
    ],
  },
  {
    id: 'demo-result-landscape',
    createdAt: 1717838313000,
    prompt: '雪山湖泊，清晨薄雾，阳光穿透云层，宁静的自然风景，超真实摄影风格。',
    model: 'gpt-image-2',
    size: '4:3',
    quality: '超清',
    count: 4,
    assets: [
      {
        id: 'landscape-1',
        outputId: null,
        label: 'morning-alpine-a.png',
        aspect: '4:3',
        gradient: 'linear-gradient(135deg, #f59e0b 0%, #fef3c7 44%, #78350f 100%)',
      },
      {
        id: 'landscape-2',
        outputId: null,
        label: 'morning-alpine-b.png',
        aspect: '4:3',
        gradient: 'linear-gradient(135deg, #0f766e 0%, #ecfeff 50%, #475569 100%)',
      },
      {
        id: 'landscape-3',
        outputId: null,
        label: 'morning-alpine-c.png',
        aspect: '4:3',
        gradient: 'linear-gradient(135deg, #ea580c 0%, #fde68a 48%, #4d7c0f 100%)',
      },
      {
        id: 'landscape-4',
        outputId: null,
        label: 'morning-alpine-preview.mp4',
        aspect: '4:3',
        video: true,
        gradient: 'radial-gradient(circle at 45% 42%, #737373 0%, #525252 42%, #262626 100%)',
      },
    ],
  },
];

const demoHistory = [
  { id: 'h1', title: '未来海上城市', meta: '16:9 · 高清 · 2 张', time: '10:23', duration: '0:18', status: '完成', tone: 'success' },
  { id: 'h2', title: '雪山湖泊风景', meta: '4:3 · 超清 · 4 张', time: '10:18', duration: '0:18', status: '完成', tone: 'success' },
  { id: 'h3', title: '赛博朋克城市街道', meta: '9:16 · 高清 · 2 张', time: '昨天 18:42', duration: '0:27', status: '完成', tone: 'success' },
  { id: 'h4', title: '宇航员在火星表面', meta: '1:1 · 标准 · 1 张', time: '昨天 16:30', duration: '0:13', status: '失败', tone: 'danger' },
];

export function ImageGenerationShell({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({
    workflow: 'generate',
    sourceFiles: [],
    count: 2,
    quality: 'high',
    size: '1792x1024',
    style: 'natural',
    prompt: DEFAULT_PROMPT,
    negativePrompt: '',
  });
  const queryKey = useMemo(() => ['image-jobs', projectId] as const, [projectId]);
  const { data: profiles = [] } = useQuery({
    queryKey: ['image-provider-profiles', projectId],
    queryFn: () => api.listImageProviderProfiles(projectId),
  });
  const activeProfile = profiles.find((profile) => profile.active === 1) ?? profiles[0] ?? null;
  const { data: jobsResponse } = useQuery({
    queryKey,
    queryFn: () => api.listImageJobs(projectId),
  });
  const jobs = jobsResponse?.jobs ?? [];
  const completedJobIds = useMemo(
    () => jobs.filter((job) => job.status === 'completed').slice(0, 8).map((job) => job.id),
    [jobs],
  );
  const { data: details = [] } = useQuery({
    queryKey: ['image-workbench-job-details', projectId, completedJobIds],
    queryFn: () => Promise.all(completedJobIds.map((jobId) => api.getImageJob(projectId, jobId))),
    enabled: completedJobIds.length > 0,
  });

  const updateJobCache = useCallback((event: ImageGenerationWsEvent) => {
    if ('job' in event) {
      queryClient.setQueryData<ImageJobListResponse>(queryKey, (current) => ({
        jobs: upsertJob(current?.jobs ?? [], event.job),
      }));
      void queryClient.invalidateQueries({ queryKey: ['image-job-groups', projectId] });
    }
    if (event.type === 'image_job:output_added' || event.type === 'image_job:completed') {
      void queryClient.invalidateQueries({ queryKey: ['image-workbench-job-details', projectId] });
    }
  }, [projectId, queryClient, queryKey]);
  useImageGenerationEvents(projectId, updateJobCache);

  const createJob = useMutation({
    mutationFn: () => api.createImageJob(projectId, buildWorkbenchImageJobPayload(form, activeProfile?.id ?? null)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ['image-workbench-job-details', projectId] });
      toast.success('图片任务已创建');
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const cancelJob = useMutation({
    mutationFn: (job: ImageGenerationJob) => api.cancelImageJob(projectId, job.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const retryJob = useMutation({
    mutationFn: (job: ImageGenerationJob) => api.retryImageJob(projectId, job.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const cancelQueue = useMutation({
    mutationFn: (queueJobs: ImageGenerationJob[]) =>
      Promise.all(queueJobs.map((job) => api.cancelImageJob(projectId, job.id))),
    onSuccess: async (results) => {
      await queryClient.invalidateQueries({ queryKey });
      toast.success(`已取消 ${results.length} 个队列任务`);
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const downloadOutputs = useMutation({
    mutationFn: (outputIds: string[]) => api.downloadImageOutputManifest(projectId, outputIds),
    onSuccess: (manifest) => {
      downloadJsonManifest(`opendeepsea-images-${projectId}.json`, manifest);
      toast.success('下载清单已生成');
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const deleteOutputs = useMutation({
    mutationFn: (outputIds: string[]) => api.deleteImageOutputs(projectId, outputIds),
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['image-workbench-job-details', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['image-job-details', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['image-gallery-resources', projectId] }),
      ]);
      toast.success(`已删除 ${response.deleted_output_ids.length} 张图片`);
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const displayJobs = jobs.length > 0 ? jobs : demoJobs;
  const resultGroupsFromDetails = useMemo(() => detailsToResultGroups(details, profiles), [details, profiles]);
  const resultGroups = resultGroupsFromDetails.length > 0 ? resultGroupsFromDetails : demoResults;
  const resultOutputIds = useMemo(() => collectResultOutputIds(resultGroupsFromDetails), [resultGroupsFromDetails]);
  const hasCancelableJobs = useMemo(() => jobs.some(isCancelableJob), [jobs]);
  const stats = buildStats(jobs);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f5f7fa] text-[#111827]"
      data-project-id={projectId}
      data-purpose="image-workbench-shell"
    >
      <main className="flex min-h-0 flex-1 overflow-hidden max-lg:flex-col max-lg:overflow-y-auto">
        <ModelConfigPanel
          projectId={projectId}
          profile={activeProfile}
          form={form}
          busy={createJob.isPending}
          onFormChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          onClear={() => setForm((current) => ({ ...current, prompt: '', negativePrompt: '', sourceFiles: [] }))}
          onSubmit={() => {
            if (!canSubmitWorkbenchImageJob(form)) {
              toast.error(form.workflow === 'image-to-image' && form.sourceFiles.length === 0
                ? '图生图需要至少选择一张源图'
                : '请填写提示词');
              return;
            }
            createJob.mutate();
          }}
        />
        <section className="min-w-0 flex-1 overflow-y-auto bg-[#f5f7fa] p-6 max-lg:p-4" aria-label="图片生成主工作区">
          <TaskQueuePanel
            jobs={displayJobs}
            demoMode={jobs.length === 0}
            modelName={activeProfile?.model ?? 'gpt-image-2'}
            busyJobId={cancelJob.isPending || retryJob.isPending || cancelQueue.isPending ? 'busy' : null}
            clearQueueDisabled={!hasCancelableJobs}
            downloadDisabled={resultOutputIds.length === 0 || downloadOutputs.isPending}
            onCancel={(job) => cancelJob.mutate(job)}
            onRetry={(job) => retryJob.mutate(job)}
            onClearQueue={() => {
              const queueJobs = jobs.filter(isCancelableJob);
              if (queueJobs.length === 0) {
                toast.info('没有可取消的队列任务');
                return;
              }
              cancelQueue.mutate(queueJobs);
            }}
            onDownloadAll={() => {
              if (resultOutputIds.length === 0) {
                toast.info('没有可下载的生成结果');
                return;
              }
              downloadOutputs.mutate(resultOutputIds);
            }}
          />
          <GenerationResultsPanel
            groups={resultGroups}
            demoMode={resultGroupsFromDetails.length === 0}
            deleting={deleteOutputs.isPending}
            downloading={downloadOutputs.isPending}
            onReusePrompt={(prompt) => {
              setForm((current) => ({ ...current, prompt }));
              toast.success('提示词已填入左侧配置');
            }}
            onDownload={(group) => {
              const outputIds = collectGroupOutputIds(group);
              if (outputIds.length === 0) {
                toast.info('没有可下载的生成结果');
                return;
              }
              downloadOutputs.mutate(outputIds);
            }}
            onDelete={(group) => {
              const outputIds = collectGroupOutputIds(group);
              if (outputIds.length === 0) return;
              if (!window.confirm(`删除此组 ${outputIds.length} 张生成图片？此操作会从项目文件库移除这些图片。`)) return;
              deleteOutputs.mutate(outputIds);
            }}
          />
        </section>
        <RightInspectorPanel jobs={jobs} results={resultGroups} stats={stats} />
      </main>
      <StatusFooter projectId={projectId} />
    </div>
  );
}

function ModelConfigPanel({
  projectId,
  profile,
  form,
  busy,
  onFormChange,
  onClear,
  onSubmit,
}: {
  projectId: string;
  profile: ImageProviderProfile | null;
  form: FormState;
  busy: boolean;
  onFormChange: (patch: Partial<FormState>) => void;
  onClear: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const model = profile?.model || 'gpt-image-2';
  const submitDisabled = busy || !canSubmitWorkbenchImageJob(form);

  return (
    <aside
      className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-[#e5e7eb] bg-white max-lg:w-full max-lg:border-b max-lg:border-r-0"
      aria-labelledby="image-generation-config-heading"
      data-purpose="image-workbench-model-config"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 id="image-generation-config-heading" className="mb-4 text-sm font-bold">模型配置</h2>
        <div className="rounded-lg border border-[#e5e7eb] bg-[#f9fafb] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-[#111827]">{profile?.name ?? '尚未配置 Provider'}</p>
              <p className="mt-1 truncate font-mono text-[10px] text-[#64748b]">{model}</p>
            </div>
            <span className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
              profile ? 'bg-[#dcfce7] text-[#15803d]' : 'bg-[#fee2e2] text-[#dc2626]',
            )}>
              {profile ? '可用' : '待配置'}
            </span>
          </div>
        </div>
        <details className="mt-3 rounded-lg border border-[#e5e7eb] bg-white p-3" open={!profile}>
          <summary className="cursor-pointer text-xs font-bold text-[#374151]">Provider 管理</summary>
          <div className="mt-3 text-xs">
            <ProviderProfilePanel projectId={projectId} />
          </div>
        </details>

        <h3 className="mb-4 mt-6 text-sm font-bold">输出设置</h3>
        <Field label="生成模式">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={modeButtonClass(form.workflow === 'generate')}
              aria-pressed={form.workflow === 'generate'}
              onClick={() => onFormChange({ workflow: 'generate', sourceFiles: [] })}
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
              文生图
            </button>
            <button
              type="button"
              className={modeButtonClass(form.workflow === 'image-to-image')}
              aria-pressed={form.workflow === 'image-to-image'}
              onClick={() => onFormChange({ workflow: 'image-to-image' })}
            >
              <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
              图生图
            </button>
          </div>
        </Field>
        <Field label="生成数量">
          <div className="grid grid-cols-4 gap-2">
            {[1, 2, 3, 4].map((count) => (
              <button
                key={count}
                type="button"
                className={optionButtonClass(form.count === count)}
                aria-pressed={form.count === count}
                onClick={() => onFormChange({ count })}
              >
                {count}
                {count === 2 && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#2563eb]" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </Field>
        <Field label="尺寸" className="mt-4">
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: '1:1', value: '1024x1024', shape: 'h-4 w-4' },
              { label: '16:9', value: '1792x1024', shape: 'h-3 w-6' },
              { label: '9:16', value: '1024x1792', shape: 'h-6 w-3' },
              { label: '4:3', value: '1365x1024', shape: 'h-4 w-5' },
              { label: '3:4', value: '1024x1365', shape: 'h-5 w-4' },
              { label: '自定义', value: 'auto', shape: '' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'rounded border p-1 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]',
                  form.size === option.value
                    ? 'border-[#2563eb] bg-[#eff6ff] text-[#2563eb]'
                    : 'border-[#e5e7eb] bg-[#f9fafb] text-[#9ca3af] hover:border-[#93c5fd]',
                )}
                aria-pressed={form.size === option.value}
                onClick={() => onFormChange({ size: option.value })}
              >
                {option.shape ? (
                  <span className={cn('mx-auto mb-1 block border', option.shape, form.size === option.value ? 'border-[#60a5fa]' : 'border-[#9ca3af]')} />
                ) : (
                  <SlidersHorizontal className="mx-auto mb-1 h-4 w-4" aria-hidden="true" />
                )}
                <span className="block text-[10px] font-semibold">{option.label}</span>
                <span className="block scale-90 text-[10px]">{option.value === 'auto' ? 'W x H' : option.value}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="质量" className="mt-4">
          <div className="flex rounded bg-[#f3f4f6] p-0.5">
            {[
              { label: '标准', value: 'medium' },
              { label: '高清', value: 'high' },
              { label: '超清', value: 'auto' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  'flex-1 rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]',
                  form.quality === option.value ? 'bg-white font-medium text-[#2563eb] shadow-sm' : 'text-[#6b7280] hover:text-[#374151]',
                )}
                aria-pressed={form.quality === option.value}
                onClick={() => onFormChange({ quality: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="风格" className="mt-4">
          <select
            className="h-8 w-full rounded border border-[#e5e7eb] bg-[#f9fafb] px-2 text-xs outline-none focus:border-[#2563eb]"
            value={form.style}
            onChange={(event) => onFormChange({ style: event.currentTarget.value })}
            aria-label="风格"
          >
            <option value="natural">自然 (Natural)</option>
            <option value="vivid">鲜明 (Vivid)</option>
            <option value="cinematic">电影感 (Cinematic)</option>
          </select>
        </Field>
        {form.workflow === 'image-to-image' && (
          <Field label="参考图" className="mt-4">
            <SourceImagePicker
              projectId={projectId}
              selectedFiles={form.sourceFiles}
              onChange={(sourceFiles) => onFormChange({ sourceFiles })}
            />
          </Field>
        )}
        <Field label="提示词 (Prompt)" className="mt-4">
          <div className="relative">
            <textarea
              className="min-h-[100px] w-full resize-none rounded border border-[#e5e7eb] bg-[#f9fafb] p-2 pr-14 text-xs leading-relaxed outline-none focus:border-[#2563eb]"
              value={form.prompt}
              onChange={(event) => onFormChange({ prompt: event.currentTarget.value })}
              placeholder="输入提示词..."
            />
            <span className="absolute bottom-1 right-2 text-[10px] text-[#94a3b8]">{form.prompt.trim().length} / 2000</span>
          </div>
        </Field>
        <Field label="负向提示词 (可选)" className="mt-4">
          <div className="relative">
            <textarea
              className="min-h-[60px] w-full resize-none rounded border border-[#e5e7eb] bg-[#f9fafb] p-2 pr-14 text-xs leading-relaxed outline-none focus:border-[#2563eb]"
              value={form.negativePrompt}
              onChange={(event) => onFormChange({ negativePrompt: event.currentTarget.value })}
              placeholder="不希望出现的内容，例如：模糊，低质量，文字..."
            />
            <span className="absolute bottom-1 right-2 text-[10px] text-[#94a3b8]">{form.negativePrompt.trim().length} / 1000</span>
          </div>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-[#e5e7eb] bg-white p-4">
        <button type="button" className="rounded bg-[#f3f4f6] py-2 text-xs font-medium text-[#374151] transition-colors hover:bg-[#e5e7eb]" onClick={onClear}>
          清空
        </button>
        <button
          type="button"
          className="col-span-2 inline-flex items-center justify-center gap-1 rounded bg-[#2563eb] py-2 text-xs font-bold text-white transition-colors hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={submitDisabled}
          onClick={onSubmit}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
          生成图片
        </button>
      </div>
    </aside>
  );
}

function TaskQueuePanel({
  jobs,
  demoMode,
  modelName,
  busyJobId,
  clearQueueDisabled,
  downloadDisabled,
  onCancel,
  onRetry,
  onClearQueue,
  onDownloadAll,
}: {
  jobs: ImageGenerationJob[];
  demoMode: boolean;
  modelName: string;
  busyJobId: string | null;
  clearQueueDisabled: boolean;
  downloadDisabled: boolean;
  onCancel: (job: ImageGenerationJob) => void;
  onRetry: (job: ImageGenerationJob) => void;
  onClearQueue: () => void;
  onDownloadAll: () => void;
}): JSX.Element {
  return (
    <section className="mb-8" aria-labelledby="image-generation-jobs-heading" data-purpose="image-workbench-task-queue">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="image-generation-jobs-heading" className="text-sm font-bold">任务队列</h2>
        <div className="flex gap-2">
          <ToolButton icon={Trash2} label="清空队列" disabled={demoMode || clearQueueDisabled || Boolean(busyJobId)} onClick={onClearQueue} />
          <ToolButton icon={Download} label="全部下载" disabled={demoMode || downloadDisabled} onClick={onDownloadAll} />
        </div>
      </div>
      <div className="space-y-3">
        {jobs.slice(0, 3).map((job) => {
          const meta = statusMeta(job.status);
          const progress = jobProgress(job);
          return (
            <article key={job.id} className="flex items-center gap-4 rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded bg-[#e5e7eb]">
                <Swatch asset={demoResults[0].assets[0]} className="h-full w-full opacity-50 blur-[1px]" />
                {(job.status === 'running' || job.status === 'queued' || job.status === 'canceling') && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-[#2563eb]" aria-hidden="true" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex min-w-0 items-center gap-2">
                  <span className={cn('text-xs font-bold', meta.textClass)}>{meta.label}</span>
                  <h3 className="truncate text-xs font-medium text-[#111827]">{job.prompt}</h3>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] text-[#94a3b8]">
                  <span className="rounded bg-[#f3f4f6] px-1.5 py-0.5">{modelName}</span>
                  <span>{sizeLabel(job.size)}</span>
                  <span>{qualityLabel(job.quality)}</span>
                  <span>{job.count} 张</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#f3f4f6]">
                    <div className="h-full bg-[#2563eb]" style={{ width: `${progress}%` }} />
                  </div>
                  <span className="font-mono text-[10px] text-[#64748b]">{job.status === 'running' ? '预计剩余 00:18' : meta.hint}</span>
                  <span className="text-[10px] font-bold text-[#2563eb]">{progress}%</span>
                  {job.status === 'failed' ? (
                    <button type="button" className="text-[#94a3b8] hover:text-[#2563eb]" disabled={demoMode || Boolean(busyJobId)} onClick={() => onRetry(job)} aria-label="重试失败任务">
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" className="text-[#94a3b8] hover:text-[#dc2626]" disabled={demoMode || Boolean(busyJobId)} onClick={() => onCancel(job)} aria-label="取消运行任务">
                      <Square className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function GenerationResultsPanel({
  groups,
  demoMode,
  deleting,
  downloading,
  onReusePrompt,
  onDownload,
  onDelete,
}: {
  groups: ResultGroup[];
  demoMode: boolean;
  deleting: boolean;
  downloading: boolean;
  onReusePrompt: (prompt: string) => void;
  onDownload: (group: ResultGroup) => void;
  onDelete: (group: ResultGroup) => void;
}): JSX.Element {
  return (
    <section aria-labelledby="image-generation-gallery-heading" data-purpose="image-workbench-generation-results">
      <h2 id="image-generation-gallery-heading" className="mb-4 text-sm font-bold">生成结果</h2>
      {groups.map((group) => (
        <article key={group.id} className="mb-8">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="mb-1 font-mono text-[10px] text-[#94a3b8]">{formatDateTime(group.createdAt)}</p>
              <h3 className="max-w-2xl text-xs font-medium leading-relaxed text-[#111827]">{group.prompt}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {[group.model, group.size, group.quality, `${group.count} 张`].map((item) => (
                  <span key={item} className="rounded border border-[#e5e7eb] bg-white px-2 py-0.5 text-[10px] text-[#64748b]">{item}</span>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <IconButton icon={Wand2} label="复用提示词" onClick={() => onReusePrompt(group.prompt)} />
              <IconButton icon={Download} label="下载结果" disabled={demoMode || downloading} onClick={() => onDownload(group)} />
              <IconButton icon={Trash2} label="删除结果" disabled={demoMode || deleting} onClick={() => onDelete(group)} />
            </div>
          </div>
          <div className={cn('grid gap-4', group.assets.length <= 2 ? 'grid-cols-2 max-sm:grid-cols-1' : 'grid-cols-4 max-xl:grid-cols-2 max-sm:grid-cols-1')}>
            {group.assets.map((asset) => (
              <div
                key={asset.id}
                className={cn(
                  'group relative overflow-hidden rounded-xl border border-[#e5e7eb] bg-[#e5e7eb]',
                  asset.aspect === '16:9' ? 'aspect-[16/9]' : 'aspect-[4/3]',
                )}
              >
                <Swatch asset={asset} className={cn('h-full w-full', asset.video && 'grayscale brightness-75')} />
                {asset.video ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/30 bg-white/20 text-white backdrop-blur-sm">
                      <Play className="h-5 w-5 fill-current" aria-hidden="true" />
                    </span>
                  </div>
                ) : (
                  asset.url ? (
                    <a
                      href={asset.url}
                      target="_blank"
                      rel="noreferrer"
                      className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                      aria-label={`放大查看 ${asset.label}`}
                    >
                      <Maximize2 className="h-4 w-4" aria-hidden="true" />
                    </a>
                  ) : null
                )}
              </div>
            ))}
          </div>
        </article>
      ))}
      <div className="py-8 text-center text-xs text-[#94a3b8]">已经到底了</div>
    </section>
  );
}

function RightInspectorPanel({
  jobs,
  results,
  stats,
}: {
  jobs: ImageGenerationJob[];
  results: ResultGroup[];
  stats: ReturnType<typeof buildStats>;
}): JSX.Element {
  const [historyQuery, setHistoryQuery] = useState('');
  const history = jobs.length > 0 ? jobs.slice(0, 5).map(jobToHistoryItem) : demoHistory;
  const normalizedHistoryQuery = historyQuery.trim().toLowerCase();
  const visibleHistory = normalizedHistoryQuery
    ? history.filter((item) => `${item.title} ${item.meta} ${item.status}`.toLowerCase().includes(normalizedHistoryQuery))
    : history;

  return (
    <aside
      className="hidden w-72 shrink-0 flex-col gap-6 overflow-y-auto border-l border-[#e5e7eb] bg-white p-4 xl:flex"
      aria-label="图片生成检查器"
      data-purpose="image-workbench-right-inspector"
    >
      <section aria-labelledby="image-workbench-stats-heading">
        <h2 id="image-workbench-stats-heading" className="mb-4 text-sm font-bold">任务统计</h2>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: '总任务', value: stats.total, className: 'text-[#111827]' },
            { label: '完成', value: stats.completed, className: 'text-[#10b981]' },
            { label: '进行中', value: stats.running, className: 'text-[#2563eb]' },
            { label: '失败', value: stats.failed, className: 'text-[#ef4444]' },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-[#f3f4f6] bg-[#f9fafb] p-2">
              <p className={cn('mb-1 text-[10px]', item.className)}>{item.label}</p>
              <p className="font-mono text-lg font-bold text-[#111827]">{item.value}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="min-h-0 flex-1" aria-labelledby="image-workbench-history-heading">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="image-workbench-history-heading" className="text-sm font-bold">历史记录</h2>
        </div>
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-[#9ca3af]" aria-hidden="true" />
            <input
              className="h-8 w-full rounded border border-[#e5e7eb] bg-[#f9fafb] px-8 text-xs outline-none focus:border-[#2563eb]"
              placeholder="搜索历史记录..."
              type="text"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded border border-[#e5e7eb] bg-white text-[#94a3b8] disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="历史筛选"
            disabled
            title="预留扩展能力"
          >
            <ListFilter className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-4">
          {visibleHistory.map((item, index) => (
            <div key={item.id} className="group -mx-2 flex cursor-pointer gap-3 rounded-lg p-2 transition-colors hover:bg-[#f9fafb]">
              <HistoryPreview failed={item.tone === 'danger'} seed={index} results={results} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-xs font-bold">{item.title}</h3>
                  <span className="font-mono text-[10px] text-[#94a3b8]">{item.duration}</span>
                </div>
                <p className="text-[10px] text-[#94a3b8]">{item.meta}</p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10px] text-[#94a3b8]">{item.time}</span>
                  <span className={cn('flex items-center gap-1 text-[10px]', item.tone === 'danger' ? 'text-[#ef4444]' : 'text-[#10b981]')}>
                    <span className="h-1 w-1 rounded-full bg-current" aria-hidden="true" />
                    {item.status}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {visibleHistory.length === 0 && (
            <div className="rounded-lg border border-dashed border-[#e5e7eb] bg-[#f9fafb] p-3 text-xs text-[#94a3b8]">
              没有匹配的历史记录
            </div>
          )}
        </div>
      </section>
      <section aria-labelledby="image-workbench-quick-actions-heading">
        <h2 id="image-workbench-quick-actions-heading" className="mb-4 text-sm font-bold">快捷操作</h2>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <QuickAction icon={BookOpen} label="导入提示词模板" />
            <QuickAction icon={Share2} label="分享当前配置" />
          </div>
          <QuickAction icon={Settings2} label="查看使用文档" wide />
        </div>
      </section>
    </aside>
  );
}

function StatusFooter({ projectId }: { projectId: string }): JSX.Element {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-[#e5e7eb] bg-white px-3 text-[10px] text-[#94a3b8]" data-purpose="image-workbench-status-footer">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#10b981]" aria-hidden="true" />
          <span>System Ready</span>
        </div>
        <div className="flex items-center gap-3 font-mono">
          <span>project:<span className="text-[#64748b]">{projectId}</span></span>
          <span>Latency: <span className="text-[#64748b]">42ms</span></span>
          <span>Response: <span className="text-[#64748b]">1.2s</span></span>
          <span>Error rate: <span className="text-[#64748b]">0.02%</span></span>
        </div>
      </div>
      <div className="hidden items-center gap-3 sm:flex">
        <span>v2.4.1-stable</span>
        <span className="text-[#cbd5e1]">|</span>
        <span>Deepsea Command Center</span>
      </div>
    </footer>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn('block', className)}>
      <span className="mb-1.5 block text-xs text-[#64748b]">{label}</span>
      {children}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded border border-[#e5e7eb] bg-white px-3 py-1 text-xs text-[#374151] transition-colors hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

function IconButton({
  icon: Icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="flex h-7 w-7 items-center justify-center rounded border border-[#e5e7eb] bg-white text-[#64748b] transition-colors hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

function QuickAction({ icon: Icon, label, wide = false }: { icon: LucideIcon; label: string; wide?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={cn('inline-flex items-center gap-2 rounded border border-[#e5e7eb] bg-[#f9fafb] px-3 py-2 text-left text-xs text-[#94a3b8] opacity-75', wide && 'w-full')}
      disabled
      title="预留扩展能力"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-[#64748b]" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function Swatch({ asset, className }: { asset: ResultAsset; className?: string }): JSX.Element {
  if (asset.url) {
    return <img src={asset.url} alt={asset.label} className={cn('object-cover', className)} loading="lazy" decoding="async" />;
  }
  return <div className={className} style={{ background: asset.gradient }} aria-label={asset.label} role="img" />;
}

function HistoryPreview({ failed, seed, results }: { failed: boolean; seed: number; results: ResultGroup[] }): JSX.Element {
  if (failed) {
    return (
      <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded bg-[#e5e7eb]">
        <AlertTriangle className="h-6 w-6 text-[#9ca3af]" aria-hidden="true" />
      </div>
    );
  }
  const assets = results[seed % results.length]?.assets ?? demoResults[0].assets;
  return (
    <div className="grid h-12 w-16 shrink-0 grid-cols-2 gap-0.5 overflow-hidden rounded bg-[#e5e7eb]">
      <Swatch asset={assets[0] ?? demoResults[0].assets[0]} className="h-full w-full" />
      <Swatch asset={assets[1] ?? assets[0] ?? demoResults[0].assets[1]} className="h-full w-full scale-110" />
    </div>
  );
}

export function detailsToResultGroups(details: ImageJobDetailResponse[], profiles: ImageProviderProfile[] = []): ResultGroup[] {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return details
    .filter((detail) => detail.outputs.length > 0)
    .map((detail) => ({
      id: detail.job.id,
      createdAt: detail.job.created_at,
      prompt: detail.job.prompt,
      model: profileById.get(detail.job.provider_profile_id)?.model ?? 'gpt-image-2',
      size: sizeLabel(detail.job.size),
      quality: qualityLabel(detail.job.quality),
      count: detail.outputs.length,
      assets: detail.outputs.map(outputToAsset),
    }));
}

function outputToAsset(output: ImageGenerationOutput): ResultAsset {
  const aspect = output.width && output.height && output.width / Math.max(output.height, 1) < 1.45 ? '4:3' : '16:9';
  return {
    id: output.id,
    outputId: output.id,
    label: output.name,
    url: output.url,
    aspect,
    gradient: 'linear-gradient(135deg, #dbeafe 0%, #93c5fd 52%, #1e40af 100%)',
  };
}

function upsertJob(jobs: ImageGenerationJob[], job: ImageGenerationJob): ImageGenerationJob[] {
  const next = [job, ...jobs.filter((item) => item.id !== job.id)];
  return next.sort((a, b) => b.updated_at - a.updated_at);
}

function buildStats(jobs: ImageGenerationJob[]): { total: number; completed: number; running: number; failed: number } {
  if (jobs.length === 0) return { total: 128, completed: 96, running: 3, failed: 2 };
  return {
    total: jobs.length,
    completed: jobs.filter((job) => job.status === 'completed').length,
    running: jobs.filter((job) => job.status === 'running' || job.status === 'queued' || job.status === 'canceling').length,
    failed: jobs.filter((job) => job.status === 'failed' || job.status === 'canceled').length,
  };
}

function jobToHistoryItem(job: ImageGenerationJob): { id: string; title: string; meta: string; time: string; duration: string; status: string; tone: string } {
  const meta = statusMeta(job.status);
  return {
    id: job.id,
    title: compactTitle(job.prompt),
    meta: `${sizeLabel(job.size)} · ${qualityLabel(job.quality)} · ${job.count} 张`,
    time: formatShortTime(job.created_at),
    duration: elapsedLabel(job.started_at ?? job.created_at, job.completed_at ?? job.updated_at),
    status: meta.label,
    tone: meta.tone,
  };
}

function statusMeta(status: ImageGenerationJob['status']): { label: string; hint: string; tone: string; textClass: string } {
  const map: Record<ImageGenerationJob['status'], { label: string; hint: string; tone: string; textClass: string }> = {
    queued: { label: '排队中', hint: '等待调度', tone: 'info', textClass: 'text-[#2563eb]' },
    running: { label: '进行中', hint: '预计剩余 00:18', tone: 'info', textClass: 'text-[#2563eb]' },
    canceling: { label: '取消中', hint: '停止任务', tone: 'warning', textClass: 'text-[#f59e0b]' },
    completed: { label: '完成', hint: '已完成', tone: 'success', textClass: 'text-[#10b981]' },
    failed: { label: '失败', hint: '需要重试', tone: 'danger', textClass: 'text-[#ef4444]' },
    canceled: { label: '已取消', hint: '用户取消', tone: 'danger', textClass: 'text-[#ef4444]' },
  };
  return map[status];
}

function jobProgress(job: ImageGenerationJob): number {
  if (job.status === 'completed') return 100;
  if (job.status === 'failed' || job.status === 'canceled') return 0;
  if (job.status === 'queued') return 12;
  if (job.status === 'canceling') return 65;
  return 45;
}

function optionButtonClass(active: boolean): string {
  return cn(
    'relative rounded border py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]',
    active ? 'border-[#2563eb] bg-[#eff6ff] text-[#2563eb]' : 'border-[#e5e7eb] bg-[#f9fafb] text-[#374151] hover:border-[#93c5fd]',
  );
}

function modeButtonClass(active: boolean): string {
  return cn(
    'inline-flex h-8 items-center justify-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]',
    active ? 'border-[#2563eb] bg-[#eff6ff] text-[#2563eb]' : 'border-[#e5e7eb] bg-[#f9fafb] text-[#64748b] hover:border-[#93c5fd] hover:text-[#374151]',
  );
}

export function buildWorkbenchImageJobPayload(
  form: FormState,
  providerProfileId: string | null,
): ImageJobCreateInput {
  const payload: ImageJobCreateInput = {
    provider_profile_id: providerProfileId,
    workflow: form.workflow,
    prompt: buildPromptWithWorkbenchOptions(form),
    count: form.count,
    quality: form.quality,
    size: form.size,
  };
  if (form.workflow === 'image-to-image') {
    payload.source_file_ids = form.sourceFiles.map((file) => normalizeSourceFileId(file.id));
  }
  return payload;
}

export function canSubmitWorkbenchImageJob(form: FormState): boolean {
  if (!form.prompt.trim()) return false;
  if (form.workflow === 'image-to-image' && form.sourceFiles.length === 0) return false;
  return true;
}

function buildPromptWithWorkbenchOptions(form: FormState): string {
  const parts = [form.prompt.trim()];
  if (form.style !== 'natural') {
    parts.push(`风格偏好: ${styleLabel(form.style)}`);
  }
  if (form.negativePrompt.trim()) {
    parts.push(`避免出现: ${form.negativePrompt.trim()}`);
  }
  return parts.join('\n\n');
}

function normalizeSourceFileId(fileId: string): string {
  return fileId.startsWith('file:') ? fileId.slice('file:'.length) : fileId;
}

function styleLabel(style: string): string {
  if (style === 'vivid') return '鲜明 Vivid';
  if (style === 'cinematic') return '电影感 Cinematic';
  return '自然 Natural';
}

function isCancelableJob(job: ImageGenerationJob): boolean {
  return job.status === 'queued' || job.status === 'running' || job.status === 'canceling';
}

export function collectResultOutputIds(groups: ResultGroup[]): string[] {
  return groups.flatMap(collectGroupOutputIds);
}

function collectGroupOutputIds(group: ResultGroup): string[] {
  return group.assets
    .map((asset) => asset.outputId)
    .filter((outputId): outputId is string => Boolean(outputId));
}

function downloadJsonManifest(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sizeLabel(size: string): string {
  if (size === '1792x1024') return '16:9';
  if (size === '1024x1792') return '9:16';
  if (size === '1365x1024') return '4:3';
  if (size === '1024x1365') return '3:4';
  if (size === '1024x1024') return '1:1';
  return size === 'auto' ? '16:9' : size;
}

function qualityLabel(quality: string): string {
  if (quality === 'high') return '高清';
  if (quality === 'medium') return '标准';
  if (quality === 'low') return '标准';
  if (quality === 'auto') return '超清';
  return quality;
}

function compactTitle(prompt: string): string {
  if (prompt.includes('海上城市')) return '未来海上城市';
  if (prompt.includes('雪山')) return '雪山湖泊风景';
  return prompt.slice(0, 18);
}

function formatDateTime(value: number): string {
  const date = new Date(normalizeTimestamp(value));
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatShortTime(value: number): string {
  const date = new Date(normalizeTimestamp(value));
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function elapsedLabel(start: number, end: number): string {
  const duration = Math.max(1, Math.round((normalizeTimestamp(end) - normalizeTimestamp(start)) / 1000));
  return `0:${String(Math.min(duration, 59)).padStart(2, '0')}`;
}

function normalizeTimestamp(value: number): number {
  return value > 10_000_000_000 ? value : value * 1000;
}
