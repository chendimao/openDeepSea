import '@xyflow/react/dist/style.css';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { GitBranch, Plus, Save, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type {
  WorkflowDefinition,
  WorkflowDefinitionGraph,
  WorkflowDefinitionNode,
  WorkflowDefinitionNodeType,
  WorkflowRole,
  WorkflowStage,
} from '../lib/types';
import { Button } from './ui/Button';
import { Dialog, DialogContent } from './ui/Dialog';
import { Input, Label } from './ui/Input';

const NODE_TYPES: WorkflowDefinitionNodeType[] = [
  'context',
  'planning',
  'approval_gate',
  'dispatch',
  'execute',
  'review',
  'repair_decision',
  'verify',
  'acceptance',
  'memory',
];

const STAGES: WorkflowStage[] = ['analysis', 'planning', 'assignment', 'implementation', 'code_review', 'acceptance'];
const ROLES: WorkflowRole[] = ['analyst', 'planner', 'coordinator', 'executor', 'reviewer', 'acceptor'];

export function WorkflowBuilderDialog({
  open,
  onOpenChange,
  roomId,
  definition,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  definition: WorkflowDefinition | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState(definition?.builtin_key ? `${definition.name} 副本` : definition?.name ?? '群聊工作流');
  const [description, setDescription] = useState(definition?.description ?? '');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(definition?.definition.nodes[0]?.id ?? null);
  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(definition?.definition ?? defaultGraph()));
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(definition?.definition ?? defaultGraph()));
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const hasDuplicateNodeTypes = useMemo(() => {
    const seen = new Set<WorkflowDefinitionNodeType>();
    return nodes.some((node) => {
      const type = node.data.nodeType as WorkflowDefinitionNodeType;
      if (seen.has(type)) return true;
      seen.add(type);
      return false;
    });
  }, [nodes]);

  const create = useMutation({
    mutationFn: async () => {
      if (hasDuplicateNodeTypes) throw new Error('当前版本每种节点类型只能出现一次');
      const created = await api.createWorkflowDefinition({
        name,
        description: description.trim() || null,
        scope: 'room',
        scope_id: roomId,
        definition: toDefinitionGraph(nodes, edges),
      });
      return api.publishWorkflowDefinition(created.id);
    },
    onSuccess: async (published) => {
      await api.updateRoomSettings(roomId, { default_workflow_definition_id: published.id });
      queryClient.invalidateQueries({ queryKey: ['workflow-definitions', roomId] });
      queryClient.invalidateQueries({ queryKey: ['settings', 'room', roomId] });
      toast.success('工作流已发布并设为当前群聊默认');
      onOpenChange(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const addNode = (type: WorkflowDefinitionNodeType) => {
    if (nodes.some((node) => node.data.nodeType === type)) {
      toast.error('当前版本每种节点类型只能出现一次');
      return;
    }
    const id = `${type}-${Date.now().toString(36)}`;
    const node: Node = {
      id,
      type: 'default',
      position: { x: 120 + nodes.length * 32, y: 120 + nodes.length * 24 },
      data: {
        label: labelForNodeType(type),
        nodeType: type,
        stage: defaultStageForType(type),
        role: defaultRoleForType(type),
      },
    };
    setNodes((prev) => [...prev, node]);
    setSelectedNodeId(id);
  };

  useEffect(() => {
    if (!open) return;
    const graph = definition?.definition ?? defaultGraph();
    setName(definition?.builtin_key ? `${definition.name} 副本` : definition?.name ?? '群聊工作流');
    setDescription(definition?.description ?? '');
    setNodes(toFlowNodes(graph));
    setEdges(toFlowEdges(graph));
    setSelectedNodeId(graph.nodes[0]?.id ?? null);
  }, [definition, open]);

  const updateSelectedNode = (patch: Partial<WorkflowDefinitionNode>) => {
    if (!selectedNode) return;
    if (
      patch.type &&
      patch.type !== selectedNode.data.nodeType &&
      nodes.some((node) => node.id !== selectedNode.id && node.data.nodeType === patch.type)
    ) {
      toast.error('当前版本每种节点类型只能出现一次');
      return;
    }
    setNodes((prev) =>
      prev.map((node) =>
        node.id === selectedNode.id
          ? {
            ...node,
            data: {
              ...node.data,
              label: patch.label ?? node.data.label,
              nodeType: patch.type ?? node.data.nodeType,
              stage: patch.stage === undefined ? node.data.stage : patch.stage,
              role: patch.role === undefined ? node.data.role : patch.role,
            },
          }
          : node,
      ),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="工作流编排"
        description="编辑受控节点和连线，发布后作为当前群聊的默认工作流。"
        className="h-[88vh] w-[min(96vw,1180px)] overflow-hidden p-0"
      >
        <div className="grid h-full grid-cols-[230px_minmax(0,1fr)_260px]">
          <aside className="border-r border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="mb-3 text-[12px] font-semibold text-[var(--color-fg)]">节点库</div>
            <div className="grid gap-1.5">
              {NODE_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-left text-[12px] hover:border-[var(--color-border-strong)]"
                  onClick={() => addNode(type)}
                >
                  <Plus className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                  {labelForNodeType(type)}
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0 bg-[var(--color-bg)]">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              fitView
              onNodesChange={(changes: NodeChange[]) => setNodes((prev) => applyNodeChanges(changes, prev))}
              onEdgesChange={(changes: EdgeChange[]) => setEdges((prev) => applyEdgeChanges(changes, prev))}
              onConnect={(connection: Connection) => setEdges((prev) => addEdge({ ...connection, animated: true }, prev))}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            >
              <Background />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          </section>

          <aside className="border-l border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <div className="space-y-3">
              <div>
                <Label>名称</Label>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div>
                <Label>描述</Label>
                <Input value={description} onChange={(event) => setDescription(event.target.value)} />
              </div>
              {selectedNode && (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
                    <GitBranch className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                    节点属性
                  </div>
                  <div className="space-y-2">
                    <div>
                      <Label>标签</Label>
                      <Input
                        value={String(selectedNode.data.label ?? '')}
                        onChange={(event) => updateSelectedNode({ label: event.target.value })}
                      />
                    </div>
                    <SelectField
                      label="类型"
                      value={String(selectedNode.data.nodeType)}
                      options={NODE_TYPES}
                      disabledOptions={NODE_TYPES.filter((type) =>
                        type !== selectedNode.data.nodeType &&
                        nodes.some((node) => node.data.nodeType === type)
                      )}
                      onChange={(value) => updateSelectedNode({ type: value as WorkflowDefinitionNodeType })}
                    />
                    <SelectField
                      label="阶段"
                      value={String(selectedNode.data.stage ?? '')}
                      options={['', ...STAGES]}
                      onChange={(value) => updateSelectedNode({ stage: value ? value as WorkflowStage : null })}
                    />
                    <SelectField
                      label="角色"
                      value={String(selectedNode.data.role ?? '')}
                      options={['', ...ROLES]}
                      onChange={(value) => updateSelectedNode({ role: value ? value as WorkflowRole : null })}
                    />
                  </div>
                </div>
              )}
              <Button
                className="w-full justify-center"
                disabled={create.isPending || !name.trim() || nodes.length === 0 || hasDuplicateNodeTypes}
                onClick={() => create.mutate()}
              >
                <UploadCloud className="h-3.5 w-3.5" />
                {create.isPending ? '发布中' : '发布并应用'}
              </Button>
              <div className="rounded-md border border-[var(--color-border)] p-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                <Save className="mr-1 inline h-3 w-3" />
                发布会创建新版本副本，不会修改内置工作流。
              </div>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SelectField({
  label,
  value,
  options,
  disabledOptions = [],
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  disabledOptions?: string[];
  onChange: (value: string) => void;
}) {
  const disabled = new Set(disabledOptions);
  return (
    <div>
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
      >
        {options.map((option) => (
          <option key={option || 'none'} value={option} disabled={disabled.has(option)}>
            {option || '无'}
          </option>
        ))}
      </select>
    </div>
  );
}

function toFlowNodes(graph: WorkflowDefinitionGraph): Node[] {
  return graph.nodes.map((node, index) => ({
    id: node.id,
    type: 'default',
    position: node.position ?? { x: 120 + index * 180, y: 120 },
    data: {
      label: node.label,
      nodeType: node.type,
      stage: node.stage ?? defaultStageForType(node.type),
      role: node.role ?? defaultRoleForType(node.type),
    },
  }));
}

function toFlowEdges(graph: WorkflowDefinitionGraph): Edge[] {
  return graph.edges.map((edge, index) => ({
    id: `${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.condition ?? undefined,
    animated: true,
    data: { condition: edge.condition ?? null },
  }));
}

function toDefinitionGraph(nodes: Node[], edges: Edge[]): WorkflowDefinitionGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType as WorkflowDefinitionNodeType,
      label: String(node.data.label || node.id),
      stage: (node.data.stage || null) as WorkflowStage | null,
      role: (node.data.role || null) as WorkflowRole | null,
      position: node.position,
    })),
    edges: edges
      .filter((edge) => edge.source && edge.target)
      .map((edge) => ({
        from: edge.source,
        to: edge.target,
        condition: edgeCondition(edge, nodes),
      })),
  };
}

function edgeCondition(edge: Edge, nodes: Node[]): string | null {
  const explicit = typeof edge.label === 'string' && edge.label.trim()
    ? edge.label.trim()
    : typeof edge.data?.condition === 'string' && edge.data.condition.trim()
      ? edge.data.condition.trim()
      : null;
  if (explicit) return explicit;
  const source = nodes.find((node) => node.id === edge.source);
  const sourceType = source?.data.nodeType as WorkflowDefinitionNodeType | undefined;
  if (sourceType === 'approval_gate') return 'approved';
  if (sourceType === 'execute') return 'review';
  if (sourceType === 'review') return 'pass';
  if (sourceType === 'repair_decision') return 'execute';
  if (sourceType === 'verify') return 'acceptance';
  if (sourceType === 'acceptance') return 'completed';
  return null;
}

function defaultGraph(): WorkflowDefinitionGraph {
  return {
    nodes: [
      { id: 'planning', type: 'planning', label: 'Planning', stage: 'planning', role: 'planner', position: { x: 120, y: 140 } },
      { id: 'approval', type: 'approval_gate', label: 'Approval', stage: 'planning', position: { x: 360, y: 140 } },
      { id: 'dispatch', type: 'dispatch', label: 'Dispatch', stage: 'assignment', role: 'coordinator', position: { x: 600, y: 140 } },
      { id: 'execute', type: 'execute', label: 'Execute', stage: 'implementation', role: 'executor', position: { x: 840, y: 140 } },
      { id: 'review', type: 'review', label: 'Review', stage: 'code_review', role: 'reviewer', position: { x: 1080, y: 140 } },
      { id: 'repair_decision', type: 'repair_decision', label: 'Repair Decision', stage: 'assignment', role: 'coordinator', position: { x: 1080, y: 300 } },
      { id: 'verify', type: 'verify', label: 'Verify', stage: 'code_review', position: { x: 1320, y: 140 } },
      { id: 'acceptance', type: 'acceptance', label: 'Acceptance', stage: 'acceptance', role: 'acceptor', position: { x: 1560, y: 140 } },
      { id: 'memory', type: 'memory', label: 'Memory', stage: 'acceptance', position: { x: 1800, y: 140 } },
    ],
    edges: [
      { from: 'planning', to: 'approval' },
      { from: 'approval', to: 'dispatch', condition: 'approved' },
      { from: 'dispatch', to: 'execute' },
      { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
      { from: 'execute', to: 'review', condition: 'review' },
      { from: 'review', to: 'repair_decision', condition: 'changes_requested' },
      { from: 'review', to: 'verify', condition: 'pass' },
      { from: 'repair_decision', to: 'execute', condition: 'execute' },
      { from: 'verify', to: 'acceptance', condition: 'acceptance' },
      { from: 'acceptance', to: 'memory', condition: 'completed' },
    ],
  };
}

function labelForNodeType(type: WorkflowDefinitionNodeType): string {
  return type.replace(/_/g, ' ');
}

function defaultStageForType(type: WorkflowDefinitionNodeType): WorkflowStage {
  if (type === 'context') return 'analysis';
  if (type === 'planning' || type === 'approval_gate') return 'planning';
  if (type === 'dispatch' || type === 'repair_decision') return 'assignment';
  if (type === 'execute') return 'implementation';
  if (type === 'review' || type === 'verify') return 'code_review';
  return 'acceptance';
}

function defaultRoleForType(type: WorkflowDefinitionNodeType): WorkflowRole | null {
  if (type === 'planning') return 'planner';
  if (type === 'dispatch' || type === 'repair_decision') return 'coordinator';
  if (type === 'execute') return 'executor';
  if (type === 'review') return 'reviewer';
  if (type === 'acceptance') return 'acceptor';
  return null;
}
