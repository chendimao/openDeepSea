import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Room } from '../lib/types';
import { isPinnedItem, layerIds, reorderWithinLayer, sortPinnedItems } from '../lib/sortableItems';
import { cn, truncate } from '../lib/utils';
import { Button } from './ui/Button';
import { Dialog, DialogContent } from './ui/Dialog';
import { Input } from './ui/Input';

type RoomTabMeta = {
  pinned_at?: number | null;
};

type TabRoom = Room & RoomTabMeta;

type RoomTabsBarProps = {
  projectId: string;
  roomId: string;
  rooms: Room[];
  busyRoomId?: string | null;
  creating?: boolean;
  onCreateRoom: () => void;
  onRenameRoom: (room: Room, name: string) => Promise<void>;
  onTogglePin: (room: Room) => void;
  onDeleteRoom: (room: Room) => void;
  onReorderRooms: (ids: string[], pinned: boolean) => void;
};

export function sortRoomsForTabs(rooms: Room[]): Room[] {
  return sortPinnedItems(rooms);
}

export function RoomTabsBar({
  projectId,
  roomId,
  rooms,
  busyRoomId,
  creating,
  onCreateRoom,
  onRenameRoom,
  onTogglePin,
  onDeleteRoom,
  onReorderRooms,
}: RoomTabsBarProps) {
  const sortedRooms = useMemo(() => sortRoomsForTabs(rooms), [rooms]);
  const [renamingRoom, setRenamingRoom] = useState<Room | null>(null);
  const [contextRoom, setContextRoom] = useState<{ room: Room; x: number; y: number } | null>(null);
  const [draggingRoomId, setDraggingRoomId] = useState<string | null>(null);
  const [dropRoomId, setDropRoomId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    setName(renamingRoom?.name ?? '');
    setRenameError(null);
    setRenaming(false);
  }, [renamingRoom]);

  useEffect(() => {
    if (!contextRoom) return;
    const close = () => setContextRoom(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextRoom]);

  const submitRename = async () => {
    if (!renamingRoom || renaming) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setRenameError('群聊名称不能为空');
      return;
    }

    try {
      setRenaming(true);
      setRenameError(null);
      await onRenameRoom(renamingRoom, trimmed);
      setRenamingRoom(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : '重命名失败，请稍后再试';
      setRenameError(message);
    } finally {
      setRenaming(false);
    }
  };

  const resetDragState = () => {
    setDraggingRoomId(null);
    setDropRoomId(null);
  };

  const canDropOnRoom = (target: Room) => {
    if (!draggingRoomId || draggingRoomId === target.id) return false;
    const draggingRoom = sortedRooms.find((room) => room.id === draggingRoomId);
    return Boolean(draggingRoom && isPinnedItem(draggingRoom) === isPinnedItem(target));
  };

  const handleDrop = (target: Room) => {
    if (!canDropOnRoom(target)) {
      resetDragState();
      return;
    }

    const activeId = draggingRoomId;
    if (!activeId) {
      resetDragState();
      return;
    }

    const next = reorderWithinLayer(sortedRooms, activeId, target.id);
    const moved = next.find((room) => room.id === activeId);
    if (moved) {
      const pinned = isPinnedItem(moved);
      onReorderRooms(layerIds(next, pinned), pinned);
    }
    resetDragState();
  };

  return (
    <div className="room-tabs-bar" aria-label="群聊切换">
      <div className="room-tabs-scroll">
        {sortedRooms.map((room) => {
          const roomMeta = room as TabRoom;
          const busy = busyRoomId === room.id;
          return (
            <div
              key={room.id}
              className={cn(
                'room-tab-wrapper',
                draggingRoomId === room.id && 'is-dragging',
                dropRoomId === room.id && 'is-drop-target',
              )}
              draggable={!busy}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', room.id);
                setDraggingRoomId(room.id);
              }}
              onDragOver={(event) => {
                if (!canDropOnRoom(room)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropRoomId(room.id);
              }}
              onDragLeave={() => {
                if (dropRoomId === room.id) setDropRoomId(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(room);
              }}
              onDragEnd={resetDragState}
              onContextMenu={(event) => {
                event.preventDefault();
                if (busy) return;
                setContextRoom({ room, x: event.clientX, y: event.clientY });
              }}
            >
              <Link
                to={`/projects/${projectId}/rooms/${room.id}`}
                className={cn('room-tab-link', room.id === roomId && 'is-active')}
                aria-current={room.id === roomId ? 'page' : undefined}
                title={room.name}
              >
                {isPinnedItem(roomMeta) ? <Pin className="h-3.5 w-3.5" strokeWidth={1.8} /> : null}
                <span>{truncate(room.name, 26)}</span>
              </Link>
              <RoomTabMenu
                room={room}
                busy={busy}
                onRename={() => setRenamingRoom(room)}
                onTogglePin={() => onTogglePin(room)}
                onDelete={() => onDeleteRoom(room)}
              />
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="room-tab-add"
        onClick={onCreateRoom}
        disabled={creating}
        aria-label="新增群聊"
      >
        <Plus className="h-4 w-4" strokeWidth={1.9} />
      </button>

      {contextRoom ? (
        <RoomTabContextMenu
          room={contextRoom.room}
          x={contextRoom.x}
          y={contextRoom.y}
          onClose={() => setContextRoom(null)}
          onRename={() => setRenamingRoom(contextRoom.room)}
          onTogglePin={() => onTogglePin(contextRoom.room)}
          onDelete={() => onDeleteRoom(contextRoom.room)}
        />
      ) : null}

      <Dialog
        open={Boolean(renamingRoom)}
        onOpenChange={(open) => {
          if (!open) setRenamingRoom(null);
        }}
      >
        <DialogContent title="重命名群聊" description={renamingRoom?.name ?? ''}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              aria-label="群聊名称"
              disabled={renaming}
            />
            {renameError ? <p className="text-[12px] text-red-500">{renameError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setRenamingRoom(null)} disabled={renaming}>
                取消
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming ? '保存中…' : '确认'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoomTabContextMenu({
  room,
  x,
  y,
  onClose,
  onRename,
  onTogglePin,
  onDelete,
}: {
  room: Room;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const roomMeta = room as TabRoom;
  const run = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      className="room-tab-menu room-tab-menu-floating"
      style={{ left: x, top: y }}
      role="menu"
      aria-label={`${room.name} 操作`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" className="room-tab-menu-item" role="menuitem" onClick={() => run(onRename)}>
        <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span>重命名</span>
      </button>
      <button type="button" className="room-tab-menu-item" role="menuitem" onClick={() => run(onTogglePin)}>
        {isPinnedItem(roomMeta) ? (
          <PinOff className="h-3.5 w-3.5" strokeWidth={1.8} />
        ) : (
          <Pin className="h-3.5 w-3.5" strokeWidth={1.8} />
        )}
        <span>{isPinnedItem(roomMeta) ? '取消置顶' : '置顶'}</span>
      </button>
      <button type="button" className="room-tab-menu-item is-danger" role="menuitem" onClick={() => run(onDelete)}>
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span>删除</span>
      </button>
    </div>
  );
}

function RoomTabMenu({
  room,
  busy,
  onRename,
  onTogglePin,
  onDelete,
}: {
  room: Room;
  busy: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const roomMeta = room as TabRoom;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="room-tab-menu-trigger" disabled={busy} aria-label={`${room.name} 操作`}>
          <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="room-tab-menu" align="start" sideOffset={8}>
          <DropdownMenu.Item
            className="room-tab-menu-item"
            onSelect={() => {
              onRename();
            }}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>重命名</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="room-tab-menu-item"
            onSelect={() => {
              onTogglePin();
            }}
          >
            {isPinnedItem(roomMeta) ? (
              <PinOff className="h-3.5 w-3.5" strokeWidth={1.8} />
            ) : (
              <Pin className="h-3.5 w-3.5" strokeWidth={1.8} />
            )}
            <span>{isPinnedItem(roomMeta) ? '取消置顶' : '置顶'}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="room-tab-menu-item is-danger"
            onSelect={() => {
              onDelete();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>删除</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
