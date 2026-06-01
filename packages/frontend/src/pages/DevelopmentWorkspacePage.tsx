import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import type { Project, Room } from '../lib/types';
import { isPinnedItem, sortPinnedItems } from '../lib/sortableItems';
import { Button } from '../components/ui/Button';
import { CreateProjectDialog } from '../components/CreateProjectDialog';
import { CreateRoomDialog } from '../components/CreateRoomDialog';
import { ProjectRail } from '../components/ProjectRail';
import { RoomTabsBar } from '../components/RoomTabsBar';
import { RoomWorkbench } from '../components/room/RoomWorkbench';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState';

export function DevelopmentWorkspacePage(): JSX.Element {
  const { projectId, roomId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const sortedProjects = useMemo(() => sortPinnedItems(projects), [projects]);
  const activeProject = sortedProjects.find((project) => project.id === projectId) ?? sortedProjects[0] ?? null;
  const activeProjectId = activeProject?.id ?? '';
  const { data: rooms = [] } = useQuery({
    queryKey: ['rooms', activeProjectId],
    queryFn: () => api.listRooms(activeProjectId),
    enabled: Boolean(activeProjectId),
  });
  const sortedRooms = useMemo(() => sortPinnedItems(rooms), [rooms]);
  const activeRoom = sortedRooms.find((room) => room.id === roomId) ?? sortedRooms[0] ?? null;

  const updateProject = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { pinned_at?: number | null } }) => api.updateProject(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
    onError: (err) => toast.error((err as Error).message),
  });
  const updateRoom = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; pinned_at?: number | null } }) => api.updateRoom(id, patch),
    onSuccess: (room) => {
      queryClient.invalidateQueries({ queryKey: ['rooms', room.project_id] });
      queryClient.invalidateQueries({ queryKey: ['room', room.id] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const createRoom = useMutation({
    mutationFn: () => api.createRoom(activeProjectId, { name: '新群聊' }),
    onSuccess: (room) => {
      queryClient.invalidateQueries({ queryKey: ['rooms', activeProjectId] });
      navigate(`/projects/${activeProjectId}/rooms/${room.id}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteRoom = useMutation({
    mutationFn: (room: Room) => api.deleteRoom(room.id).then(() => room),
    onSuccess: (deletedRoom) => {
      const remaining = sortPinnedItems(rooms.filter((room) => room.id !== deletedRoom.id));
      queryClient.invalidateQueries({ queryKey: ['rooms', activeProjectId] });
      const nextRoom = remaining[0];
      navigate(nextRoom ? `/projects/${activeProjectId}/rooms/${nextRoom.id}` : `/projects/${activeProjectId}`, { replace: true });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const deleteProject = useMutation({
    mutationFn: (project: Project) => api.deleteProject(project.id).then(() => project),
    onSuccess: (deletedProject) => {
      const remaining = sortPinnedItems(projects.filter((project) => project.id !== deletedProject.id));
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(remaining[0] ? `/projects/${remaining[0].id}` : '/', { replace: true });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const reorderProjects = useMutation({
    mutationFn: (input: { ids: string[]; pinned: boolean }) => api.reorderProjects(input),
    onMutate: async ({ ids, pinned }) => {
      await queryClient.cancelQueries({ queryKey: ['projects'] });
      const previousProjects = queryClient.getQueryData<Project[]>(['projects']);
      const nextOrder = new Map(ids.map((id, index) => [id, index + 1]));
      queryClient.setQueryData<Project[]>(['projects'], (current = []) =>
        sortPinnedItems(current.map((project) =>
          isPinnedItem(project) === pinned && nextOrder.has(project.id)
            ? { ...project, sort_order: nextOrder.get(project.id) ?? null }
            : project,
        )),
      );
      return { previousProjects };
    },
    onSuccess: (nextProjects) => queryClient.setQueryData(['projects'], nextProjects),
    onError: (err, _variables, context) => {
      if (context?.previousProjects) queryClient.setQueryData(['projects'], context.previousProjects);
      toast.error((err as Error).message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });
  const reorderRooms = useMutation({
    mutationFn: (input: { projectId: string; ids: string[]; pinned: boolean }) =>
      api.reorderRooms(input.projectId, { ids: input.ids, pinned: input.pinned }),
    onMutate: async ({ projectId: reorderProjectId, ids, pinned }) => {
      const queryKey = ['rooms', reorderProjectId];
      await queryClient.cancelQueries({ queryKey });
      const previousRooms = queryClient.getQueryData<Room[]>(queryKey);
      const nextOrder = new Map(ids.map((id, index) => [id, index + 1]));
      queryClient.setQueryData<Room[]>(queryKey, (current = []) =>
        sortPinnedItems(current.map((room) =>
          isPinnedItem(room) === pinned && nextOrder.has(room.id)
            ? { ...room, sort_order: nextOrder.get(room.id) ?? null }
            : room,
        )),
      );
      return { queryKey, previousRooms };
    },
    onSuccess: (nextRooms, variables) => queryClient.setQueryData(['rooms', variables.projectId], nextRooms),
    onError: (err, _variables, context) => {
      if (context?.previousRooms) queryClient.setQueryData(context.queryKey, context.previousRooms);
      toast.error((err as Error).message);
    },
    onSettled: (_data, _error, variables) => {
      if (variables) queryClient.invalidateQueries({ queryKey: ['rooms', variables.projectId] });
    },
  });

  useEffect(() => {
    if (sortedProjects.length === 0) return;
    if (!projectId || !sortedProjects.some((project) => project.id === projectId)) {
      navigate(`/projects/${sortedProjects[0].id}`, { replace: true });
    }
  }, [navigate, projectId, sortedProjects]);

  useEffect(() => {
    if (!activeProjectId || rooms.length === 0) return;
    if (!roomId || !rooms.some((room) => room.id === roomId)) {
      navigate(`/projects/${activeProjectId}/rooms/${sortedRooms[0].id}`, { replace: true });
    }
  }, [activeProjectId, navigate, roomId, rooms, sortedRooms]);

  if (projects.length === 0) {
    return (
      <div className="development-workspace-empty">
        <WorkspaceEmptyState
          title="还没有项目"
          description="创建第一个项目后，开发工作台会在这里显示项目群聊。"
          action={<Button onClick={() => setCreateProjectOpen(true)}>新增项目</Button>}
        />
        <CreateProjectDialog open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
      </div>
    );
  }

  return (
    <div className="development-workspace">
      <ProjectRail
        projects={projects}
        activeProjectId={activeProjectId}
        busyProjectId={
          updateProject.isPending
            ? updateProject.variables?.id ?? null
            : deleteProject.isPending
              ? deleteProject.variables?.id ?? null
              : null
        }
        onSelectProject={(project) => navigate(`/projects/${project.id}`)}
        onCreateProject={() => setCreateProjectOpen(true)}
        onTogglePin={(project) => {
          const pinned = project.pinned_at !== undefined && project.pinned_at !== null;
          updateProject.mutate({ id: project.id, patch: { pinned_at: pinned ? null : Date.now() } });
        }}
        onDeleteProject={(project) => {
          if (window.confirm(`删除项目「${project.name}」？此操作不可撤销。`)) deleteProject.mutate(project);
        }}
        onReorderProjects={(ids, pinned) => reorderProjects.mutate({ ids, pinned })}
      />
      <section className="development-workspace-main">
        {activeProject && rooms.length === 0 ? (
          <WorkspaceEmptyState
            icon={<MessageSquarePlus className="h-9 w-9" strokeWidth={1.75} />}
            title="这个项目还没有群聊"
            description="创建群聊后可以开始任务协作。"
            action={
              <CreateRoomDialog
                projectId={activeProject.id}
                buttonText="新增群聊"
                onCreated={(createdRoomId) => navigate(`/projects/${activeProject.id}/rooms/${createdRoomId}`)}
              />
            }
          />
        ) : activeProject && activeRoom ? (
          <>
            <RoomTabsBar
              projectId={activeProject.id}
              roomId={activeRoom.id}
              rooms={rooms}
              busyRoomId={
                updateRoom.isPending
                  ? updateRoom.variables?.id ?? null
                  : deleteRoom.isPending
                    ? deleteRoom.variables?.id ?? null
                    : null
              }
              creating={createRoom.isPending}
              onCreateRoom={() => createRoom.mutate()}
              onRenameRoom={(room, name) => updateRoom.mutateAsync({ id: room.id, patch: { name } }).then(() => undefined)}
              onTogglePin={(room) => {
                const pinned = room.pinned_at !== undefined && room.pinned_at !== null;
                updateRoom.mutate({ id: room.id, patch: { pinned_at: pinned ? null : Date.now() } });
              }}
              onDeleteRoom={(room) => {
                if (window.confirm(`删除群聊「${room.name}」？此操作不可撤销。`)) deleteRoom.mutate(room);
              }}
              onReorderRooms={(ids, pinned) => reorderRooms.mutate({ projectId: activeProject.id, ids, pinned })}
            />
            <RoomWorkbench projectId={activeProject.id} roomId={activeRoom.id} />
          </>
        ) : null}
      </section>
      <CreateProjectDialog open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
    </div>
  );
}
