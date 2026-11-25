import type { ReviewCandidate } from '@maintainerr/contracts'

export interface ReviewEntry {
  key: string
  /** Set when two or more listed titles belong to one movie series. */
  series: string | null
  items: ReviewCandidate[]
}

/**
 * Puts the listed members of a movie series together, at the place of the
 * series' biggest member, and keeps every other title where the list put it
 * (biggest first). Each title is still selected on its own.
 */
export function groupReviewCandidates(
  candidates: ReviewCandidate[],
): ReviewEntry[] {
  const members = new Map<string, ReviewCandidate[]>()
  for (const item of candidates) {
    if (!item.group) continue
    const list = members.get(item.group.id)
    if (list) list.push(item)
    else members.set(item.group.id, [item])
  }
  const entries: ReviewEntry[] = []
  const placed = new Set<string>()
  for (const item of candidates) {
    const series = item.group ? members.get(item.group.id) : undefined
    if (series && series.length > 1) {
      if (placed.has(item.group!.id)) continue
      placed.add(item.group!.id)
      entries.push({
        key: `group:${item.group!.id}`,
        series: item.group!.title || series.map((s) => s.title).join(', '),
        items: series,
      })
    } else {
      entries.push({ key: item.id, series: null, items: [item] })
    }
  }
  return entries
}
