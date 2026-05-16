import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTriggerPopoverPosition } from './trigger-popover-position';

function rect(input: { left: number; top: number; right: number; bottom: number }): DOMRect {
  return {
    ...input,
    x: input.left,
    y: input.top,
    width: input.right - input.left,
    height: input.bottom - input.top,
    toJSON: () => input,
  } as DOMRect;
}

test('computeTriggerPopoverPosition keeps the popover near the trigger horizontally', () => {
  const result = computeTriggerPopoverPosition({
    triggerRect: rect({ left: 24, top: 700, right: 32, bottom: 720 }),
    viewportWidth: 1200,
    viewportHeight: 900,
    estimatedHeight: 128,
  });

  assert.equal(result.left, 24);
  assert.equal(result.placement, 'below');
});

test('computeTriggerPopoverPosition flips above when there is not enough space below', () => {
  const result = computeTriggerPopoverPosition({
    triggerRect: rect({ left: 24, top: 820, right: 32, bottom: 840 }),
    viewportWidth: 1200,
    viewportHeight: 900,
    estimatedHeight: 128,
  });

  assert.equal(result.top, 688);
  assert.equal(result.placement, 'above');
});

test('computeTriggerPopoverPosition uses measured height when flipping above', () => {
  const result = computeTriggerPopoverPosition({
    triggerRect: rect({ left: 24, top: 820, right: 32, bottom: 840 }),
    viewportWidth: 1200,
    viewportHeight: 900,
    estimatedHeight: 128,
    measuredHeight: 72,
  });

  assert.equal(result.top, 744);
  assert.equal(result.placement, 'above');
});
