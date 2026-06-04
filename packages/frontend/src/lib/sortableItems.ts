export type SortablePinnedItem = {
  id: string;
  created_at: number;
  pinned_at?: number | null;
  sort_order?: number | null;
};

export function isPinnedItem(item: SortablePinnedItem): boolean {
  return item.pinned_at !== undefined && item.pinned_at !== null;
}

export function sortPinnedItems<T extends SortablePinnedItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aPinned = isPinnedItem(a);
    const bPinned = isPinnedItem(b);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    const aOrder = a.sort_order ?? null;
    const bOrder = b.sort_order ?? null;
    if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrder !== null) return -1;
    if (bOrder !== null) return 1;
    return b.created_at - a.created_at;
  });
}

export function reorderWithinLayer<T extends SortablePinnedItem>(
  items: T[],
  activeId: string,
  overId: string,
): T[] {
  const sorted = sortPinnedItems(items);
  const active = sorted.find((item) => item.id === activeId);
  const over = sorted.find((item) => item.id === overId);
  if (!active || !over) return sorted;
  if (isPinnedItem(active) !== isPinnedItem(over)) return sorted;

  const pinned = isPinnedItem(active);
  const layer = sorted.filter((item) => isPinnedItem(item) === pinned);
  const otherLayer = sorted.filter((item) => isPinnedItem(item) !== pinned);
  const from = layer.findIndex((item) => item.id === activeId);
  const to = layer.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0 || from === to) return sorted;

  const nextLayer = [...layer];
  const [moved] = nextLayer.splice(from, 1);
  nextLayer.splice(to, 0, moved);
  return pinned ? [...nextLayer, ...otherLayer] : [...otherLayer, ...nextLayer];
}

export function layerIds<T extends SortablePinnedItem>(items: T[], pinned: boolean): string[] {
  return items.filter((item) => isPinnedItem(item) === pinned).map((item) => item.id);
}
