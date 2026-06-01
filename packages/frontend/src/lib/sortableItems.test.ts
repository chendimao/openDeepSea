import assert from 'node:assert/strict';
import test from 'node:test';
import { isPinnedItem, layerIds, reorderWithinLayer, sortPinnedItems } from './sortableItems';

type Item = {
  id: string;
  created_at: number;
  pinned_at?: number | null;
  sort_order?: number | null;
};

test('sortPinnedItems puts pinned first and sorts each layer by sort_order then created_at desc', () => {
  const items: Item[] = [
    { id: 'normal-old', created_at: 1, sort_order: null },
    { id: 'normal-new', created_at: 4, sort_order: null },
    { id: 'pinned-second', created_at: 3, pinned_at: 10, sort_order: 2 },
    { id: 'pinned-first', created_at: 2, pinned_at: 20, sort_order: 1 },
  ];

  assert.deepEqual(sortPinnedItems(items).map((item) => item.id), [
    'pinned-first',
    'pinned-second',
    'normal-new',
    'normal-old',
  ]);
});

test('isPinnedItem treats zero pinned_at as pinned to match backend null semantics', () => {
  assert.equal(isPinnedItem({ id: 'zero', created_at: 1, pinned_at: 0 }), true);
  assert.equal(isPinnedItem({ id: 'null', created_at: 1, pinned_at: null }), false);
  assert.equal(isPinnedItem({ id: 'missing', created_at: 1 }), false);
});

test('reorderWithinLayer reorders only matching pinned layer', () => {
  const items: Item[] = [
    { id: 'pinned', created_at: 1, pinned_at: 1 },
    { id: 'a', created_at: 2 },
    { id: 'b', created_at: 3 },
  ];

  assert.deepEqual(reorderWithinLayer(items, 'a', 'b').map((item) => item.id), ['pinned', 'b', 'a']);
  assert.deepEqual(reorderWithinLayer(items, 'pinned', 'a').map((item) => item.id), ['pinned', 'b', 'a']);
});

test('layerIds returns sorted ids for a single pinned layer', () => {
  const items: Item[] = [
    { id: 'normal-b', created_at: 2, sort_order: 2 },
    { id: 'pinned-a', created_at: 1, pinned_at: 1 },
    { id: 'normal-a', created_at: 3, sort_order: 1 },
  ];

  assert.deepEqual(layerIds(items, false), ['normal-a', 'normal-b']);
  assert.deepEqual(layerIds(items, true), ['pinned-a']);
});
