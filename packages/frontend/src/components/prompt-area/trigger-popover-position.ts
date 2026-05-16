export type TriggerPopoverPlacement = 'above' | 'below';

interface ComputeTriggerPopoverPositionInput {
  triggerRect: DOMRect;
  viewportWidth: number;
  viewportHeight: number;
  estimatedHeight: number;
  measuredHeight?: number;
  maxWidth?: number;
  margin?: number;
  offset?: number;
}

interface TriggerPopoverPosition {
  left: number;
  top: number;
  maxWidth: number;
  placement: TriggerPopoverPlacement;
}

export function computeTriggerPopoverPosition({
  triggerRect,
  viewportWidth,
  viewportHeight,
  estimatedHeight,
  measuredHeight,
  maxWidth = 320,
  margin = 8,
  offset = 4,
}: ComputeTriggerPopoverPositionInput): TriggerPopoverPosition {
  const popoverMaxWidth = Math.min(maxWidth, viewportWidth - margin * 2);
  const left = clamp(triggerRect.left, margin, viewportWidth - popoverMaxWidth - margin);
  const popoverHeight = measuredHeight ?? estimatedHeight;
  const belowTop = triggerRect.bottom + offset;
  const aboveTop = triggerRect.top - popoverHeight - offset;
  const hasRoomBelow = belowTop + popoverHeight <= viewportHeight - margin;
  const top = hasRoomBelow ? belowTop : Math.max(margin, aboveTop);

  return {
    left,
    top,
    maxWidth: popoverMaxWidth,
    placement: hasRoomBelow ? 'below' : 'above',
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
