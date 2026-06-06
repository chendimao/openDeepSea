import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildTriggerPopoverRows } from './trigger-popover-groups'
import type { TriggerSuggestion } from './types'

test('buildTriggerPopoverRows inserts group headers when group changes', () => {
  const suggestions: TriggerSuggestion[] = [
    { value: 'workspace:a.ts', label: 'a.ts', groupLabel: 'Source' },
    { value: 'workspace:b.ts', label: 'b.ts', groupLabel: 'Source' },
    { value: 'library:file-1', label: 'notes.md', groupLabel: 'Library' },
  ]

  const rows = buildTriggerPopoverRows(suggestions)

  assert.deepEqual(
    rows.map((row) => (row.type === 'group' ? `group:${row.label}` : `item:${row.suggestion.value}`)),
    [
      'group:Source',
      'item:workspace:a.ts',
      'item:workspace:b.ts',
      'group:Library',
      'item:library:file-1',
    ],
  )
})

test('buildTriggerPopoverRows keeps ungrouped suggestions selectable', () => {
  const rows = buildTriggerPopoverRows([{ value: 'plain', label: 'Plain' }])
  assert.deepEqual(rows, [{ type: 'item', suggestion: { value: 'plain', label: 'Plain' }, suggestionIndex: 0 }])
})

test('TriggerPopover marks group headers as presentational inside the listbox', () => {
  const source = readFileSync(new URL('./trigger-popover.tsx', import.meta.url), 'utf8')

  assert.match(
    source,
    /key=\{`group:\$\{row\.label\}:\$\{rowIndex\}`\}\s+role="presentation"/,
  )
})
