import type { TriggerSuggestion } from './types'

export type TriggerPopoverRow =
  | { type: 'group'; label: string }
  | { type: 'item'; suggestion: TriggerSuggestion; suggestionIndex: number }

export function buildTriggerPopoverRows(suggestions: TriggerSuggestion[]): TriggerPopoverRow[] {
  const rows: TriggerPopoverRow[] = []
  let previousGroup: string | undefined

  suggestions.forEach((suggestion, suggestionIndex) => {
    const group = suggestion.groupLabel?.trim()
    if (group && group !== previousGroup) {
      rows.push({ type: 'group', label: group })
      previousGroup = group
    } else if (!group) {
      previousGroup = undefined
    }
    rows.push({ type: 'item', suggestion, suggestionIndex })
  })

  return rows
}
