'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import type { TriggerSuggestion } from './types'
import { computeTriggerPopoverPosition } from './trigger-popover-position'
import { buildTriggerPopoverRows } from './trigger-popover-groups'

type TriggerPopoverProps = {
  suggestions: TriggerSuggestion[]
  loading: boolean
  error?: string | null
  emptyMessage?: string
  selectedIndex: number
  onSelect: (suggestion: TriggerSuggestion) => void
  onDismiss: () => void
  triggerRect: DOMRect | null
  triggerChar: string
}

/**
 * Floating popover that displays trigger suggestions.
 * Positioned relative to the trigger character location in the editor.
 */
export function TriggerPopover({
  suggestions,
  loading,
  error,
  emptyMessage,
  selectedIndex,
  onSelect,
  onDismiss,
  triggerRect,
  triggerChar,
}: TriggerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const [measuredHeight, setMeasuredHeight] = useState<number | undefined>(undefined)

  useLayoutEffect(() => {
    setMeasuredHeight(undefined)
  }, [triggerRect, suggestions.length, loading, error, emptyMessage])

  useLayoutEffect(() => {
    const popover = popoverRef.current
    if (!popover) return
    const nextHeight = popover.offsetHeight
    if (nextHeight > 0 && Math.abs(nextHeight - (measuredHeight ?? 0)) > 1) {
      setMeasuredHeight(nextHeight)
    }
  }, [measuredHeight, suggestions.length, loading, error, emptyMessage])

  // Scroll selected item into view
  useEffect(() => {
    const selected = selectedRef.current
    const popover = popoverRef.current
    if (!selected || !popover) return

    const selectedTop = selected.offsetTop
    const selectedBottom = selectedTop + selected.offsetHeight
    if (selectedTop < popover.scrollTop) {
      popover.scrollTop = selectedTop
    } else if (selectedBottom > popover.scrollTop + popover.clientHeight) {
      popover.scrollTop = selectedBottom - popover.clientHeight
    }
  }, [selectedIndex])

  // Click outside to dismiss
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target
      if (popoverRef.current && target instanceof Node && !popoverRef.current.contains(target)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  if (!triggerRect) return null
  if (suggestions.length === 0 && !loading && !error && !emptyMessage) return null
  const rows = buildTriggerPopoverRows(suggestions)

  // Position the popover below the trigger character, clamped to viewport
  const position = computeTriggerPopoverPosition({
    triggerRect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    estimatedHeight: 240,
    measuredHeight,
  })
  const style: React.CSSProperties = {
    position: 'fixed',
    left: `${position.left}px`,
    top: `${position.top}px`,
    zIndex: 50,
    maxWidth: `${position.maxWidth}px`,
  }

  return createPortal(
    <div
      ref={popoverRef}
      className={cn(
        'max-h-[240px] min-w-[200px] overflow-y-auto',
        'rounded-lg border border-white/60 bg-[var(--color-surface)] p-2 shadow-[var(--shadow-mention)]',
        'text-[var(--color-fg)]',
      )}
      style={style}
      role="listbox"
      aria-label={`${triggerChar} suggestions`}>
      {loading ? (
        <div
          role="option"
          aria-selected={false}
          className="text-muted-foreground px-3 py-2 text-sm">
          Loading suggestions...
        </div>
      ) : error ? (
        <div role="option" aria-selected={false} className="text-destructive px-3 py-2 text-sm">
          {error}
        </div>
      ) : suggestions.length === 0 && emptyMessage ? (
        <div
          role="option"
          aria-selected={false}
          className="text-muted-foreground px-3 py-2 text-sm">
          {emptyMessage}
        </div>
      ) : (
        rows.map((row, rowIndex) => {
          if (row.type === 'group') {
            return (
              <div
                key={`group:${row.label}:${rowIndex}`}
                className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-muted)] opacity-70">
                {row.label}
              </div>
            )
          }
          const { suggestion, suggestionIndex } = row
          return (
            <button
              key={suggestion.value}
              ref={suggestionIndex === selectedIndex ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={suggestionIndex === selectedIndex}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px]',
                'text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-primary)]',
                suggestionIndex === selectedIndex && 'bg-[var(--color-surface-raised)] text-[var(--color-primary)]',
              )}
              onMouseDown={(e) => {
                e.preventDefault() // Prevent blur on the editor
                onSelect(suggestion)
              }}>
              {suggestion.icon && <span className="shrink-0">{suggestion.icon}</span>}
              <span className="min-w-0 flex-1 truncate font-medium">{suggestion.label}</span>
              {suggestion.description && (
                <span className="shrink-0 truncate text-[11px] text-[var(--color-fg-muted)] opacity-70 max-w-[45%] text-right">
                  {suggestion.description}
                </span>
              )}
            </button>
          )
        })
      )}
    </div>,
    document.body,
  )
}
